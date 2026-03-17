// ========================================
// SYNC — Sincronización en tiempo real (Supabase)
// ========================================
// Usa Supabase (PostgreSQL + WebSockets) para sincronización
// INSTANTÁNEA entre múltiples computadoras.
//
// Los cambios se ven en 1-2 segundos en todas las computadoras.
// No usa polling — usa WebSockets (conexión permanente).
//
// CONFIGURACIÓN: Ve SETUP.md para los pasos completos.
// ========================================

// ┌─────────────────────────────────────────────────┐
// │  CONFIGURACIÓN — Pega aquí tus 2 valores        │
// │  (Los encuentras en Supabase → Settings → API)  │
// └─────────────────────────────────────────────────┘
var SUPABASE_URL  = 'https://crrerbpedzoqtrqlhbdn.supabase.co';
var SUPABASE_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNycmVyYnBlZHpvcXRycWxoYmRuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM3NTg0MzUsImV4cCI6MjA4OTMzNDQzNX0.YS9jHwXRU75nCpEZvjGdaiT-K8yTnnyQBtoSFqjytVM';

// ── Estado interno ──
var SYNC = {
  initialized:  false,
  connected:    false,
  onlineCount:  0,
  onlineUsers:  [],
  sessionId:    Date.now().toString(36) + Math.random().toString(36).substr(2, 6),
  _version:     0,
  _isSaving:    false,
  _saveTimer:   null,
  _client:      null,     // Supabase client
  _channel:     null,     // Realtime channel
  _presence:    null,     // Presence channel
  _lastSaveAt:  0
};

var SAVE_DEBOUNCE = 1500;

// ========================================
// INICIALIZACIÓN
// ========================================

async function initSync() {
  // Verificar configuración
  if (!SUPABASE_URL || SUPABASE_URL.includes('TU_PROYECTO')) {
    console.warn('[SYNC] ⚠️ Configura SUPABASE_URL en js/sync.js — Modo local');
    return false;
  }
  if (!SUPABASE_KEY || SUPABASE_KEY.includes('TU_ANON_KEY')) {
    console.warn('[SYNC] ⚠️ Configura SUPABASE_KEY en js/sync.js — Modo local');
    return false;
  }

  // Verificar que el SDK está cargado
  if (typeof supabase === 'undefined' || !supabase.createClient) {
    console.warn('[SYNC] ⚠️ Supabase SDK no cargado');
    return false;
  }

  try {
    console.log('[SYNC] Conectando a Supabase...');
    SYNC._client = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

    // Verificar conexión con una lectura de prueba
    var { data, error } = await SYNC._client
      .from('app_state')
      .select('version')
      .eq('id', 1)
      .single();

    if (error) {
      console.error('[SYNC] ❌ Error conectando:', error.message);
      console.error('[SYNC] ¿Ya creaste la tabla? Ve SETUP.md paso 3');
      return false;
    }

    SYNC._version    = data.version || 0;
    SYNC.initialized = true;
    SYNC.connected   = true;

    console.log('[SYNC] ✅ Conectado a Supabase (versión: ' + SYNC._version + ')');
    updateSyncIndicator();
    return true;

  } catch (e) {
    console.error('[SYNC] ❌ Error de conexión:', e);
    return false;
  }
}

// ========================================
// GUARDAR — Subir cambios a la nube
// ========================================

function syncSaveState() {
  localSaveState();
  if (!SYNC.initialized || !SYNC._client) return;

  clearTimeout(SYNC._saveTimer);
  SYNC._saveTimer = setTimeout(_doSave, SAVE_DEBOUNCE);
}

async function _doSave() {
  SYNC._isSaving = true;
  _showSyncAnimation(true);

  var newVersion = Date.now();
  var stateData = {
    records:   STATE.records || [],
    obsoletos: STATE.obsoletos || [],
    papelera:  STATE.papelera || [],
    salidas:   STATE.salidas || [],
    logs:      (STATE.logs || []).slice(0, 1500),
    elaboros:  STATE.elaboros || [],
    nextId:    STATE.nextId || 1000
  };

  var usersData = (AUTH.users || []).map(function(u) {
    return { username: u.username, _h: u._h, role: u.role, fullName: u.fullName };
  });

  var modifiedBy = AUTH.currentUser ? AUTH.currentUser.username : 'Sistema';

  var { error } = await SYNC._client
    .from('app_state')
    .update({
      state:       stateData,
      users:       usersData,
      version:     newVersion,
      modified_by: modifiedBy,
      updated_at:  new Date().toISOString()
    })
    .eq('id', 1);

  if (error) {
    console.warn('[SYNC] ❌ Error al guardar:', error.message);
    SYNC.connected = false;
  } else {
    SYNC._version    = newVersion;
    SYNC._lastSaveAt = Date.now();
    SYNC.connected   = true;
    console.log('[SYNC] ⬆️ Subido v' + newVersion + ' por ' + modifiedBy + ' (' + (STATE.records||[]).length + ' registros)');
  }

  updateSyncIndicator();
  _showSyncAnimation(false);
  SYNC._isSaving = false;
}

// Forzar sincronización manual (botón)
async function forceSync() {
  if (!SYNC.initialized) {
    showToast('Sincronización no disponible (modo local)', 'error');
    return;
  }
  _showSyncAnimation(true);
  console.log('[SYNC] 🔄 Sincronización manual...');

  // Subir mis cambios
  await _doSave();
  // Bajar últimos cambios
  await _pullRemote();

  _showSyncAnimation(false);
  showToast('✅ Sincronizado', 'success');
}

// ========================================
// ESCUCHAR CAMBIOS EN TIEMPO REAL (WebSocket)
// ========================================

function listenStateChanges() {
  if (!SYNC.initialized || !SYNC._client) return;

  // Suscribirse a cambios en la tabla app_state via WebSocket
  SYNC._channel = SYNC._client
    .channel('db-changes')
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'app_state' },
      function(payload) {
        _handleRealtimeUpdate(payload.new);
      }
    )
    .subscribe(function(status) {
      if (status === 'SUBSCRIBED') {
        console.log('[SYNC] 🔌 WebSocket conectado — cambios en tiempo real activos');
        SYNC.connected = true;
        updateSyncIndicator();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn('[SYNC] ⚠️ WebSocket desconectado, reintentando...');
        SYNC.connected = false;
        updateSyncIndicator();
      }
    });
}

function _handleRealtimeUpdate(row) {
  if (!row) return;

  var remoteVersion = row.version || 0;

  // Ignorar nuestras propias escrituras
  if (Date.now() - SYNC._lastSaveAt < 3000) return;
  // Ignorar si no es más nuevo
  if (remoteVersion <= SYNC._version) return;

  var by = row.modified_by || '?';
  console.log('[SYNC] 📥 Cambio en tiempo real de ' + by + ' (v' + SYNC._version + ' → v' + remoteVersion + ')');

  // Aplicar estado remoto
  if (row.state) {
    STATE.records   = row.state.records   || [];
    STATE.obsoletos = row.state.obsoletos || [];
    STATE.papelera  = row.state.papelera  || [];
    STATE.salidas   = row.state.salidas   || [];
    STATE.logs      = row.state.logs      || [];
    STATE.elaboros  = row.state.elaboros  || [];
    STATE.nextId    = row.state.nextId    || 1000;
  }

  SYNC._version = remoteVersion;
  localSaveState();

  // Actualizar usuarios
  if (row.users && Array.isArray(row.users) && row.users.length > 0) {
    AUTH.users = row.users;
    _localSaveUsers(row.users);
  }

  // Re-renderizar pantalla
  if (AUTH.currentUser) {
    render();
    if (by && by !== AUTH.currentUser.username) {
      showToast('📥 ' + by + ' actualizó los datos', 'info');
    }
  }
}

// Descargar manualmente los últimos datos
async function _pullRemote() {
  if (!SYNC._client) return;

  try {
    var { data, error } = await SYNC._client
      .from('app_state')
      .select('*')
      .eq('id', 1)
      .single();

    if (error || !data) return;

    if (data.version > SYNC._version && data.state) {
      _handleRealtimeUpdate(data);
    }
  } catch (e) {
    console.warn('[SYNC] Error descargando:', e);
  }
}

// ========================================
// PRESENCIA — Usuarios en línea (WebSocket)
// ========================================

function registerPresence() {
  if (!SYNC.initialized || !SYNC._client || !AUTH.currentUser) return;

  SYNC._presence = SYNC._client.channel('online-users', {
    config: { presence: { key: SYNC.sessionId } }
  });

  SYNC._presence.on('presence', { event: 'sync' }, function() {
    var state = SYNC._presence.presenceState();
    var users = [];
    for (var key in state) {
      var entries = state[key];
      if (entries && entries.length > 0) {
        users.push(entries[0].username);
      }
    }
    SYNC.onlineUsers = users.filter(function(v, i, a) { return a.indexOf(v) === i; });
    SYNC.onlineCount = SYNC.onlineUsers.length;
    updateOnlineCountUI();
  });

  SYNC._presence.subscribe(async function(status) {
    if (status === 'SUBSCRIBED') {
      await SYNC._presence.track({
        username:  AUTH.currentUser.username,
        fullName:  AUTH.currentUser.fullName || AUTH.currentUser.username,
        online_at: new Date().toISOString()
      });
      console.log('[SYNC] 👤 Presencia registrada: ' + AUTH.currentUser.username);
    }
  });
}

function unregisterPresence() {
  if (SYNC._presence) {
    SYNC._presence.untrack();
    SYNC._client.removeChannel(SYNC._presence);
    SYNC._presence = null;
  }
}

function updateOnlineCountUI() {
  var el1 = document.querySelector('.online-count');
  if (el1) el1.textContent = String(SYNC.onlineCount);
  var el2 = document.getElementById('sidebar-online-count');
  if (el2) el2.textContent = String(SYNC.onlineCount);
}

// ========================================
// INDICADOR VISUAL (sidebar)
// ========================================

function updateSyncIndicator() {
  var el = document.getElementById('sync-indicator');
  if (!el) return;
  if (!SYNC.initialized) {
    el.className = 'sync-indicator sync-offline';
    el.innerHTML = '<i class="fas fa-database"></i> Local';
  } else if (SYNC.connected) {
    el.className = 'sync-indicator sync-online';
    el.innerHTML = '<i class="fas fa-cloud"></i> En línea';
  } else {
    el.className = 'sync-indicator sync-reconnecting';
    el.innerHTML = '<i class="fas fa-cloud-arrow-up"></i> Reconectando...';
  }
}

function _showSyncAnimation(active) {
  var btn = document.getElementById('btn-sync');
  if (!btn) return;
  if (active) {
    btn.classList.add('syncing');
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sincronizando...';
  } else {
    btn.classList.remove('syncing');
    btn.innerHTML = '<i class="fas fa-arrows-rotate"></i> Sincronizar';
  }
}

// ========================================
// CARGA DESDE LA NUBE
// ========================================

async function syncLoadState() {
  if (!SYNC.initialized || !SYNC._client) return localLoadState();

  try {
    var { data, error } = await SYNC._client
      .from('app_state')
      .select('*')
      .eq('id', 1)
      .single();

    if (error || !data || !data.state) {
      console.warn('[SYNC] No hay datos en la nube aún, usando caché local');
      return localLoadState();
    }

    if (data.state.records && data.state.records.length > 0) {
      STATE.records   = data.state.records;
      STATE.obsoletos = data.state.obsoletos || [];
      STATE.papelera  = data.state.papelera  || [];
      STATE.salidas   = data.state.salidas   || [];
      STATE.logs      = data.state.logs      || [];
      STATE.elaboros  = data.state.elaboros  || [];
      STATE.nextId    = data.state.nextId    || 1000;
      SYNC._version   = data.version || 0;

      if (data.users && Array.isArray(data.users) && data.users.length > 0) {
        AUTH.users = data.users;
        _localSaveUsers(data.users);
      }

      localSaveState();
      console.log('[SYNC] 📥 Cargados ' + data.state.records.length + ' registros desde Supabase (v' + SYNC._version + ')');
      return true;
    }
  } catch (e) {
    console.warn('[SYNC] Error cargando:', e);
  }

  return localLoadState();
}

// ========================================
// USUARIOS
// ========================================

function syncSaveUsers(users) {
  _localSaveUsers(users);
  if (SYNC.initialized) syncSaveState();
}

async function syncLoadUsers() {
  if (!SYNC.initialized || !SYNC._client) return null;
  try {
    var { data } = await SYNC._client
      .from('app_state')
      .select('users')
      .eq('id', 1)
      .single();
    if (data && data.users && Array.isArray(data.users)) return data.users;
  } catch (e) {}
  return null;
}

function listenUserChanges() { /* automático via WebSocket */ }

function _localSaveUsers(users) {
  try {
    localStorage.setItem('debbiom_users_v2', JSON.stringify(
      users.map(function(u) { return { username: u.username, _h: u._h, role: u.role, fullName: u.fullName }; })
    ));
  } catch (e) {}
}

// ========================================
// LOCAL STORAGE (Caché offline)
// ========================================

function localSaveState() {
  try {
    localStorage.setItem('debbiom_state', JSON.stringify({
      records: STATE.records, obsoletos: STATE.obsoletos,
      papelera: STATE.papelera, salidas: STATE.salidas,
      logs: STATE.logs, elaboros: STATE.elaboros, nextId: STATE.nextId
    }));
  } catch (e) {}
}

function localLoadState() {
  try {
    var s = localStorage.getItem('debbiom_state');
    if (s) {
      var d = JSON.parse(s);
      if (d.records && d.records.length > 0) {
        STATE.records = d.records; STATE.obsoletos = d.obsoletos || [];
        STATE.papelera = d.papelera || []; STATE.salidas = d.salidas || [];
        STATE.logs = d.logs || []; STATE.elaboros = d.elaboros || [];
        STATE.nextId = d.nextId || 1000;
        return true;
      }
    }
  } catch (e) {}
  return false;
}

// ========================================
// LIMPIEZA
// ========================================

function cleanupSync() {
  clearTimeout(SYNC._saveTimer);
  if (SYNC._channel) {
    SYNC._client.removeChannel(SYNC._channel);
  }
  unregisterPresence();
}

window.addEventListener('beforeunload', cleanupSync);

/* ══════════════════════════════════════════════════
   Streaming Service — Frontend Application Logic
   JSMpeg canvas player, Auth, PWA, Camera management
══════════════════════════════════════════════════ */
'use strict';

// ── State ─────────────────────────────────────────
let authToken   = localStorage.getItem('stream_token') || null;
let cameras     = [];
let players     = {};   // camId -> JSMpeg.Player instance
let wakeLock    = null;
let deferredPWA = null;

// ── DOM ───────────────────────────────────────────
const loginScreen = document.getElementById('login-screen');
const app         = document.getElementById('app');
const loginForm   = document.getElementById('login-form');
const loginErr    = document.getElementById('login-err');
const loginBtn    = document.getElementById('login-btn');
const grid        = document.getElementById('grid');
const modal       = document.getElementById('modal');
const camForm     = document.getElementById('cam-form');
const camErr      = document.getElementById('cam-err');
const modalTitle  = document.getElementById('modal-title');

// ── Service Worker (PWA) ──────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Android install prompt
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPWA = e;
  document.getElementById('btn-install').classList.remove('hidden');
});

document.getElementById('btn-install').addEventListener('click', async () => {
  if (!deferredPWA) return;
  deferredPWA.prompt();
  const { outcome } = await deferredPWA.userChoice;
  if (outcome === 'accepted') document.getElementById('btn-install').classList.add('hidden');
  deferredPWA = null;
});

// ── Auth ──────────────────────────────────────────
async function checkAuth() {
  if (!authToken) { showLogin(); return; }
  try {
    const r = await apiFetch('/api/auth/check');
    if (r.authenticated) {
      showApp();
    } else {
      authToken = null;
      localStorage.removeItem('stream_token');
      showLogin();
    }
  } catch {
    showLogin();
  }
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginErr.textContent = '';
  loginBtn.disabled = true;
  loginBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Connecting...';
  const user = document.getElementById('f-user').value;
  const pass = document.getElementById('f-pass').value;
  try {
    const r = await apiFetch('/api/login', { method: 'POST', body: { username: user, password: pass } });
    if (r.success) {
      authToken = r.token;
      localStorage.setItem('stream_token', authToken);
      showApp();
    } else {
      loginErr.textContent = r.message || 'Login failed';
    }
  } catch {
    loginErr.textContent = 'Cannot connect to server';
  }
  loginBtn.disabled = false;
  loginBtn.innerHTML = '<span>Connect</span><i class="fa-solid fa-arrow-right-to-bracket"></i>';
});

document.getElementById('btn-logout').addEventListener('click', async () => {
  await apiFetch('/api/logout', { method: 'POST' }).catch(() => {});
  authToken = null;
  localStorage.removeItem('stream_token');
  destroyAllPlayers();
  showLogin();
});

function showLogin() {
  loginScreen.classList.remove('hidden');
  app.classList.add('hidden');
}

function showApp() {
  loginScreen.classList.add('hidden');
  app.classList.remove('hidden');
  loadCameras();
}

// ── API Helper ────────────────────────────────────
async function apiFetch(url, { method = 'GET', body } = {}) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
    },
    credentials: 'include'
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  return res.json();
}

// ── Cameras ───────────────────────────────────────
async function loadCameras() {
  try {
    const r = await apiFetch('/api/cameras');
    if (r.success) {
      cameras = r.cameras;
      renderGrid();
    }
  } catch (err) {
    console.error('Failed to load cameras:', err);
  }
}

function renderGrid() {
  destroyAllPlayers();
  grid.innerHTML = '';

  cameras.forEach((cam) => {
    const card = document.createElement('div');
    card.className = 'cam-card';
    card.id = `card-${cam.id}`;

    // Build WebSocket URL: wss://<host>/stream?id=<id>&token=<jwt>
    const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl   = `${wsProto}://${location.host}/stream?id=${encodeURIComponent(cam.id)}&token=${encodeURIComponent(authToken)}`;

    const canvas = document.createElement('canvas');
    card.innerHTML = `
      <div class="cam-bar">
        <span class="cam-name"><i class="fa-solid fa-video" style="margin-right:5px;opacity:.6"></i>${cam.name}</span>
        <div class="cam-actions">
          <button class="cam-btn" title="Fullscreen" onclick="toggleFS('${cam.id}')">
            <i class="fa-solid fa-expand"></i>
          </button>
          <button class="cam-btn del" title="Remove" onclick="removeCam('${cam.id}')">
            <i class="fa-solid fa-trash"></i>
          </button>
        </div>
      </div>
    `;
    card.appendChild(canvas);
    grid.appendChild(card);

    // Create JSMpeg player — connects to our custom WebSocket stream engine
    players[cam.id] = new JSMpeg.Player(wsUrl, {
      canvas,
      autoplay: true,
      audio:    false,
      loop:     false,
      onStalled: () => {
        // Auto-reconnect after 3s stall
        setTimeout(() => {
          if (players[cam.id]) {
            players[cam.id].destroy();
            delete players[cam.id];
            players[cam.id] = new JSMpeg.Player(wsUrl, { canvas, autoplay: true, audio: false });
          }
        }, 3000);
      }
    });
  });
}

function destroyAllPlayers() {
  Object.values(players).forEach((p) => { try { p.destroy(); } catch (_) {} });
  players = {};
}

// ── Grid Layout ───────────────────────────────────
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    grid.className = `grid g${btn.dataset.grid}`;
  });
});

// ── Fullscreen ────────────────────────────────────
window.toggleFS = function(id) {
  const card = document.getElementById(`card-${id}`);
  if (!card) return;
  if (!document.fullscreenElement) {
    card.requestFullscreen().catch(console.warn);
  } else {
    document.exitFullscreen();
  }
};

// ── Remove Camera ─────────────────────────────────
window.removeCam = async function(id) {
  if (!confirm('Remove this feed?')) return;
  try {
    await apiFetch(`/api/cameras/${id}`, { method: 'DELETE' });
    cameras = cameras.filter(c => c.id !== id);
    renderGrid();
  } catch {
    alert('Failed to remove feed');
  }
};

// ── Add / Edit Modal ──────────────────────────────
document.getElementById('btn-add').addEventListener('click', () => {
  document.getElementById('edit-id').value = '';
  modalTitle.textContent = 'Add New Feed';
  camForm.reset();
  camErr.textContent = '';
  modal.classList.remove('hidden');
});

document.getElementById('modal-close').addEventListener('click', () => {
  modal.classList.add('hidden');
});

modal.addEventListener('click', (e) => {
  if (e.target === modal) modal.classList.add('hidden');
});

camForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  camErr.textContent = '';
  const editId = document.getElementById('edit-id').value;
  const payload = {
    name:    document.getElementById('c-name').value,
    ip:      document.getElementById('c-ip').value,
    port:    parseInt(document.getElementById('c-port').value, 10),
    username: document.getElementById('c-user').value,
    password: document.getElementById('c-pass').value,
    subtype: parseInt(document.getElementById('c-sub').value, 10),
    channel: parseInt(document.getElementById('c-ch').value, 10)
  };

  try {
    const url    = editId ? `/api/cameras/${editId}` : '/api/cameras';
    const method = editId ? 'PUT' : 'POST';
    const r = await apiFetch(url, { method, body: payload });
    if (r.success) {
      modal.classList.add('hidden');
      await loadCameras();
    } else {
      camErr.textContent = r.message || 'Failed to save';
    }
  } catch {
    camErr.textContent = 'Network error';
  }
});

// ── Wake Lock (Keep Android Screen On) ────────────
document.getElementById('btn-wake').addEventListener('click', async () => {
  const btn = document.getElementById('btn-wake');
  try {
    if (!wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      btn.classList.add('active');
      btn.title = 'Screen awake — tap to disable';
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
        btn.classList.remove('active');
      });
    } else {
      await wakeLock.release();
    }
  } catch (err) {
    console.warn('Wake Lock not supported:', err.message);
  }
});

// ── Init ──────────────────────────────────────────
checkAuth();

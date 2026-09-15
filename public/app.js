/* ══════════════════════════════════════════════════
   Streaming Service — Frontend Application Logic
   JSMpeg canvas player, Auth, PWA, Feed management
══════════════════════════════════════════════════ */
'use strict';

// ── State ─────────────────────────────────────────
let authToken   = localStorage.getItem('stream_token') || null;
let feeds     = [];
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
  loadFeeds();
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

// ── Feeds ───────────────────────────────────────
async function loadFeeds() {
  try {
    const r = await apiFetch('/api/feeds');
    if (r.success) {
      feeds = r.feeds;
      renderGrid();
    }
  } catch (err) {
    console.error('Failed to load feeds:', err);
  }
}

let audioActiveId = null;

function renderGrid() {
  destroyAllPlayers();
  audioActiveId = null;
  grid.innerHTML = '';

  feeds.forEach((cam) => {
    const card = document.createElement('div');
    card.className = 'cam-card';
    card.id = `card-${cam.id}`;

    // Build WebSocket URL: wss://<host>/stream?id=<id>&token=<jwt>
    const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl   = `${wsProto}://${location.host}/stream?id=${encodeURIComponent(cam.id)}&token=${encodeURIComponent(authToken)}`;

    const canvas = document.createElement('canvas');
    card.innerHTML = `
      <div class="cam-bar">
        <span class="cam-name" id="name-${cam.id}"><i class="fa-solid fa-video" style="margin-right:5px;opacity:.6"></i>${escapeHtml(cam.name)}</span>
        <div class="cam-actions">
          <button class="cam-btn audio-btn" id="audio-${cam.id}" title="Unmute Audio" onclick="toggleAudio('${cam.id}')">
            <i class="fa-solid fa-volume-xmark"></i>
          </button>
          <button class="cam-btn" title="Rename Feed" onclick="renameFeed('${cam.id}')">
            <i class="fa-solid fa-pen"></i>
          </button>
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

    initPlayer(cam.id, wsUrl, canvas);
  });
}

function initPlayer(camId, wsUrl, canvas) {
  // Create JSMpeg player with audio enabled, muted by default
  const player = new JSMpeg.Player(wsUrl, {
    canvas,
    autoplay: true,
    audio:    true,
    loop:     false,
    onStalled: () => {
      setTimeout(() => {
        if (players[camId]) {
          players[camId].destroy();
          delete players[camId];
          initPlayer(camId, wsUrl, canvas);
        }
      }, 3000);
    }
  });

  // Start with audio muted
  player.volume = 0;
  players[camId] = player;
}

function destroyAllPlayers() {
  Object.values(players).forEach((p) => { try { p.destroy(); } catch (_) {} });
  players = {};
  audioActiveId = null;
}

// ── Audio Mute / Unmute ───────────────────────────
window.toggleAudio = function(id) {
  const p = players[id];
  if (!p) return;
  const btn = document.getElementById(`audio-${id}`);
  const isMuted = (p.volume === 0);

  if (isMuted) {
    // Mute previous active feed so feeds don't overlap
    if (audioActiveId && audioActiveId !== id && players[audioActiveId]) {
      players[audioActiveId].volume = 0;
      const prevBtn = document.getElementById(`audio-${audioActiveId}`);
      if (prevBtn) {
        prevBtn.innerHTML = '<i class="fa-solid fa-volume-xmark"></i>';
        prevBtn.classList.remove('active');
        prevBtn.title = 'Unmute Audio';
      }
    }

    // Unlock WebAudio context on user gesture
    if (p.audioOut) {
      if (p.audioOut.unlock) p.audioOut.unlock();
      if (p.audioOut.destination && p.audioOut.destination.context && p.audioOut.destination.context.state === 'suspended') {
        p.audioOut.destination.context.resume();
      }
    }

    p.volume = 1;
    audioActiveId = id;

    if (btn) {
      btn.innerHTML = '<i class="fa-solid fa-volume-high"></i>';
      btn.classList.add('active');
      btn.title = 'Mute Audio';
    }
  } else {
    p.volume = 0;
    if (audioActiveId === id) audioActiveId = null;

    if (btn) {
      btn.innerHTML = '<i class="fa-solid fa-volume-xmark"></i>';
      btn.classList.remove('active');
      btn.title = 'Unmute Audio';
    }
  }
};

// ── Rename Feed ───────────────────────────────────
window.renameFeed = async function(id) {
  const feed = feeds.find(f => f.id === id);
  const current = feed ? feed.name : '';
  const newName = prompt('Enter new name for this feed:', current);
  if (!newName || !newName.trim() || newName.trim() === current) return;

  try {
    const r = await apiFetch(`/api/feeds/${id}/rename`, {
      method: 'PATCH',
      body: { name: newName.trim() }
    });
    if (r.success) {
      if (feed) feed.name = newName.trim();
      const nameEl = document.getElementById(`name-${id}`);
      if (nameEl) {
        nameEl.innerHTML = `<i class="fa-solid fa-video" style="margin-right:5px;opacity:.6"></i>${escapeHtml(newName.trim())}`;
      }
    } else {
      alert(r.message || 'Failed to rename feed');
    }
  } catch {
    alert('Network error renaming feed');
  }
};

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
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

// ── Remove Feed ─────────────────────────────────
window.removeCam = async function(id) {
  if (!confirm('Remove this feed?')) return;
  try {
    await apiFetch(`/api/feeds/${id}`, { method: 'DELETE' });
    feeds = feeds.filter(c => c.id !== id);
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
    const url    = editId ? `/api/feeds/${editId}` : '/api/feeds';
    const method = editId ? 'PUT' : 'POST';
    const r = await apiFetch(url, { method, body: payload });
    if (r.success) {
      modal.classList.add('hidden');
      await loadFeeds();
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

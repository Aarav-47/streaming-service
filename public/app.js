/* ══════════════════════════════════════════════════
   Streaming Service — Frontend Application Logic
   JSMpeg canvas player, Auth, PWA, Feed management
══════════════════════════════════════════════════ */
'use strict';

// ── State ─────────────────────────────────────────
let authToken          = localStorage.getItem('stream_token') || null;
let feeds            = [];
let players            = {};   // camId -> JSMpeg.Player instance
let wakeLock           = null;
let deferredPWA        = null;
let activeServerTarget = localStorage.getItem('stream_server_target') || 'auto';
let macServerUrl       = localStorage.getItem('stream_mac_url') || 'http://Bhakts-Mac-mini-2.local:3000';
let winServerUrl       = localStorage.getItem('stream_win_url') || 'http://localhost:3000';
let customServerUrl    = localStorage.getItem('stream_custom_url') || '';
let currentNodeData    = null;

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
const serverModal = document.getElementById('server-modal');

// ── Service Worker (PWA) ──────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then((reg) => {
        console.log('[PWA] Service Worker registered with scope:', reg.scope);
      })
      .catch((err) => {
        console.warn('[PWA] Service Worker registration failed:', err);
      });
  });
}

// Android / Chromium install prompt
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPWA = e;
  const bDesk = document.getElementById('btn-install');
  const bMob  = document.getElementById('btn-m-install');
  if (bDesk) bDesk.classList.remove('hidden');
  if (bMob)  bMob.classList.remove('hidden');
});

async function handlePWAInstall() {
  if (deferredPWA) {
    deferredPWA.prompt();
    const { outcome } = await deferredPWA.userChoice;
    if (outcome === 'accepted') {
      const bDesk = document.getElementById('btn-install');
      const bMob  = document.getElementById('btn-m-install');
      if (bDesk) bDesk.classList.add('hidden');
      if (bMob)  bMob.classList.add('hidden');
    }
    deferredPWA = null;
  } else {
    // Helpful guide for iOS Safari and other browsers
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    if (isIOS) {
      alert('To install Streaming Service on iPhone / iPad:\n\n1. Tap the Share button (square with arrow ↑) in Safari.\n2. Scroll down and tap "Add to Home Screen".\n3. Tap "Add" at the top right.');
    } else {
      alert('To install Streaming Service:\n\n• In Chrome/Edge: Tap menu (⋮) -> "Install App" or "Add to Home screen"\n• If already installed, check your app launcher or home screen.');
    }
  }
}

const btnInstall = document.getElementById('btn-install');
if (btnInstall) btnInstall.addEventListener('click', handlePWAInstall);

const btnMInstall = document.getElementById('btn-m-install');
if (btnMInstall) btnMInstall.addEventListener('click', () => {
  toggleMobileMenu(false);
  handlePWAInstall();
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
  checkGitSyncStatus();
  loadRecordingsList();
  refreshNodeStatus();
}

// ── Multi-Node Server Target Helpers ──────────────
function getServerBaseUrl() {
  if (activeServerTarget === 'mac') return macServerUrl.replace(/\/+$/, '');
  if (activeServerTarget === 'win') return winServerUrl.replace(/\/+$/, '');
  if (activeServerTarget === 'custom') return customServerUrl.replace(/\/+$/, '');
  return ''; // 'auto' -> use current origin (relative URLs)
}

function resolveApiUrl(path) {
  const base = getServerBaseUrl();
  if (!base) return path;
  return base + path;
}

function resolveWsUrl(path) {
  const base = getServerBaseUrl();
  if (!base) {
    const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${wsProto}://${location.host}${path}`;
  }
  try {
    const u = new URL(base);
    const wsProto = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProto}//${u.host}${path}`;
  } catch (_) {
    const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${wsProto}://${location.host}${path}`;
  }
}

// ── API Helper ────────────────────────────────────
async function apiFetch(url, { method = 'GET', body } = {}) {
  const targetUrl = (url.startsWith('http://') || url.startsWith('https://')) ? url : resolveApiUrl(url);
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
    },
    credentials: 'include'
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(targetUrl, opts);
  return res.json();
}

// ── Feeds ───────────────────────────────────────
async function loadFeeds() {
  try {
    const r = await apiFetch('/api/feeds');
    if (r.success) {
      const savedOrder = JSON.parse(localStorage.getItem('feed_order') || 'null');
      if (Array.isArray(savedOrder) && savedOrder.length) {
        const feedMap = new Map(r.feeds.map(f => [f.id, f]));
        const ordered = [];
        for (const id of savedOrder) {
          if (feedMap.has(id)) {
            ordered.push(feedMap.get(id));
            feedMap.delete(id);
          }
        }
        for (const f of feedMap.values()) ordered.push(f);
        feeds = ordered;
      } else {
        feeds = r.feeds;
      }
      renderGrid();
    }
  } catch (err) {
    console.error('Failed to load feeds:', err);
  }
}

let audioActiveId = null;
let draggedCard   = null;
let currentPage   = 1;
let pageSize      = 4; // Default to 4 view (2x2)

const pagerWrap     = document.getElementById('pager-wrap');
const btnPrevPage   = document.getElementById('btn-prev-page');
const btnNextPage   = document.getElementById('btn-next-page');
const pageIndicator = document.getElementById('page-indicator');

if (btnPrevPage && btnNextPage) {
  btnPrevPage.addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage--;
      renderGrid();
    }
  });
  btnNextPage.addEventListener('click', () => {
    const totalPages = Math.max(1, Math.ceil(feeds.length / (pageSize || 1)));
    if (currentPage < totalPages) {
      currentPage++;
      renderGrid();
    }
  });
}

const feedQuality = {}; // id -> 'sd' | 'hd'
const feedPlaying = {}; // id -> boolean

function renderGrid() {
  destroyAllPlayers();
  audioActiveId = null;
  grid.innerHTML = '';

  let visibleFeeds = feeds;
  let offset = 0;

  if (pageSize > 0) {
    if (pagerWrap) pagerWrap.classList.remove('hidden');
    const totalPages = Math.max(1, Math.ceil(feeds.length / pageSize));
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;

    offset = (currentPage - 1) * pageSize;
    visibleFeeds = feeds.slice(offset, offset + pageSize);

    if (pageIndicator) pageIndicator.textContent = `${currentPage} / ${totalPages}`;
    if (btnPrevPage) btnPrevPage.disabled = (currentPage <= 1);
    if (btnNextPage) btnNextPage.disabled = (currentPage >= totalPages);
  } else {
    if (pagerWrap) pagerWrap.classList.add('hidden');
  }

  visibleFeeds.forEach((cam, idx) => {
    const sno = String(offset + idx + 1).padStart(2, '0');
    const q = feedQuality[cam.id] || 'sd';
    const isPlaying = !!feedPlaying[cam.id];
    const isRec = Boolean(activeRecordings[cam.id]);

    const card = document.createElement('div');
    card.className = 'cam-card';
    card.id = `card-${cam.id}`;
    card.dataset.id = cam.id;

    const canvas = document.createElement('canvas');
    canvas.id = `canvas-${cam.id}`;

    card.innerHTML = `
      <div class="cam-bar">
        <div class="cam-info">
          <span class="cam-sno">${sno}</span>
          <span class="cam-name" id="name-${cam.id}"><i class="fa-solid fa-video" style="margin-right:4px;opacity:.6"></i>${escapeHtml(cam.name)}</span>
        </div>
        <div class="cam-actions">
          <button class="cam-btn q-toggle-btn ${q === 'hd' ? 'hd-active' : ''}" id="qtoggle-${cam.id}" onclick="event.stopPropagation(); toggleQuality('${cam.id}')" title="Stream Quality: ${q.toUpperCase()}">${q.toUpperCase()}</button>
          <button class="cam-btn play-btn ${isPlaying ? 'playing' : ''}" id="playbtn-${cam.id}" title="${isPlaying ? 'Stop Feed' : 'Start Feed'}" onclick="event.stopPropagation(); toggleFeedPlay('${cam.id}')">
            <i class="fa-solid ${isPlaying ? 'fa-stop' : 'fa-play'}"></i>
          </button>
          <button class="cam-btn ctrl-btn rec-btn ${isRec ? 'recording' : ''}" id="recbtn-${cam.id}" title="${isRec ? 'Stop Recording' : 'Start Secret Recording'}" onclick="event.stopPropagation(); toggleRecord('${cam.id}')">
            <i class="fa-solid fa-circle-dot"></i>
          </button>
          <button class="cam-btn zoom-btn" id="zoombtn-${cam.id}" onclick="event.stopPropagation(); cycleZoom('${cam.id}')" title="Zoom: 1x / 2x / 3.5x">
            <i class="fa-solid fa-magnifying-glass-plus"></i>
          </button>
          <button class="cam-btn move-btn" title="Move Left" onclick="event.stopPropagation(); moveFeed('${cam.id}', -1)">
            <i class="fa-solid fa-arrow-left"></i>
          </button>
          <button class="cam-btn move-btn" title="Move Right" onclick="event.stopPropagation(); moveFeed('${cam.id}', 1)">
            <i class="fa-solid fa-arrow-right"></i>
          </button>
          <button class="cam-btn audio-btn" id="audio-${cam.id}" title="Unmute Audio" onclick="event.stopPropagation(); toggleAudio('${cam.id}')">
            <i class="fa-solid fa-volume-xmark"></i>
          </button>
          <button class="cam-btn rename-btn" title="Rename Feed" onclick="event.stopPropagation(); renameFeed('${cam.id}')">
            <i class="fa-solid fa-pen"></i>
          </button>
          <button class="cam-btn fs-btn" title="Fullscreen" onclick="event.stopPropagation(); toggleFS('${cam.id}')">
            <i class="fa-solid fa-expand"></i>
          </button>
          <button class="cam-btn del" title="Remove" onclick="event.stopPropagation(); removeCam('${cam.id}')">
            <i class="fa-solid fa-trash"></i>
          </button>
        </div>
      </div>
      <div id="rec-badge-${cam.id}" class="rec-overlay-badge ${isRec ? '' : 'hidden'}">
        <span class="rec-dot"></span>
        <span id="rec-timer-${cam.id}">REC 00:00</span>
      </div>
      <div id="zoom-badge-${cam.id}" class="zoom-badge hidden" onclick="event.stopPropagation(); resetZoom('${cam.id}')" title="Click to reset zoom">
        <i class="fa-solid fa-magnifying-glass"></i> <span id="zoom-val-${cam.id}">1.0x</span> <i class="fa-solid fa-xmark" style="font-size:9px;margin-left:2px;opacity:.7"></i>
      </div>
      <div class="cam-overlay ${isPlaying ? 'hidden' : ''}" id="overlay-${cam.id}" onclick="startFeed('${cam.id}')">
        <div class="play-circle"><i class="fa-solid fa-play"></i></div>
        <span class="overlay-label">Click to Open Feed</span>
      </div>
    `;
    card.appendChild(canvas);
    grid.appendChild(card);

    setupDragAndDrop(card);
    setupZoomAndPan(card, cam.id);

    if (isPlaying) {
      startFeed(cam.id);
    }
  });

  updatePlayAllBtn();
}

function resetCanvas(card, id) {
  const oldCanvas = card.querySelector('canvas');
  if (oldCanvas) oldCanvas.remove();
  const newCanvas = document.createElement('canvas');
  newCanvas.id = `canvas-${id}`;
  card.appendChild(newCanvas);
  if (typeof resetZoom === 'function') resetZoom(id);
  return newCanvas;
}

// ── On-Demand Stream Management ───────────────────
window.startFeed = function(id) {
  feedPlaying[id] = true;
  updateAutoWakeLock();
  const q = feedQuality[id] || 'sd';

  const card = document.getElementById(`card-${id}`);
  if (!card) return;

  const playBtn = document.getElementById(`playbtn-${id}`);
  if (playBtn) {
    playBtn.innerHTML = '<i class="fa-solid fa-stop"></i>';
    playBtn.title = 'Stop Feed';
    playBtn.classList.add('playing');
  }

  const overlay = document.getElementById(`overlay-${id}`);
  if (overlay) {
    overlay.innerHTML = `
      <div class="loading-spinner"><i class="fa-solid fa-circle-notch fa-spin"></i></div>
      <span class="overlay-label">Connecting Stream...</span>
    `;
    overlay.classList.remove('hidden');
  }

  if (players[id]) {
    try { players[id].destroy(); } catch (_) {}
    delete players[id];
  }

  const canvas = resetCanvas(card, id);
  const wsUrl  = resolveWsUrl(`/stream?id=${encodeURIComponent(id)}&quality=${q}&token=${encodeURIComponent(authToken)}`);

  initPlayer(id, wsUrl, canvas);
  updatePlayAllBtn();
};

window.stopFeed = function(id) {
  feedPlaying[id] = false;
  updateAutoWakeLock();

  if (players[id]) {
    try { players[id].destroy(); } catch (_) {}
    delete players[id];
  }

  const card = document.getElementById(`card-${id}`);
  if (card) {
    resetCanvas(card, id);
    const overlay = document.getElementById(`overlay-${id}`);
    if (overlay) {
      overlay.innerHTML = `
        <div class="play-circle"><i class="fa-solid fa-play"></i></div>
        <span class="overlay-label">Click to Open Feed</span>
      `;
      overlay.classList.remove('hidden');
    }
  }

  const playBtn = document.getElementById(`playbtn-${id}`);
  if (playBtn) {
    playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
    playBtn.title = 'Start Feed';
    playBtn.classList.remove('playing');
  }

  updatePlayAllBtn();
};

window.toggleFeedPlay = function(id) {
  if (feedPlaying[id]) {
    stopFeed(id);
  } else {
    startFeed(id);
  }
};

window.toggleQuality = function(id) {
  const current = feedQuality[id] || 'sd';
  const next = current === 'sd' ? 'hd' : 'sd';
  setFeedQuality(id, next);
};

window.setFeedQuality = function(id, quality) {
  feedQuality[id] = quality;
  const qsd = document.getElementById(`qsd-${id}`);
  const qhd = document.getElementById(`qhd-${id}`);
  if (qsd && qhd) {
    qsd.classList.toggle('active', quality === 'sd');
    qhd.classList.toggle('active', quality === 'hd');
  }
  const qtoggle = document.getElementById(`qtoggle-${id}`);
  if (qtoggle) {
    qtoggle.textContent = quality.toUpperCase();
    qtoggle.title = `Stream Quality: ${quality.toUpperCase()}`;
    qtoggle.classList.toggle('hd-active', quality === 'hd');
  }
  if (feedPlaying[id]) {
    startFeed(id);
  }
};

// Master Play All / Stop All
const btnPlayAll = document.getElementById('btn-play-all');
if (btnPlayAll) {
  btnPlayAll.addEventListener('click', () => {
    const currentCards = Array.from(grid.querySelectorAll('.cam-card'));
    const anyStopped = currentCards.some(c => !feedPlaying[c.dataset.id]);

    currentCards.forEach(c => {
      const id = c.dataset.id;
      if (anyStopped) {
        startFeed(id);
      } else {
        stopFeed(id);
      }
    });
    updatePlayAllBtn();
  });
}

function updatePlayAllBtn() {
  if (!btnPlayAll) return;
  const currentCards = Array.from(grid.querySelectorAll('.cam-card'));
  if (!currentCards.length) return;
  const allPlaying = currentCards.every(c => feedPlaying[c.dataset.id]);
  btnPlayAll.innerHTML = allPlaying
    ? '<i class="fa-solid fa-stop"></i><span class="btn-label">Stop All</span>'
    : '<i class="fa-solid fa-play"></i><span class="btn-label">Play All</span>';
}

function setupDragAndDrop(card) {
  card.setAttribute('draggable', 'true');

  card.addEventListener('dragstart', (e) => {
    draggedCard = card;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.dataset.id);
  });

  card.addEventListener('dragend', () => {
    if (draggedCard) draggedCard.classList.remove('dragging');
    draggedCard = null;
    document.querySelectorAll('.cam-card').forEach(c => c.classList.remove('drag-over'));
  });

  card.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (draggedCard && draggedCard !== card) {
      card.classList.add('drag-over');
    }
  });

  card.addEventListener('dragleave', () => {
    card.classList.remove('drag-over');
  });

  card.addEventListener('drop', (e) => {
    e.preventDefault();
    card.classList.remove('drag-over');
    if (!draggedCard || draggedCard === card) return;

    const allCards = Array.from(grid.children);
    const draggedIdx = allCards.indexOf(draggedCard);
    const targetIdx = allCards.indexOf(card);

    if (draggedIdx < targetIdx) {
      grid.insertBefore(draggedCard, card.nextElementSibling);
    } else {
      grid.insertBefore(draggedCard, card);
    }

    onOrderChanged();
  });
}

// ── Reordering Helpers ────────────────────────────
window.moveFeed = function(id, dir) {
  const card = document.getElementById(`card-${id}`);
  if (!card) return;
  if (dir === -1) {
    const prev = card.previousElementSibling;
    if (prev) {
      grid.insertBefore(card, prev);
      onOrderChanged();
    }
  } else if (dir === 1) {
    const next = card.nextElementSibling;
    if (next) {
      grid.insertBefore(card, next.nextElementSibling);
      onOrderChanged();
    }
  }
};

function onOrderChanged() {
  const currentIds = Array.from(grid.children).map(c => c.dataset.id);
  const feedMap = new Map(feeds.map(f => [f.id, f]));
  if (pageSize > 0) {
    const offset = (currentPage - 1) * pageSize;
    for (let i = 0; i < currentIds.length; i++) {
      feeds[offset + i] = feedMap.get(currentIds[i]);
    }
  } else {
    feeds = currentIds.map(id => feedMap.get(id)).filter(Boolean);
  }
  updateSnoBadges();
  const allOrderedIds = feeds.map(f => f.id);
  localStorage.setItem('feed_order', JSON.stringify(allOrderedIds));
  apiFetch('/api/feeds/reorder', {
    method: 'POST',
    body: { orderedIds: allOrderedIds }
  }).catch(() => {});
}

function updateSnoBadges() {
  const offset = pageSize > 0 ? (currentPage - 1) * pageSize : 0;
  Array.from(grid.children).forEach((card, idx) => {
    const snoEl = card.querySelector('.cam-sno');
    if (snoEl) {
      snoEl.textContent = String(offset + idx + 1).padStart(2, '0');
    }
  });
}

function showFeedError(camId, err) {
  const overlay = document.getElementById(`overlay-${camId}`);
  if (!overlay) return;

  overlay.classList.remove('hidden');
  overlay.innerHTML = `
    <div class="cam-error-box">
      <div class="status-badge ${err.status || 'error'}">
        <i class="fa-solid ${err.icon || 'fa-triangle-exclamation'}"></i>
        <span>${escapeHtml(err.short || 'Error')}</span>
      </div>
      <div class="status-msg">${escapeHtml(err.message || 'Stream connection failed')}</div>
      <div class="status-actions">
        <button class="status-btn retry" onclick="event.stopPropagation(); startFeed('${camId}')">
          <i class="fa-solid fa-rotate-right"></i> Retry
        </button>
        <button class="status-btn edit" onclick="event.stopPropagation(); editCam('${camId}')">
          <i class="fa-solid fa-pen"></i> Edit
        </button>
      </div>
    </div>
  `;
}

async function handleFeedCloseError(camId, code, reason) {
  feedPlaying[camId] = false;
  updateAutoWakeLock();
  if (players[camId]) {
    try { players[camId].destroy(); } catch (_) {}
    delete players[camId];
  }

  const playBtn = document.getElementById(`playbtn-${camId}`);
  if (playBtn) {
    playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
    playBtn.classList.remove('playing');
    playBtn.title = 'Start Feed';
  }

  updatePlayAllBtn();

  // 1. Check if WebSocket gave us a specific diagnostic code
  if (code === 4401 || (reason && reason.toLowerCase().includes('auth'))) {
    showFeedError(camId, {
      status: 'auth_error',
      short: 'Auth Error',
      icon: 'fa-key',
      message: reason || 'Invalid username or password'
    });
    return;
  }

  if (code === 4408 || (reason && reason.toLowerCase().includes('offline'))) {
    showFeedError(camId, {
      status: 'offline',
      short: 'Feed Offline',
      icon: 'fa-wifi-slash',
      message: reason || 'Feed is offline or unreachable'
    });
    return;
  }

  if (code === 4404 || (reason && reason.toLowerCase().includes('not found'))) {
    showFeedError(camId, {
      status: 'not_found',
      short: 'Stream Not Found',
      icon: 'fa-circle-xmark',
      message: reason || 'RTSP channel or stream not found (404)'
    });
    return;
  }

  if (code === 4501 || (reason && reason.toLowerCase().includes('corrupted'))) {
    showFeedError(camId, {
      status: 'invalid_data',
      short: 'Stream Error',
      icon: 'fa-triangle-exclamation',
      message: reason || 'Feed returned invalid or unsupported video'
    });
    return;
  }

  // 2. Active network diagnostic probe
  const overlay = document.getElementById(`overlay-${camId}`);
  if (overlay) {
    overlay.innerHTML = `
      <div class="loading-spinner"><i class="fa-solid fa-circle-notch fa-spin"></i></div>
      <span class="overlay-label">Diagnosing Feed...</span>
    `;
    overlay.classList.remove('hidden');
  }

  try {
    const diag = await apiFetch(`/api/feeds/${camId}/check`);
    if (diag.success && !diag.reachable) {
      showFeedError(camId, {
        status: 'offline',
        short: 'Feed Offline',
        icon: 'fa-wifi-slash',
        message: diag.message || 'Host is unreachable / connection timed out'
      });
      return;
    } else if (diag.status === 'auth_error') {
      showFeedError(camId, {
        status: 'auth_error',
        short: 'Auth Error',
        icon: 'fa-key',
        message: diag.message || 'Invalid username or password'
      });
      return;
    }
  } catch (_) {}

  // 3. Fallback generic stream error
  showFeedError(camId, {
    status: 'error',
    short: 'Stream Error',
    icon: 'fa-triangle-exclamation',
    message: reason || `Stream exited (code ${code || 'failed'})`
  });
}

window.editCam = function(id) {
  const cam = feeds.find(c => c.id === id);
  if (!cam) return;
  document.getElementById('edit-id').value = cam.id;
  modalTitle.textContent = `Edit Feed: ${cam.name}`;
  document.getElementById('c-name').value = cam.name;
  document.getElementById('c-ip').value   = cam.ip;
  document.getElementById('c-port').value = cam.port || 554;
  document.getElementById('c-user').value = cam.username || 'admin';
  document.getElementById('c-pass').value = cam.password || '';
  document.getElementById('c-sub').value  = String(cam.subtype || 0);
  document.getElementById('c-ch').value   = String(cam.channel || 1);
  camErr.textContent = '';
  modal.classList.remove('hidden');
};

function initPlayer(camId, wsUrl, canvas) {
  let firstFrame = false;
  const overlay = document.getElementById(`overlay-${camId}`);

  // Create JSMpeg player with audio enabled, muted by default
  const player = new JSMpeg.Player(wsUrl, {
    canvas,
    autoplay: true,
    audio:    true,
    loop:     false,
    onVideoDecode: () => {
      if (!firstFrame) {
        firstFrame = true;
        if (overlay) overlay.classList.add('hidden');
      }
    },
    onSourceCompleted: () => {
      if (!firstFrame && feedPlaying[camId]) {
        handleFeedCloseError(camId, 4500, 'Stream ended without video frames');
      }
    },
    onStalled: () => {
      setTimeout(() => {
        if (players[camId] && feedPlaying[camId]) {
          players[camId].destroy();
          delete players[camId];
          const card = document.getElementById(`card-${camId}`);
          if (card) {
            const freshCanvas = resetCanvas(card, camId);
            initPlayer(camId, wsUrl, freshCanvas);
          }
        }
      }, 3000);
    }
  });

  // Attach error & close listeners directly to WebSocket instance
  if (player.source && player.source.socket) {
    player.source.socket.addEventListener('close', (e) => {
      if (!firstFrame && feedPlaying[camId]) {
        handleFeedCloseError(camId, e.code, e.reason);
      }
    });
    player.source.socket.addEventListener('error', () => {
      if (!firstFrame && feedPlaying[camId]) {
        handleFeedCloseError(camId, 4408, 'WebSocket network failure');
      }
    });
  }

  // Safety watchdog: if after 7.5 seconds no frame has decoded, trigger diagnostic check
  setTimeout(() => {
    if (!firstFrame && feedPlaying[camId]) {
      handleFeedCloseError(camId, 4408, 'Connection timed out (7s)');
    }
  }, 7500);

  // Start with audio muted
  player.volume = 0;
  players[camId] = player;
}

function destroyAllPlayers() {
  Object.values(players).forEach((p) => { try { p.destroy(); } catch (_) {} });
  players = {};
  audioActiveId = null;
  updateAutoWakeLock();
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
        nameEl.innerHTML = `<i class="fa-solid fa-video" style="margin-right:4px;opacity:.6"></i>${escapeHtml(newName.trim())}`;
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

    const g = parseInt(btn.dataset.grid, 10);
    currentPage = 1;

    if (g === 1) {
      pageSize = 1;
      grid.className = 'grid g1';
    } else if (g === 4) {
      pageSize = 4;
      grid.className = 'grid g2';
    } else if (g === 9) {
      pageSize = 9;
      grid.className = 'grid g3';
    } else {
      pageSize = 0; // All
      grid.className = 'grid g0';
    }

    renderGrid();
  });
});

// ── Fullscreen ────────────────────────────────────
window.toggleFS = function(id) {
  const card = document.getElementById(`card-${id}`);
  if (!card) return;
  const isFS = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement;
  if (!isFS) {
    if (card.requestFullscreen) {
      card.requestFullscreen().catch(console.warn);
    } else if (card.webkitRequestFullscreen) {
      card.webkitRequestFullscreen();
    } else if (card.mozRequestFullScreen) {
      card.mozRequestFullScreen();
    }
  } else {
    if (document.exitFullscreen) {
      document.exitFullscreen();
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    } else if (document.mozCancelFullScreen) {
      document.mozCancelFullScreen();
    }
  }
};

// ── Mobile Menu Dropdown ──────────────────────────
const mobileMenuBtn = document.getElementById('btn-mobile-menu');
const mobileMenu    = document.getElementById('mobile-menu');

function toggleMobileMenu(force) {
  if (!mobileMenu) return;
  const isHidden = mobileMenu.classList.contains('hidden');
  const shouldShow = (typeof force === 'boolean') ? force : isHidden;
  mobileMenu.classList.toggle('hidden', !shouldShow);
}

if (mobileMenuBtn) {
  mobileMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMobileMenu();
  });
}

document.addEventListener('click', (e) => {
  if (mobileMenu && !mobileMenu.contains(e.target) && (!mobileMenuBtn || !mobileMenuBtn.contains(e.target))) {
    toggleMobileMenu(false);
  }
});

const btnMAdd = document.getElementById('btn-m-add');
if (btnMAdd) {
  btnMAdd.addEventListener('click', () => {
    toggleMobileMenu(false);
    document.getElementById('btn-add').click();
  });
}

const btnMWake = document.getElementById('btn-m-wake');
if (btnMWake) {
  btnMWake.addEventListener('click', () => {
    toggleMobileMenu(false);
    document.getElementById('btn-wake').click();
  });
}

const btnMLogout = document.getElementById('btn-m-logout');
if (btnMLogout) {
  btnMLogout.addEventListener('click', () => {
    toggleMobileMenu(false);
    document.getElementById('btn-logout').click();
  });
}

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

// ── Digital Zoom & Pan Engine ─────────────────────
const zoomState = {}; // camId -> { scale, x, y, isPanning, startX, startY, initialDistance, initialScale, lastTap }

function getZoomState(id) {
  if (!zoomState[id]) {
    zoomState[id] = {
      scale: 1,
      x: 0,
      y: 0,
      isPanning: false,
      startX: 0,
      startY: 0,
      initialDistance: 0,
      initialScale: 1,
      lastTap: 0
    };
  }
  return zoomState[id];
}

function applyZoomTransform(id, animate = false) {
  const state = getZoomState(id);
  const card = document.getElementById(`card-${id}`);
  if (!card) return;
  const canvas = card.querySelector('canvas');
  const badge = document.getElementById(`zoom-badge-${id}`);
  const valEl = document.getElementById(`zoom-val-${id}`);

  // Clamp pan boundaries to keep video within card viewport
  const maxX = Math.max(0, ((state.scale - 1) * card.clientWidth) / 2);
  const maxY = Math.max(0, ((state.scale - 1) * card.clientHeight) / 2);
  state.x = Math.max(-maxX, Math.min(maxX, state.x));
  state.y = Math.max(-maxY, Math.min(maxY, state.y));

  if (canvas) {
    canvas.style.transition = animate ? 'transform 0.2s ease-out' : 'none';
    canvas.style.transformOrigin = 'center center';
    canvas.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
  }

  const isZoomed = state.scale > 1.05;
  card.classList.toggle('is-zoomed', isZoomed);

  if (badge) {
    badge.classList.toggle('hidden', !isZoomed);
  }
  if (valEl) {
    valEl.textContent = `${state.scale.toFixed(1)}x`;
  }
}

window.resetZoom = function(id) {
  const state = getZoomState(id);
  state.scale = 1;
  state.x = 0;
  state.y = 0;
  applyZoomTransform(id, true);
};

window.cycleZoom = function(id) {
  const state = getZoomState(id);
  if (state.scale < 1.8) {
    state.scale = 2.0;
  } else if (state.scale < 3.2) {
    state.scale = 3.5;
  } else {
    state.scale = 1.0;
    state.x = 0;
    state.y = 0;
  }
  applyZoomTransform(id, true);
};

function setupZoomAndPan(card, id) {
  const state = getZoomState(id);

  // Desktop Mouse Wheel Zoom (centered on cursor)
  card.addEventListener('wheel', (e) => {
    if (!feedPlaying[id]) return;
    e.preventDefault();

    const rect = card.getBoundingClientRect();
    const cursorX = e.clientX - (rect.left + rect.width / 2);
    const cursorY = e.clientY - (rect.top + rect.height / 2);

    const prevScale = state.scale;
    const factor = e.deltaY < 0 ? 1.25 : 0.8;
    const newScale = Math.min(5.0, Math.max(1.0, prevScale * factor));

    if (newScale === 1.0) {
      state.scale = 1.0;
      state.x = 0;
      state.y = 0;
    } else {
      const scaleChange = newScale / prevScale;
      state.x = cursorX - scaleChange * (cursorX - state.x);
      state.y = cursorY - scaleChange * (cursorY - state.y);
      state.scale = newScale;
    }

    applyZoomTransform(id, false);
  }, { passive: false });

  // Desktop Mouse Drag to Pan
  card.addEventListener('mousedown', (e) => {
    if (state.scale <= 1 || e.button !== 0) return;
    if (e.target.closest('.cam-bar') || e.target.closest('.zoom-badge')) return;

    state.isPanning = true;
    state.startX = e.clientX - state.x;
    state.startY = e.clientY - state.y;
    card.classList.add('is-panning');
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!state.isPanning) return;
    state.x = e.clientX - state.startX;
    state.y = e.clientY - state.startY;
    applyZoomTransform(id, false);
  });

  window.addEventListener('mouseup', () => {
    if (state.isPanning) {
      state.isPanning = false;
      card.classList.remove('is-panning');
    }
  });

  // Mobile Touch Gestures (Pinch to Zoom, Drag to Pan, Double-tap)
  card.addEventListener('touchstart', (e) => {
    if (e.target.closest('.cam-bar') || e.target.closest('.zoom-badge')) return;

    if (e.touches.length === 2) {
      state.initialDistance = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      state.initialScale = state.scale;
    } else if (e.touches.length === 1) {
      const now = Date.now();
      // Double tap detector
      if (now - state.lastTap < 320) {
        e.preventDefault();
        if (state.scale > 1.2) {
          resetZoom(id);
        } else {
          state.scale = 2.5;
          const rect = card.getBoundingClientRect();
          const tapX = e.touches[0].clientX - (rect.left + rect.width / 2);
          const tapY = e.touches[0].clientY - (rect.top + rect.height / 2);
          state.x = -tapX * 1.5;
          state.y = -tapY * 1.5;
          applyZoomTransform(id, true);
        }
        state.lastTap = 0;
        return;
      }
      state.lastTap = now;

      if (state.scale > 1) {
        state.isPanning = true;
        state.startX = e.touches[0].clientX - state.x;
        state.startY = e.touches[0].clientY - state.y;
      }
    }
  }, { passive: false });

  card.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && state.initialDistance > 0) {
      e.preventDefault();
      const currentDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const ratio = currentDist / state.initialDistance;
      state.scale = Math.min(5.0, Math.max(1.0, state.initialScale * ratio));
      if (state.scale === 1.0) {
        state.x = 0;
        state.y = 0;
      }
      applyZoomTransform(id, false);
    } else if (e.touches.length === 1 && state.isPanning && state.scale > 1) {
      e.preventDefault();
      state.x = e.touches[0].clientX - state.startX;
      state.y = e.touches[0].clientY - state.startY;
      applyZoomTransform(id, false);
    }
  }, { passive: false });

  card.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) {
      state.initialDistance = 0;
    }
    if (e.touches.length === 0) {
      state.isPanning = false;
      if (state.scale < 1.05) {
        resetZoom(id);
      }
    }
  });
}

// ── Automatic & Manual Screen Wake Lock ───────────
async function updateAutoWakeLock() {
  const isAnyPlaying = Object.values(feedPlaying).some(Boolean);
  try {
    if (isAnyPlaying && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      const btn = document.getElementById('btn-wake');
      if (btn) {
        btn.classList.add('active');
        btn.title = 'Screen awake (Auto)';
      }
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
        const b = document.getElementById('btn-wake');
        if (b && !Object.values(feedPlaying).some(Boolean)) b.classList.remove('active');
      });
    } else if (!isAnyPlaying && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
      const btn = document.getElementById('btn-wake');
      if (btn) btn.classList.remove('active');
    }
  } catch (err) {
    console.warn('Wake Lock error:', err.message);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    updateAutoWakeLock();
  }
});

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
      wakeLock = null;
      btn.classList.remove('active');
    }
  } catch (err) {
    console.warn('Wake Lock not supported:', err.message);
  }
});

// ── Secret Recordings Vault ───────────────────────
let activeRecordings = {}; // feedId -> { fileId, startTime, timer }
let vaultRecordings = [];

window.toggleRecord = async function(id) {
  if (activeRecordings[id]) {
    await stopRecord(id);
  } else {
    await startRecord(id);
  }
};

window.startRecord = async function(id) {
  try {
    const r = await apiFetch(`/api/recordings/${id}/start`, { method: 'POST' });
    if (r && r.success) {
      const startTime = r.recording.startTime || Date.now();
      activeRecordings[id] = {
        fileId: r.recording.fileId,
        startTime,
        timer: null
      };

      const btn = document.getElementById(`recbtn-${id}`);
      if (btn) {
        btn.classList.add('recording');
        btn.title = 'Stop Recording';
      }

      const badge = document.getElementById(`rec-badge-${id}`);
      if (badge) badge.classList.remove('hidden');

      activeRecordings[id].timer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
        const secs = String(elapsed % 60).padStart(2, '0');
        const timerEl = document.getElementById(`rec-timer-${id}`);
        if (timerEl) timerEl.textContent = `REC ${mins}:${secs}`;
      }, 1000);

      updateVaultBadges();
    } else {
      alert((r && r.message) || 'Failed to start recording');
    }
  } catch (err) {
    alert('Network error starting recording');
  }
};

window.stopRecord = async function(id) {
  const rec = activeRecordings[id];
  if (!rec) return;

  clearInterval(rec.timer);
  delete activeRecordings[id];

  const btn = document.getElementById(`recbtn-${id}`);
  if (btn) {
    btn.classList.remove('recording');
    btn.title = 'Start Secret Recording';
  }

  const badge = document.getElementById(`rec-badge-${id}`);
  if (badge) badge.classList.add('hidden');

  try {
    const r = await apiFetch(`/api/recordings/${id}/stop`, { method: 'POST' });
    if (r && r.success) {
      alert(`Recording saved to secret vault!\nDuration: ${r.file.duration}s\nSize: ${(r.file.size / (1024*1024)).toFixed(2)} MB`);
      await loadRecordingsList();
    } else {
      alert((r && r.message) || 'Error stopping recording');
    }
  } catch {
    alert('Error finalizing recording');
  }
  updateVaultBadges();
};

async function loadRecordingsList() {
  try {
    const r = await apiFetch('/api/recordings');
    if (r && r.success) {
      vaultRecordings = r.recordings || [];
      renderVaultList();
      updateVaultBadges();
    }
  } catch (_) {}
}

function updateVaultBadges() {
  const total = vaultRecordings.length + Object.keys(activeRecordings).length;
  const desk = document.getElementById('vault-badge-desk');
  const m = document.getElementById('vault-badge-m');
  if (desk) {
    desk.textContent = total;
    desk.classList.toggle('hidden', total === 0);
  }
  if (m) {
    m.textContent = total;
    m.classList.toggle('hidden', total === 0);
  }
}

function renderVaultList() {
  const listEl = document.getElementById('vault-list');
  const statusEl = document.getElementById('vault-status-text');
  if (!listEl) return;

  if (statusEl) {
    statusEl.textContent = `${vaultRecordings.length} clip(s) in vault`;
  }

  if (vaultRecordings.length === 0) {
    listEl.innerHTML = `
      <div class="vault-empty">
        <i class="fa-solid fa-shield-halved" style="font-size:32px;margin-bottom:8px;opacity:.4"></i>
        <p>No recordings stored in vault.</p>
        <p style="font-size:11px;margin-top:4px;opacity:.7">Click the red record button on any feed to capture footage.</p>
      </div>
    `;
    return;
  }

  listEl.innerHTML = vaultRecordings.map(rec => {
    const dateStr = new Date(rec.createdAt).toLocaleString();
    const sizeMB = (rec.size / (1024 * 1024)).toFixed(2);
    return `
      <div class="vault-item" id="vault-item-${rec.fileId}">
        <div class="vault-item-info">
          <span class="vault-item-name"><i class="fa-solid fa-file-video" style="margin-right:6px;color:#ef4444"></i>${escapeHtml(rec.feedName)}</span>
          <div class="vault-item-meta">
            <span><i class="fa-solid fa-calendar-day"></i> ${dateStr}</span>
            <span><i class="fa-solid fa-hard-drive"></i> ${sizeMB} MB</span>
          </div>
        </div>
        <div class="vault-item-actions">
          <button class="vault-btn-dl" onclick="downloadAndPurge('${rec.fileId}')" title="Download to device & auto-purge from PC">
            <i class="fa-solid fa-download"></i> Save & Purge
          </button>
          <button class="vault-btn-del" onclick="deleteVaultFile('${rec.fileId}')" title="Delete without downloading">
            <i class="fa-solid fa-trash"></i>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

window.downloadAndPurge = function(fileId) {
  const token = authToken ? `?token=${encodeURIComponent(authToken)}` : '';
  const downloadUrl = `/api/recordings/${encodeURIComponent(fileId)}/download${token}`;

  const a = document.createElement('a');
  a.href = downloadUrl;
  a.download = `${fileId}.mp4`;
  document.body.appendChild(a);
  a.click();
  a.remove();

  alert(`Downloading recording to your device...\n\nNotice: This footage will be automatically purged from the computer to keep your vault private.`);

  setTimeout(async () => {
    await loadRecordingsList();
  }, 2500);
};

window.deleteVaultFile = async function(fileId) {
  if (!confirm('Permanently delete this recording from the computer?')) return;
  try {
    const r = await apiFetch(`/api/recordings/${fileId}`, { method: 'DELETE' });
    if (r && r.success) {
      vaultRecordings = vaultRecordings.filter(f => f.fileId !== fileId);
      renderVaultList();
      updateVaultBadges();
    }
  } catch {
    alert('Failed to delete file');
  }
};

// Vault Modal Open / Close
const vaultModal = document.getElementById('vault-modal');
const btnVaultDesk = document.getElementById('btn-vault-desk');
const btnMVault = document.getElementById('btn-m-vault');
const btnVaultClose = document.getElementById('vault-close');
const btnVaultRefresh = document.getElementById('btn-vault-refresh');

function openVaultModal() {
  if (vaultModal) {
    vaultModal.classList.remove('hidden');
    loadRecordingsList();
  }
}
function closeVaultModal() {
  if (vaultModal) vaultModal.classList.add('hidden');
}

if (btnVaultDesk) btnVaultDesk.addEventListener('click', openVaultModal);
if (btnMVault) btnMVault.addEventListener('click', () => {
  toggleMobileMenu(false);
  openVaultModal();
});
if (btnVaultClose) btnVaultClose.addEventListener('click', closeVaultModal);
if (vaultModal) vaultModal.addEventListener('click', (e) => {
  if (e.target === vaultModal) closeVaultModal();
});
if (btnVaultRefresh) btnVaultRefresh.addEventListener('click', loadRecordingsList);

// ── Git Auto-Sync Status & Pull Controls ──────────
const deskSyncLabel = document.getElementById('desk-sync-label');
const mSyncLabel    = document.getElementById('m-sync-label');
const btnSyncDesk   = document.getElementById('btn-sync-desk');
const btnMSync      = document.getElementById('btn-m-sync');

let isSyncing = false;

async function checkGitSyncStatus(triggerPull = false) {
  try {
    if (triggerPull) {
      if (isSyncing) return;
      isSyncing = true;
      if (deskSyncLabel) deskSyncLabel.textContent = 'Pulling...';
      if (mSyncLabel) mSyncLabel.textContent = 'Pulling Updates...';

      const r = await apiFetch('/api/system/git-pull', { method: 'POST' });
      isSyncing = false;

      if (r && r.updated) {
        if (deskSyncLabel) deskSyncLabel.textContent = `Updated (${r.newCommit})`;
        if (mSyncLabel) mSyncLabel.textContent = `Updated (${r.newCommit})`;
        alert(`System successfully updated to commit ${r.newCommit}!\nStreaming Service is restarting now. The page will reload in 3 seconds.`);
        setTimeout(() => {
          window.location.reload();
        }, 3000);
      } else if (r && r.error) {
        alert(`Git pull check error:\n${r.error}`);
        if (deskSyncLabel) deskSyncLabel.textContent = 'Sync Error';
        if (mSyncLabel) mSyncLabel.textContent = 'Sync Error';
      } else {
        const commit = (r && (r.currentCommit || r.commit)) || 'synced';
        if (deskSyncLabel) deskSyncLabel.textContent = `Sync (${commit})`;
        if (mSyncLabel) mSyncLabel.textContent = `Synced (${commit})`;
        alert(`Your system is already up-to-date at commit [${commit}].`);
      }
    } else {
      const r = await apiFetch('/api/system/git-status');
      if (r && r.currentCommit && r.currentCommit !== 'unknown') {
        if (deskSyncLabel) deskSyncLabel.textContent = `Sync (${r.currentCommit})`;
        if (mSyncLabel) mSyncLabel.textContent = `Git Sync (${r.currentCommit})`;
      }
    }
  } catch (err) {
    isSyncing = false;
    console.warn('[Git-Sync] Status check failed:', err);
  }
}

if (btnSyncDesk) {
  btnSyncDesk.addEventListener('click', () => checkGitSyncStatus(true));
}
if (btnMSync) {
  btnMSync.addEventListener('click', () => {
    toggleMobileMenu(false);
    checkGitSyncStatus(true);
  });
}

// Check git status periodically every 60s
setInterval(() => {
  if (authToken) checkGitSyncStatus(false);
}, 60000);

// ── Server Node Cluster & Switcher Logic ──────────
const btnServerNode    = document.getElementById('btn-server-node');
const btnServerDesk    = document.getElementById('btn-server-desk');
const btnMServer       = document.getElementById('btn-m-server');
const serverModalClose = document.getElementById('server-modal-close');
const btnToggleStandby = document.getElementById('btn-toggle-standby');

function formatUptime(seconds) {
  if (!seconds || seconds <= 0) return 'Just started';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${seconds % 60}s`;
}

async function refreshNodeStatus() {
  try {
    const data = await apiFetch('/api/system/node');
    if (data && data.success) {
      currentNodeData = data;
      updateNodeUI(data);
    } else {
      updateNodeUI({ status: 'offline' });
    }
  } catch (err) {
    console.warn('[Cluster] Node status check failed:', err);
    updateNodeUI({ status: 'offline' });
  }
}

function updateNodeUI(node) {
  const labelEl   = document.getElementById('node-name-label');
  const osIconEl  = document.getElementById('node-os-icon');
  const mLabelEl  = document.getElementById('m-server-label');
  const deskLabel = document.getElementById('desk-server-label');
  const dotEl     = document.querySelector('.server-node-pill .node-dot');

  if (!node || node.status === 'offline') {
    if (labelEl) labelEl.textContent = 'Offline';
    if (mLabelEl) mLabelEl.textContent = 'Server: Offline';
    if (deskLabel) deskLabel.textContent = 'Offline';
    if (dotEl) dotEl.className = 'node-dot offline';
    return;
  }

  const isMac = node.platform === 'darwin';
  const isWin = node.platform === 'win32';
  const iconClass = isMac ? 'fa-brands fa-apple' : isWin ? 'fa-brands fa-windows' : 'fa-solid fa-server';

  if (osIconEl) osIconEl.className = iconClass;
  const shortName = isMac ? 'Mac Mini' : isWin ? 'Windows PC' : 'Server';
  if (labelEl) labelEl.textContent = shortName;
  if (mLabelEl) mLabelEl.textContent = `Server: ${shortName}`;
  if (deskLabel) deskLabel.textContent = shortName;

  if (dotEl) {
    dotEl.className = node.standbyMode ? 'node-dot standby' : 'node-dot';
  }

  // Update modal cards
  const titleEl    = document.getElementById('active-node-title');
  const subEl      = document.getElementById('active-node-sub');
  const iconBox    = document.getElementById('active-node-icon');
  const platChip   = document.getElementById('chip-platform');
  const upChip     = document.getElementById('chip-uptime');
  const strChip    = document.getElementById('chip-streams');
  const comChip    = document.getElementById('chip-commit');
  const standbyTag = document.getElementById('node-standby-badge');
  const standbyBtn = document.getElementById('btn-toggle-standby');

  if (titleEl) titleEl.textContent = `${node.nodeType || shortName} — ${node.hostname}`;
  if (subEl) {
    const ipStr = (node.localIps && node.localIps.length) ? node.localIps.join(', ') : '127.0.0.1';
    subEl.textContent = `Local IP: ${ipStr} • Port 3000 • High-Availability Active`;
  }
  if (iconBox) iconBox.innerHTML = `<i class="${iconClass}"></i>`;
  if (platChip) platChip.innerHTML = `<i class="fa-solid fa-microchip"></i> ${node.platformLabel || node.platform} (${node.arch || ''})`;
  if (upChip) upChip.innerHTML = `<i class="fa-regular fa-clock"></i> ${formatUptime(node.uptime)}`;
  if (strChip) strChip.innerHTML = `<i class="fa-solid fa-tower-broadcast"></i> ${node.activeStreams || 0} Live Feeds`;
  if (comChip) comChip.innerHTML = `<i class="fa-solid fa-code-branch"></i> ${node.gitCommit || 'HEAD'}`;

  if (standbyTag) {
    standbyTag.classList.toggle('hidden', !node.standbyMode);
  }

  if (standbyBtn) {
    if (node.standbyMode) {
      standbyBtn.className = 'btn-secondary sm-btn active-standby';
      standbyBtn.innerHTML = '<i class="fa-solid fa-play"></i> Resume Active Live Traffic';
    } else {
      standbyBtn.className = 'btn-secondary sm-btn';
      standbyBtn.innerHTML = '<i class="fa-solid fa-arrow-right-arrow-left"></i> Shift Traffic to Peer Node';
    }
  }
}

function openServerModal() {
  if (!serverModal) return;
  // Initialize input fields with stored values
  const inputMac = document.getElementById('input-mac-url');
  const inputWin = document.getElementById('input-win-url');
  const inputCust = document.getElementById('input-custom-url');
  if (inputMac) inputMac.value = macServerUrl;
  if (inputWin) inputWin.value = winServerUrl;
  if (inputCust) inputCust.value = customServerUrl;

  // Highlight active target card
  document.querySelectorAll('.server-card').forEach(card => {
    const target = card.getAttribute('data-target');
    const isCurrent = (target === activeServerTarget);
    card.classList.toggle('active', isCurrent);
    const tag = card.querySelector('.current-tag');
    if (tag) tag.classList.toggle('hidden', !isCurrent);
  });

  serverModal.classList.remove('hidden');
  refreshNodeStatus();
}

function closeServerModal() {
  if (serverModal) serverModal.classList.add('hidden');
}

function applyServerTarget(target) {
  activeServerTarget = target;
  localStorage.setItem('stream_server_target', target);

  // Update active state in modal
  document.querySelectorAll('.server-card').forEach(card => {
    const isCurrent = card.getAttribute('data-target') === target;
    card.classList.toggle('active', isCurrent);
    const tag = card.querySelector('.current-tag');
    if (tag) tag.classList.toggle('hidden', !isCurrent);
  });

  // Re-fetch feeds and reconnect any active feeds
  refreshNodeStatus();
  loadFeeds();

  // Re-init any active video players
  Object.keys(players).forEach(id => {
    if (feedPlaying[id]) {
      const q = feedQuality[id] || 'sd';
      playFeed(id, q);
    }
  });
}

async function pingUrl(url, badgeId) {
  const badge = document.getElementById(badgeId);
  if (!badge) return;
  badge.className = 'ping-badge';
  badge.textContent = 'Testing...';
  const start = Date.now();
  try {
    const clean = url.replace(/\/+$/, '') + '/api/health';
    const res = await fetch(clean, { cache: 'no-store' });
    const elapsed = Date.now() - start;
    if (res.ok) {
      badge.className = 'ping-badge online';
      badge.textContent = `🟢 ${elapsed}ms`;
    } else {
      badge.className = 'ping-badge error';
      badge.textContent = `🔴 HTTP ${res.status}`;
    }
  } catch (_) {
    badge.className = 'ping-badge error';
    badge.textContent = '🔴 Offline';
  }
}

// Bind server switcher UI events
if (btnServerNode) btnServerNode.addEventListener('click', openServerModal);
if (btnServerDesk) btnServerDesk.addEventListener('click', openServerModal);
if (btnMServer) {
  btnMServer.addEventListener('click', () => {
    toggleMobileMenu(false);
    openServerModal();
  });
}
if (serverModalClose) serverModalClose.addEventListener('click', closeServerModal);
if (serverModal) {
  serverModal.addEventListener('click', (e) => {
    if (e.target === serverModal) closeServerModal();
  });
}

// Target switch buttons
document.querySelectorAll('.btn-switch-node').forEach(btn => {
  btn.addEventListener('click', (e) => {
    const target = e.currentTarget.getAttribute('data-target');
    applyServerTarget(target);
  });
});

// Input field storage
const inputMac = document.getElementById('input-mac-url');
const inputWin = document.getElementById('input-win-url');
const inputCust = document.getElementById('input-custom-url');

if (inputMac) {
  inputMac.addEventListener('change', (e) => {
    macServerUrl = e.target.value.trim();
    localStorage.setItem('stream_mac_url', macServerUrl);
  });
}
if (inputWin) {
  inputWin.addEventListener('change', (e) => {
    winServerUrl = e.target.value.trim();
    localStorage.setItem('stream_win_url', winServerUrl);
  });
}
if (inputCust) {
  inputCust.addEventListener('change', (e) => {
    customServerUrl = e.target.value.trim();
    localStorage.setItem('stream_custom_url', customServerUrl);
  });
}

// Ping buttons
const btnPingMac = document.getElementById('btn-ping-mac');
const btnPingWin = document.getElementById('btn-ping-win');
const btnPingCust = document.getElementById('btn-ping-custom');

if (btnPingMac) {
  btnPingMac.addEventListener('click', () => {
    const url = (inputMac && inputMac.value.trim()) || macServerUrl;
    pingUrl(url, 'ping-res-mac');
  });
}
if (btnPingWin) {
  btnPingWin.addEventListener('click', () => {
    const url = (inputWin && inputWin.value.trim()) || winServerUrl;
    pingUrl(url, 'ping-res-win');
  });
}
if (btnPingCust) {
  btnPingCust.addEventListener('click', () => {
    const url = (inputCust && inputCust.value.trim()) || customServerUrl;
    if (!url) {
      alert('Please enter a server URL to ping.');
      return;
    }
    pingUrl(url, 'ping-res-custom');
  });
}

// Toggle Standby button
if (btnToggleStandby) {
  btnToggleStandby.addEventListener('click', async () => {
    if (!currentNodeData) return;
    const newStandby = !currentNodeData.standbyMode;
    try {
      const res = await apiFetch('/api/system/node-mode', {
        method: 'POST',
        body: { standby: newStandby }
      });
      if (res && res.success) {
        currentNodeData.standbyMode = res.standbyMode;
        updateNodeUI(currentNodeData);
        alert(newStandby ?
          'This node is now in STANDBY mode.\nLive stream traffic will automatically route to your peer backup node!' :
          'This node has RESUMED active live traffic!'
        );
      }
    } catch (err) {
      alert(`Failed to toggle standby mode: ${err.message}`);
    }
  });
}

// Poll server node status every 15s
setInterval(() => {
  if (authToken) refreshNodeStatus();
}, 15000);

// ── Init ──────────────────────────────────────────
checkAuth();


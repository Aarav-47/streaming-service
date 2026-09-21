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
          <div class="quality-toggle" title="Stream Quality">
            <button class="q-btn ${q === 'sd' ? 'active' : ''}" id="qsd-${cam.id}" onclick="setFeedQuality('${cam.id}', 'sd')">SD</button>
            <button class="q-btn ${q === 'hd' ? 'active' : ''}" id="qhd-${cam.id}" onclick="setFeedQuality('${cam.id}', 'hd')">HD</button>
          </div>
          <button class="cam-btn play-btn ${isPlaying ? 'playing' : ''}" id="playbtn-${cam.id}" title="${isPlaying ? 'Stop Feed' : 'Start Feed'}" onclick="toggleFeedPlay('${cam.id}')">
            <i class="fa-solid ${isPlaying ? 'fa-stop' : 'fa-play'}"></i>
          </button>
          <button class="cam-btn move-btn" title="Move Left" onclick="moveFeed('${cam.id}', -1)">
            <i class="fa-solid fa-arrow-left"></i>
          </button>
          <button class="cam-btn move-btn" title="Move Right" onclick="moveFeed('${cam.id}', 1)">
            <i class="fa-solid fa-arrow-right"></i>
          </button>
          <button class="cam-btn audio-btn" id="audio-${cam.id}" title="Unmute Audio" onclick="toggleAudio('${cam.id}')">
            <i class="fa-solid fa-volume-xmark"></i>
          </button>
          <button class="cam-btn rename-btn" title="Rename Feed" onclick="renameFeed('${cam.id}')">
            <i class="fa-solid fa-pen"></i>
          </button>
          <button class="cam-btn fs-btn" title="Fullscreen" onclick="toggleFS('${cam.id}')">
            <i class="fa-solid fa-expand"></i>
          </button>
          <button class="cam-btn del" title="Remove" onclick="removeCam('${cam.id}')">
            <i class="fa-solid fa-trash"></i>
          </button>
        </div>
      </div>
      <div class="cam-overlay ${isPlaying ? 'hidden' : ''}" id="overlay-${cam.id}" onclick="startFeed('${cam.id}')">
        <div class="play-circle"><i class="fa-solid fa-play"></i></div>
        <span class="overlay-label">Click to Open Feed</span>
      </div>
    `;
    card.appendChild(canvas);
    grid.appendChild(card);

    setupDragAndDrop(card);

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
  return newCanvas;
}

// ── On-Demand Stream Management ───────────────────
window.startFeed = function(id) {
  feedPlaying[id] = true;
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

  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl   = `${wsProto}://${location.host}/stream?id=${encodeURIComponent(id)}&quality=${q}&token=${encodeURIComponent(authToken)}`;

  initPlayer(id, wsUrl, canvas);
  updatePlayAllBtn();
};

window.stopFeed = function(id) {
  feedPlaying[id] = false;

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

window.setFeedQuality = function(id, quality) {
  feedQuality[id] = quality;
  const qsd = document.getElementById(`qsd-${id}`);
  const qhd = document.getElementById(`qhd-${id}`);
  if (qsd && qhd) {
    qsd.classList.toggle('active', quality === 'sd');
    qhd.classList.toggle('active', quality === 'hd');
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

// ── Init ──────────────────────────────────────────
checkAuth();


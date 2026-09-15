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

// ── On-Demand Stream Management ───────────────────
window.startFeed = function(id) {
  feedPlaying[id] = true;
  const q = feedQuality[id] || 'sd';

  const overlay = document.getElementById(`overlay-${id}`);
  if (overlay) overlay.classList.add('hidden');

  const playBtn = document.getElementById(`playbtn-${id}`);
  if (playBtn) {
    playBtn.innerHTML = '<i class="fa-solid fa-stop"></i>';
    playBtn.title = 'Stop Feed';
    playBtn.classList.add('playing');
  }

  const card = document.getElementById(`card-${id}`);
  if (!card) return;
  const canvas = card.querySelector('canvas');
  if (!canvas) return;

  if (players[id]) {
    try { players[id].destroy(); } catch (_) {}
    delete players[id];
  }

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

  const overlay = document.getElementById(`overlay-${id}`);
  if (overlay) overlay.classList.remove('hidden');

  const playBtn = document.getElementById(`playbtn-${id}`);
  if (playBtn) {
    playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
    playBtn.title = 'Start Feed';
    playBtn.classList.remove('playing');
  }

  const card = document.getElementById(`card-${id}`);
  if (card) {
    const canvas = card.querySelector('canvas');
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
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

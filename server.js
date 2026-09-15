'use strict';

// ============================================================
// Streaming Service v2 — Custom Node.js RTSP WebSocket Engine
// No go2rtc. FFmpeg handles RTSP -> MPEG1 piped to WebSockets.
// ============================================================

const fs          = require('fs');
const path        = require('path');
const http        = require('http');
const { spawn }   = require('child_process');
const express     = require('express');
const WebSocket   = require('ws');
const jwt         = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const cors        = require('cors');

// ── Configuration ────────────────────────────────────────────
const PORT          = parseInt(process.env.PORT  || '3000', 10);
const JWT_SECRET    = process.env.JWT_SECRET     || 'streaming_secure_jwt_2026_hhd';
const ADMIN_USER    = process.env.ADMIN_USER     || 'admin';
const ADMIN_PASS    = process.env.ADMIN_PASS     || 'admin@123';
const FEEDS_FILE  = path.join(__dirname, 'feeds.json');

// FFmpeg binary: auto-detected from ./ffmpeg/bin/ffmpeg.exe (Windows)
// or system PATH on Linux/Mac
const FFMPEG_BIN = (() => {
  const local = path.join(__dirname, 'ffmpeg', 'bin', 'ffmpeg.exe');
  if (fs.existsSync(local)) return local;
  const localMac = path.join(__dirname, 'ffmpeg', 'ffmpeg');
  if (fs.existsSync(localMac)) return localMac;
  return 'ffmpeg'; // fall back to system PATH
})();

console.log(`[Stream Engine] FFmpeg binary: ${FFMPEG_BIN}`);

// ── Feed Config Helpers ────────────────────────────────────
function getFeeds() {
  try {
    if (!fs.existsSync(FEEDS_FILE)) return [];
    const raw = fs.readFileSync(FEEDS_FILE, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch (e) {
    console.error('[Config] Error reading feeds.json:', e.message);
    return [];
  }
}

function saveFeeds(feeds) {
  fs.writeFileSync(FEEDS_FILE, JSON.stringify(feeds, null, 2), 'utf8');
}

// ── Per-Stream WebSocket Broadcaster ────────────────────────
// streamSessions holds all active FFmpeg processes and their subscriber sets
const streamSessions = new Map();
// { camId -> { ffmpegProc, clients: Set<WebSocket>, header: Buffer|null } }

function getOrCreateStream(cam) {
  if (streamSessions.has(cam.id)) {
    return streamSessions.get(cam.id);
  }

  console.log(`[Stream] Starting FFmpeg for [${cam.id}] -> ${cam.ip}`);

  const session = { ffmpegProc: null, clients: new Set(), header: null };
  streamSessions.set(cam.id, session);

  // FFmpeg: RTSP -> MPEG1 video + MP2 audio piped to stdout
  const args = [
    '-loglevel', 'error',
    '-hwaccel', 'auto',
    '-threads', '1',
    '-reorder_queue_size', '4000',
    '-rtsp_transport', 'tcp',
    '-fflags', '+nobuffer+genpts',
    '-flags', 'low_delay',
    '-i', cam.url,
    '-f', 'mpegts',
    '-codec:v', 'mpeg1video',
    '-s', '640x360',
    '-b:v', '600k',
    '-r', '20',
    '-bf', '0',
    '-codec:a', 'mp2',
    '-b:a', '96k',
    '-ar', '44100',
    '-ac', '1',
    '-muxdelay', '0.001',
    'pipe:1'
  ];

  const ffmpeg = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  session.ffmpegProc = ffmpeg;

  ffmpeg.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.error(`[FFmpeg ${cam.id}]`, msg);
  });

  ffmpeg.stdout.on('data', (chunk) => {
    // Store first chunk as stream header for reconnecting clients
    if (!session.header) session.header = chunk;

    // Broadcast raw MPEG1 chunks to all connected WebSocket clients
    session.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(chunk, { binary: true }, (err) => {
          if (err) session.clients.delete(ws);
        });
      }
    });
  });

  ffmpeg.on('exit', (code) => {
    console.log(`[Stream] FFmpeg exited for [${cam.id}] (code ${code})`);
    streamSessions.delete(cam.id);
    // Notify all connected clients that stream ended
    session.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) ws.close();
    });
  });

  ffmpeg.on('error', (err) => {
    console.error(`[Stream] FFmpeg error for [${cam.id}]:`, err.message);
    streamSessions.delete(cam.id);
  });

  return session;
}

function stopStreamIfEmpty(camId) {
  const session = streamSessions.get(camId);
  if (!session) return;
  if (session.clients.size === 0) {
    console.log(`[Stream] No viewers left for [${camId}], stopping FFmpeg.`);
    if (session.ffmpegProc) {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(session.ffmpegProc.pid), '/f', '/t'], { stdio: 'ignore' });
      } else {
        try { session.ffmpegProc.kill('SIGKILL'); } catch (_) {}
      }
    }
    streamSessions.delete(camId);
  }
}

// ── Express App ──────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(cookieParser());

// ── Auth Helpers ─────────────────────────────────────────────
function signToken(user) {
  return jwt.sign({ user }, JWT_SECRET, { expiresIn: '30d' });
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch (_) { return null; }
}

function getTokenFromReq(req) {
  return (
    req.cookies.stream_auth ||
    (req.headers.authorization && req.headers.authorization.replace('Bearer ', '')) ||
    req.query.token || // allow ?token=xxx for WebSocket upgrade requests
    null
  );
}

function authMiddleware(req, res, next) {
  const token = getTokenFromReq(req);
  if (!token || !verifyToken(token)) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }
  next();
}

// ── Auth Routes ───────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = signToken(username);
    res.cookie('stream_auth', token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000
    });
    return res.json({ success: true, token, user: username });
  }
  res.status(401).json({ success: false, message: 'Invalid username or password' });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('stream_auth');
  res.json({ success: true });
});

app.get('/api/auth/check', (req, res) => {
  const token = getTokenFromReq(req);
  const decoded = verifyToken(token);
  res.json({ authenticated: !!decoded, user: decoded?.user || null });
});

// ── Feed CRUD Routes ────────────────────────────────────────
app.get('/api/feeds', authMiddleware, (req, res) => {
  const feeds = getFeeds().map(({ id, name, ip, port, channel, subtype }) => ({
    id, name, ip, port, channel, subtype
  }));
  res.json({ success: true, feeds });
});

app.post('/api/feeds', authMiddleware, (req, res) => {
  const { name, ip, port = 554, username = 'admin', password = '', channel = 1, subtype = 0 } = req.body || {};
  if (!name || !ip) {
    return res.status(400).json({ success: false, message: 'Name and IP are required' });
  }
  const encodedPass = encodeURIComponent(password);
  const id          = `feed_${ip.split('.').pop()}_${Date.now().toString().slice(-5)}`;
  const url         = `rtsp://${username}:${encodedPass}@${ip}:${port}/cam/realmonitor?channel=${channel}&subtype=${subtype}`;
  const newCam      = { id, name, ip, port, username, password, channel, subtype, url };
  const feeds     = getFeeds();
  feeds.push(newCam);
  saveFeeds(feeds);
  res.json({ success: true, feed: { id, name, ip } });
});

app.put('/api/feeds/:id', authMiddleware, (req, res) => {
  const feeds = getFeeds();
  const idx     = feeds.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Feed not found' });
  const { name, ip, port = 554, username = 'admin', password = '', channel = 1, subtype = 0 } = req.body || {};
  const encodedPass = encodeURIComponent(password || feeds[idx].password);
  feeds[idx] = {
    ...feeds[idx], name: name || feeds[idx].name,
    ip: ip || feeds[idx].ip, port, username, channel, subtype,
    password: password || feeds[idx].password,
    url: `rtsp://${username}:${encodedPass}@${ip || feeds[idx].ip}:${port}/cam/realmonitor?channel=${channel}&subtype=${subtype}`
  };
  saveFeeds(feeds);
  // Kill existing stream so it reconnects with new config
  const session = streamSessions.get(req.params.id);
  if (session) {
    try { session.ffmpegProc.kill('SIGKILL'); } catch (_) {}
    streamSessions.delete(req.params.id);
  }
  res.json({ success: true });
});

app.patch('/api/feeds/:id/rename', authMiddleware, (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ success: false, message: 'Name is required' });
  }
  const feeds = getFeeds();
  const idx = feeds.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Feed not found' });
  feeds[idx].name = name.trim();
  saveFeeds(feeds);
  res.json({ success: true, name: feeds[idx].name });
});

app.post('/api/feeds/reorder', authMiddleware, (req, res) => {
  const { orderedIds } = req.body || {};
  if (!Array.isArray(orderedIds)) {
    return res.status(400).json({ success: false, message: 'orderedIds array required' });
  }
  const feeds = getFeeds();
  const feedMap = new Map(feeds.map(f => [f.id, f]));
  const reordered = [];
  for (const id of orderedIds) {
    if (feedMap.has(id)) {
      reordered.push(feedMap.get(id));
      feedMap.delete(id);
    }
  }
  for (const f of feedMap.values()) {
    reordered.push(f);
  }
  saveFeeds(reordered);
  res.json({ success: true, count: reordered.length });
});

app.delete('/api/feeds/:id', authMiddleware, (req, res) => {
  const feeds = getFeeds().filter(c => c.id !== req.params.id);
  saveFeeds(feeds);
  const session = streamSessions.get(req.params.id);
  if (session) {
    try { session.ffmpegProc.kill('SIGKILL'); } catch (_) {}
    streamSessions.delete(req.params.id);
  }
  res.json({ success: true });
});

// ── Health Check ──────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    activeStreams: streamSessions.size,
    totalFeeds: getFeeds().length,
    uptime: Math.round(process.uptime())
  });
});

// ── Static Frontend ───────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── HTTP Server + WebSocket Server ───────────────────────────
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, path: '/stream' });

wss.on('connection', (ws, req) => {
  // Extract cam ID and auth token from query string
  // e.g. ws://localhost:3000/stream?id=feed_25&token=eyJ...
  const urlParams = new URLSearchParams(req.url.replace('/stream', '').replace('?', ''));
  const camId     = urlParams.get('id');
  const token     = urlParams.get('token') ||
                    (req.headers.cookie || '').split(';').reduce((acc, c) => {
                      const [k, v] = c.trim().split('=');
                      return k === 'stream_auth' ? v : acc;
                    }, null);

  // Authenticate the WebSocket connection
  if (!token || !verifyToken(token)) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  if (!camId) {
    ws.close(4002, 'No feed ID specified');
    return;
  }

  const feeds = getFeeds();
  const cam     = feeds.find(c => c.id === camId);
  if (!cam) {
    ws.close(4004, `Feed ${camId} not found`);
    return;
  }

  console.log(`[WS] Client connected to stream: [${camId}]`);

  const session = getOrCreateStream(cam);
  session.clients.add(ws);

  // Send buffered header so JSMpeg can decode immediately
  if (session.header && ws.readyState === WebSocket.OPEN) {
    ws.send(session.header, { binary: true });
  }

  ws.on('close', () => {
    session.clients.delete(ws);
    console.log(`[WS] Client disconnected from [${camId}]. Viewers: ${session.clients.size}`);
    // Delay stop to allow quick reconnects (e.g. page refresh)
    setTimeout(() => stopStreamIfEmpty(camId), 5000);
  });

  ws.on('error', () => session.clients.delete(ws));
});

// ── Start Server ──────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log('═══════════════════════════════════════════════');
  console.log('  Streaming Service v2 Ready!');
  console.log(`  Local:      http://localhost:${PORT}`);
  console.log(`  Stream URL: ws://localhost:${PORT}/stream?id=<camId>&token=<jwt>`);
  console.log(`  Login:      ${ADMIN_USER} / ${ADMIN_PASS}`);
  console.log('═══════════════════════════════════════════════');
});

// Graceful shutdown: kill all FFmpeg processes
function cleanupAll() {
  console.log('[Server] Shutting down — killing all FFmpeg processes...');
  streamSessions.forEach((s) => {
    if (s.ffmpegProc) {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(s.ffmpegProc.pid), '/f', '/t'], { stdio: 'ignore' });
      } else {
        try { s.ffmpegProc.kill('SIGKILL'); } catch (_) {}
      }
    }
  });
}
process.on('SIGTERM', () => { cleanupAll(); process.exit(0); });
process.on('SIGINT', () => { cleanupAll(); process.exit(0); });

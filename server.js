'use strict';

// ============================================================
// Streaming Service v2 — Custom Node.js RTSP WebSocket Engine
// No go2rtc. FFmpeg handles RTSP -> MPEG1 piped to WebSockets.
// ============================================================

const fs          = require('fs');
const os          = require('os');
const path        = require('path');
const http        = require('http');
const net         = require('net');
const { spawn, exec, execSync } = require('child_process');
const util        = require('util');
const execPromise = util.promisify(exec);
const express     = require('express');
const WebSocket   = require('ws');
const jwt         = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const cors        = require('cors');

// ── Cluster & Node State ─────────────────────────────────────
let nodeStandbyMode = false;

function getLocalIps() {
  try {
    const nets = os.networkInterfaces();
    const results = [];
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          results.push(net.address);
        }
      }
    }
    return results;
  } catch (_) {
    return [];
  }
}

// ── Diagnostics & Status Tracking ────────────────────────────
const feedStatusCache = new Map(); // id -> { status, code, short, message, timestamp }

// ── Configuration ────────────────────────────────────────────
const PORT          = parseInt(process.env.PORT  || '3000', 10);
const JWT_SECRET    = process.env.JWT_SECRET     || 'streaming_secure_jwt_2026_hhd';
const ADMIN_USER    = process.env.ADMIN_USER     || 'admin';
const ADMIN_PASS    = process.env.ADMIN_PASS     || 'Aarav@2000';
const FEEDS_FILE  = path.join(__dirname, 'feeds.json');

// FFmpeg binary: auto-detected across Windows, macOS (Apple Silicon/Intel), Linux, WinGet, Chocolatey
const FFMPEG_BIN = (() => {
  const candidates = [
    path.join(__dirname, 'ffmpeg', 'bin', 'ffmpeg.exe'),
    path.join(__dirname, 'ffmpeg', 'ffmpeg'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
    path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'chocolatey', 'bin', 'ffmpeg.exe'),
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\ffmpeg\\ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg'
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return 'ffmpeg'; // fall back to system PATH
})();

console.log(`[Stream Engine] FFmpeg binary: ${FFMPEG_BIN}`);

function killProcess(proc) {
  if (!proc || !proc.pid) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], { stdio: 'ignore' }); } catch (_) {}
  } else {
    try { proc.kill('SIGKILL'); } catch (_) {}
  }
}

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
// { sessionKey -> { ffmpegProc, clients: Set<WebSocket>, header: Buffer|null } }

function classifyFFmpegError(code, stderrLogs, cam) {
  const combined = stderrLogs.join('\n');

  if (/401\s*Unauthorized|Unauthorized|Authentication\s*failed|DESCRIBE\s*failed:\s*401/i.test(combined)) {
    return {
      status: 'auth_error',
      code: 4401,
      short: 'Auth Error',
      message: `Invalid username or password for feed (${cam.username || 'admin'})`
    };
  }

  if (/Connection\s*timed\s*out|No\s*route\s*to\s*host|Connection\s*refused|Network\s*is\s*unreachable|Host\s*is\s*down|Immediate\s*exit\s*requested/i.test(combined)) {
    return {
      status: 'offline',
      code: 4408,
      short: 'Feed Offline',
      message: `Feed is offline or unreachable at ${cam.ip}:${cam.port || 554}`
    };
  }

  if (/404\s*Not\s*Found|Stream\s*not\s*found|DESCRIBE\s*failed:\s*404/i.test(combined)) {
    return {
      status: 'not_found',
      code: 4404,
      short: 'Stream Not Found',
      message: `RTSP stream or channel not found at ${cam.ip}`
    };
  }

  if (code === 3199971767 || /Invalid\s*data\s*found/i.test(combined)) {
    return {
      status: 'invalid_data',
      code: 4501,
      short: 'Stream Error',
      message: `Feed returned invalid or unsupported video data`
    };
  }

  return {
    status: 'error',
    code: 4500,
    short: 'Feed Error',
    message: combined.trim().split('\n').filter(Boolean).pop() || `Stream disconnected (code ${code})`
  };
}

function getOrCreateStream(cam, quality = 'sd') {
  const isHD = (quality.toLowerCase() === 'hd');
  const qKey = isHD ? 'hd' : 'sd';
  const sessionKey = `${cam.id}_${qKey}`;

  if (streamSessions.has(sessionKey)) {
    return streamSessions.get(sessionKey);
  }

  // Use cam.url directly (which has confirmed working stream format)
  const targetUrl = cam.url;
  console.log(`[Stream] Starting FFmpeg [${qKey.toUpperCase()}] for [${cam.id}] -> ${cam.ip}`);

  const session = {
    ffmpegProc: null,
    clients: new Set(),
    header: null,
    startedAt: Date.now(),
    framesReceived: 0,
    stderrLogs: []
  };
  streamSessions.set(sessionKey, session);

  // FFmpeg parameters (pure CPU software decoding - rock solid in Windows Service):
  // SD: 640x360, 500k bitrate, 20 fps, 1 thread (ultralight, ~2% CPU)
  // HD: Native 1080p, 1500k bitrate, 25 fps, 2 threads (full crystal clear)
  const args = [
    '-loglevel', 'error',
    '-threads', isHD ? '2' : '1',
    '-reorder_queue_size', '4000',
    '-rtsp_transport', 'tcp',
    '-fflags', '+nobuffer+genpts',
    '-flags', 'low_delay',
    '-i', targetUrl,
    '-f', 'mpegts',
    '-codec:v', 'mpeg1video',
    ...(isHD ? ['-b:v', '1500k', '-r', '25'] : ['-s', '640x360', '-b:v', '500k', '-r', '20']),
    '-bf', '0',
    '-codec:a', 'mp2',
    '-b:a', isHD ? '128k' : '64k',
    '-ar', '44100',
    '-ac', '1',
    '-muxdelay', '0.001',
    'pipe:1'
  ];

  const ffmpeg = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  session.ffmpegProc = ffmpeg;

  ffmpeg.stderr.on('data', (d) => {
    const msg = d.toString();
    session.stderrLogs.push(msg);
    if (session.stderrLogs.length > 30) session.stderrLogs.shift();
    const trimmed = msg.trim();
    if (trimmed) console.error(`[FFmpeg ${sessionKey}]`, trimmed);
  });

  ffmpeg.stdout.on('data', (chunk) => {
    session.framesReceived++;
    feedStatusCache.set(cam.id, {
      status: 'online',
      code: 200,
      short: 'Online',
      message: 'Streaming Live',
      timestamp: Date.now()
    });
    if (!session.header) session.header = chunk;
    session.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(chunk, { binary: true }, (err) => {
          if (err) session.clients.delete(ws);
        });
      }
    });
  });

  ffmpeg.on('exit', (code) => {
    console.log(`[Stream] FFmpeg exited for [${sessionKey}] (code ${code})`);
    
    let errorDetail = null;
    if (code !== 0 && code !== null) {
      errorDetail = classifyFFmpegError(code, session.stderrLogs, cam);
      feedStatusCache.set(cam.id, {
        status: errorDetail.status,
        code: errorDetail.code,
        short: errorDetail.short,
        message: errorDetail.message,
        timestamp: Date.now()
      });
      console.warn(`[Stream Error] Classified error for [${cam.id}]: ${errorDetail.short} (${errorDetail.message})`);
    }

    streamSessions.delete(sessionKey);
    session.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        if (errorDetail) {
          ws.close(errorDetail.code, errorDetail.message.slice(0, 120));
        } else {
          ws.close(1000, 'Stream finished');
        }
      }
    });
  });

  ffmpeg.on('error', (err) => {
    console.error(`[Stream] FFmpeg error for [${sessionKey}]:`, err.message);
    const errorDetail = {
      status: 'offline',
      code: 4408,
      short: 'Offline',
      message: `Failed to launch stream: ${err.message}`
    };
    feedStatusCache.set(cam.id, { ...errorDetail, timestamp: Date.now() });
    streamSessions.delete(sessionKey);
    session.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(4408, errorDetail.message.slice(0, 120));
      }
    });
  });

  return session;
}

function stopStreamIfEmpty(sessionKey) {
  const session = streamSessions.get(sessionKey);
  if (!session) return;
  if (session.clients.size === 0) {
    console.log(`[Stream] No viewers left for [${sessionKey}], stopping FFmpeg.`);
    killProcess(session.ffmpegProc);
    streamSessions.delete(sessionKey);
  }
}

// ── Express App ──────────────────────────────────────────────
const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// Server Node Identification & Standby Handler
app.use((req, res, next) => {
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  const nodeType = isMac ? 'Mac Mini' : isWin ? 'Windows PC' : 'Server';
  res.setHeader('X-Stream-Node', `${nodeType} (${os.hostname()})`);
  res.setHeader('X-Stream-Platform', process.platform);

  if (nodeStandbyMode && req.path === '/api/health') {
    return res.status(503).json({ success: false, status: 'standby', message: 'Node is in standby mode' });
  }
  next();
});

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
    killProcess(session.ffmpegProc);
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
    killProcess(session.ffmpegProc);
    streamSessions.delete(req.params.id);
  }
  res.json({ success: true });
});

// ── TCP Reachability Probe ────────────────────────────────────
function checkFeedReachability(ip, port = 554, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let isResolved = false;

    socket.setTimeout(timeoutMs);

    socket.on('connect', () => {
      if (!isResolved) {
        isResolved = true;
        socket.destroy();
        resolve({ reachable: true, reason: 'Connected' });
      }
    });

    socket.on('timeout', () => {
      if (!isResolved) {
        isResolved = true;
        socket.destroy();
        resolve({ reachable: false, reason: 'Connection timed out' });
      }
    });

    socket.on('error', (err) => {
      if (!isResolved) {
        isResolved = true;
        socket.destroy();
        resolve({ reachable: false, reason: err.message || 'Connection refused' });
      }
    });

    socket.connect(port, ip);
  });
}

// ── Feed Status & Diagnostics Routes ──────────────────────────
app.get('/api/feeds/:id/check', authMiddleware, async (req, res) => {
  const feeds = getFeeds();
  const cam = feeds.find(c => c.id === req.params.id);
  if (!cam) return res.status(404).json({ success: false, message: 'Feed not found' });

  const cached = feedStatusCache.get(cam.id);
  const probe = await checkFeedReachability(cam.ip, cam.port || 554, 2500);

  if (!probe.reachable) {
    const result = {
      status: 'offline',
      code: 4408,
      short: 'Feed Offline',
      message: `Feed is offline or unreachable at ${cam.ip}:${cam.port || 554} (${probe.reason})`,
      reachable: false
    };
    feedStatusCache.set(cam.id, { ...result, timestamp: Date.now() });
    return res.json({ success: true, ...result });
  }

  // If host is reachable on port 554, check if there is a recent auth error cached
  if (cached && cached.status === 'auth_error' && (Date.now() - cached.timestamp < 120000)) {
    return res.json({ success: true, ...cached, reachable: true });
  }

  res.json({
    success: true,
    status: 'online',
    code: 200,
    short: 'Online',
    message: `Host reachable at ${cam.ip}:${cam.port || 554}`,
    reachable: true
  });
});

app.get('/api/feeds/status', authMiddleware, (req, res) => {
  const result = {};
  feedStatusCache.forEach((val, key) => {
    result[key] = val;
  });
  res.json({ success: true, statuses: result });
});

// ── Secret Recordings Vault ───────────────────────────────────
const VAULT_DIR = path.join(__dirname, '.vault');
if (!fs.existsSync(VAULT_DIR)) {
  try {
    fs.mkdirSync(VAULT_DIR, { recursive: true, mode: 0o700 });
  } catch (_) {}
}

// activeRecordings: feedId -> { proc, fileId, feedId, feedName, filePath, filename, startTime }
const activeRecordings = new Map();

app.post('/api/recordings/:id/start', authMiddleware, (req, res) => {
  const feedId = req.params.id;
  const feeds = getFeeds();
  const feed = feeds.find(f => f.id === feedId);
  if (!feed) return res.status(404).json({ success: false, message: 'Feed not found' });

  if (activeRecordings.has(feedId)) {
    const existing = activeRecordings.get(feedId);
    return res.json({ success: true, recording: { fileId: existing.fileId, feedId, startTime: existing.startTime } });
  }

  const timestamp = Date.now();
  const fileId = `rec_${feedId}_${timestamp}`;
  const filename = `${fileId}.mp4`;
  const filePath = path.join(VAULT_DIR, filename);

  // Direct stream copy: 0% CPU overhead, native stream resolution, full audio
  const args = [
    '-loglevel', 'error',
    '-rtsp_transport', 'tcp',
    '-i', feed.url,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-movflags', '+faststart',
    '-y',
    filePath
  ];

  console.log(`[Vault] Starting secret recording for [${feed.name || feedId}] -> ${filename}`);
  const proc = spawn(FFMPEG_BIN, args, { stdio: ['pipe', 'ignore', 'pipe'] });

  const recordEntry = {
    proc,
    fileId,
    feedId,
    feedName: feed.name || feedId,
    filePath,
    filename,
    startTime: timestamp
  };

  activeRecordings.set(feedId, recordEntry);

  proc.on('exit', (code) => {
    console.log(`[Vault] Recording finished for [${feedId}] (code ${code})`);
    if (activeRecordings.get(feedId)?.fileId === fileId) {
      activeRecordings.delete(feedId);
    }
  });

  proc.on('error', (err) => {
    console.error(`[Vault] Recording spawn error for [${feedId}]:`, err.message);
    activeRecordings.delete(feedId);
  });

  res.json({
    success: true,
    message: 'Recording started',
    recording: {
      fileId,
      feedId,
      feedName: feed.name || feedId,
      startTime: timestamp
    }
  });
});

app.post('/api/recordings/:id/stop', authMiddleware, async (req, res) => {
  const feedId = req.params.id;
  const recording = activeRecordings.get(feedId);
  if (!recording) {
    return res.status(404).json({ success: false, message: 'No active recording for this feed' });
  }

  activeRecordings.delete(feedId);

  try {
    if (recording.proc.stdin && recording.proc.stdin.writable) {
      recording.proc.stdin.write('q');
    } else {
      recording.proc.kill('SIGINT');
    }
  } catch (_) {
    try { recording.proc.kill('SIGINT'); } catch (_) {}
  }

  // Allow brief moment for MP4 faststart moov atom to finalize
  await new Promise(r => setTimeout(r, 1200));

  let size = 0;
  try {
    const stat = fs.statSync(recording.filePath);
    size = stat.size;
  } catch (_) {}

  const durationSec = Math.max(1, Math.round((Date.now() - recording.startTime) / 1000));

  res.json({
    success: true,
    message: 'Recording saved to secret vault',
    file: {
      fileId: recording.fileId,
      filename: recording.filename,
      size,
      duration: durationSec
    }
  });
});

app.get('/api/recordings', authMiddleware, (req, res) => {
  try {
    if (!fs.existsSync(VAULT_DIR)) {
      return res.json({ success: true, recordings: [], activeRecordings: {} });
    }
    const files = fs.readdirSync(VAULT_DIR)
      .filter(f => f.endsWith('.mp4'))
      .map(f => {
        const full = path.join(VAULT_DIR, f);
        const stat = fs.statSync(full);
        const match = f.match(/^rec_(.+?)_(\d+)\.mp4$/);
        const feedId = match ? match[1] : 'feed';
        const timestamp = match ? parseInt(match[2], 10) : Math.round(stat.birthtimeMs);
        const feed = getFeeds().find(c => c.id === feedId);
        return {
          fileId: path.basename(f, '.mp4'),
          filename: f,
          feedId,
          feedName: feed ? feed.name : feedId,
          size: stat.size,
          createdAt: timestamp
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);

    const active = {};
    activeRecordings.forEach((val, key) => {
      active[key] = {
        fileId: val.fileId,
        startTime: val.startTime,
        feedName: val.feedName
      };
    });

    res.json({ success: true, recordings: files, activeRecordings: active });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Download & Auto-Purge from PC
app.get('/api/recordings/:fileId/download', authMiddleware, (req, res) => {
  const fileId = req.params.fileId;
  const filename = `${fileId}.mp4`;
  const filePath = path.join(VAULT_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Recording file not found or already purged');
  }

  const stat = fs.statSync(filePath);
  const friendlyName = `${fileId}.mp4`;

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${friendlyName}"`,
    'Cache-Control': 'no-store'
  });

  const readStream = fs.createReadStream(filePath);
  readStream.pipe(res);

  // Automatically delete from computer once downloaded
  res.on('finish', () => {
    console.log(`[Vault] Download finished for [${filename}]. Auto-purging from computer...`);
    setTimeout(() => {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log(`[Vault] Successfully deleted [${filename}] from computer.`);
        }
      } catch (err) {
        console.error('[Vault] Error during auto-purge:', err.message);
      }
    }, 1500);
  });
});

app.delete('/api/recordings/:fileId', authMiddleware, (req, res) => {
  const fileId = req.params.fileId;
  const filePath = path.join(VAULT_DIR, `${fileId}.mp4`);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return res.json({ success: true, message: 'Deleted from vault' });
    }
    res.status(404).json({ success: false, message: 'File not found' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Git Auto-Pull / Sync Worker ───────────────────────────────
let lastGitSync = {
  currentCommit: 'unknown',
  lastChecked: Date.now(),
  lastStatus: 'idle',
  lastError: null
};

// Automatically register directory as safe across any user context (SYSTEM vs normal user)
try {
  const normPath = __dirname.replace(/\\/g, '/');
  execSync(`git config --global --add safe.directory "${normPath}"`, { stdio: 'ignore' });
  execSync('git config --global --add safe.directory "*"', { stdio: 'ignore' });
} catch (_) {}

try {
  lastGitSync.currentCommit = execSync('git -c safe.directory=* rev-parse --short HEAD', { cwd: __dirname }).toString().trim();
} catch (_) {}

async function checkAndApplyGitUpdates() {
  try {
    // 1. Fetch latest changes from GitHub (with safe.directory bypass)
    await execPromise('git -c safe.directory=* fetch origin main', { cwd: __dirname, timeout: 25000 });

    // 2. Compare local HEAD against origin/main
    const localHash = (await execPromise('git -c safe.directory=* rev-parse HEAD', { cwd: __dirname })).stdout.trim();
    const remoteHash = (await execPromise('git -c safe.directory=* rev-parse origin/main', { cwd: __dirname })).stdout.trim();

    lastGitSync.lastChecked = Date.now();
    lastGitSync.currentCommit = localHash.slice(0, 7);

    if (localHash !== remoteHash) {
      console.log(`[Auto-Sync] 🚀 New commit on origin/main (${localHash.slice(0, 7)} -> ${remoteHash.slice(0, 7)})! Pulling updates...`);
      lastGitSync.lastStatus = 'updating';

      await execPromise('git -c safe.directory=* pull origin main', { cwd: __dirname, timeout: 35000 });

      console.log('[Auto-Sync] ✅ Successfully pulled updates! Restarting service to apply changes...');
      lastGitSync.currentCommit = remoteHash.slice(0, 7);
      lastGitSync.lastStatus = 'restarting';

      setTimeout(() => {
        cleanupAll();
        process.exit(0);
      }, 1000);

      return { updated: true, newCommit: remoteHash.slice(0, 7) };
    } else {
      lastGitSync.lastStatus = 'synced';
      return { updated: false, commit: localHash.slice(0, 7) };
    }
  } catch (err) {
    console.error('[Auto-Sync] Git check failed:', err.message);
    lastGitSync.lastError = err.message;
    lastGitSync.lastStatus = 'error';
    return { updated: false, error: err.message };
  }
}

// Check every 60 seconds automatically
setInterval(checkAndApplyGitUpdates, 60000);
// Check 10 seconds after server boot
setTimeout(checkAndApplyGitUpdates, 10000);

app.get('/api/system/git-status', authMiddleware, (req, res) => {
  res.json({ success: true, ...lastGitSync });
});

app.post('/api/system/git-pull', authMiddleware, async (req, res) => {
  const result = await checkAndApplyGitUpdates();
  res.json({ success: true, ...result, currentCommit: lastGitSync.currentCommit });
});

app.post('/api/webhook/git-sync', (req, res) => {
  console.log('[Auto-Sync] GitHub webhook received. Triggering immediate pull...');
  checkAndApplyGitUpdates();
  res.json({ success: true, message: 'Auto-sync initiated' });
});

// ── Cluster & Node System Endpoints ─────────────────────────
app.get('/api/system/node', authMiddleware, (req, res) => {
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  const nodeType = isMac ? 'Mac Mini' : isWin ? 'Windows PC' : 'Server';

  res.json({
    success: true,
    nodeId: isMac ? 'mac_mini' : isWin ? 'windows_pc' : 'server',
    nodeName: `${nodeType} (${os.hostname()})`,
    nodeType,
    hostname: os.hostname(),
    platform: process.platform,
    platformLabel: isMac ? 'macOS' : isWin ? 'Windows' : process.platform,
    arch: os.arch(),
    uptime: Math.floor(process.uptime()),
    activeStreams: streamSessions.size,
    totalFeeds: getFeeds().length,
    localIps: getLocalIps(),
    standbyMode: nodeStandbyMode,
    gitCommit: lastGitSync.currentCommit,
    serverTime: Date.now()
  });
});

app.post('/api/system/node-mode', authMiddleware, (req, res) => {
  const { standby } = req.body || {};
  nodeStandbyMode = Boolean(standby);
  console.log(`[Cluster] Node standby mode set to: ${nodeStandbyMode}`);
  res.json({ success: true, standbyMode: nodeStandbyMode });
});

// ── Health Check ──────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  const nodeType = isMac ? 'Mac Mini' : isWin ? 'Windows PC' : 'Server';

  res.json({
    status: nodeStandbyMode ? 'standby' : 'ok',
    nodeName: `${nodeType} (${os.hostname()})`,
    nodeType,
    hostname: os.hostname(),
    platform: process.platform,
    activeStreams: streamSessions.size,
    totalFeeds: getFeeds().length,
    gitCommit: lastGitSync.currentCommit,
    uptime: Math.round(process.uptime()),
    standbyMode: nodeStandbyMode
  });
});

// ── Static Frontend ───────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── HTTP Server + WebSocket Server ───────────────────────────
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, path: '/stream' });

wss.on('connection', (ws, req) => {
  // Extract cam ID, quality, and auth token from query string
  // e.g. ws://localhost:3000/stream?id=feed_25&quality=sd&token=eyJ...
  const urlParams  = new URLSearchParams(req.url.replace('/stream', '').replace('?', ''));
  const camId      = urlParams.get('id');
  const quality    = (urlParams.get('quality') || 'sd').toLowerCase() === 'hd' ? 'hd' : 'sd';
  const sessionKey = `${camId}_${quality}`;
  const token      = urlParams.get('token') ||
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
  const cam   = feeds.find(c => c.id === camId);
  if (!cam) {
    ws.close(4004, `Feed ${camId} not found`);
    return;
  }

  console.log(`[WS] Client connected to stream: [${sessionKey}]`);

  const session = getOrCreateStream(cam, quality);
  session.clients.add(ws);

  // Send buffered header so JSMpeg can decode immediately
  if (session.header && ws.readyState === WebSocket.OPEN) {
    ws.send(session.header, { binary: true });
  }

  ws.on('close', () => {
    session.clients.delete(ws);
    console.log(`[WS] Client disconnected from [${sessionKey}]. Viewers: ${session.clients.size}`);
    // Delay stop to allow quick reconnects (e.g. page refresh)
    setTimeout(() => stopStreamIfEmpty(sessionKey), 3000);
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

// Graceful shutdown: kill all FFmpeg processes & finalize recordings
function cleanupAll() {
  console.log('[Server] Shutting down — finalizing recordings and killing all FFmpeg processes...');
  activeRecordings.forEach((rec) => {
    try {
      if (rec.proc.stdin && rec.proc.stdin.writable) rec.proc.stdin.write('q');
      else rec.proc.kill('SIGINT');
    } catch (_) {}
  });
  streamSessions.forEach((s) => {
    if (s.ffmpegProc) {
      killProcess(s.ffmpegProc);
    }
  });
}
process.on('SIGTERM', () => { cleanupAll(); process.exit(0); });
process.on('SIGINT', () => { cleanupAll(); process.exit(0); });

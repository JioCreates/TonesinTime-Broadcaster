require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Docker = require('dockerode');
const Stripe = require('stripe');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const mm = require('music-metadata');
const { execFile } = require('child_process');
const db = require('./db');
const AutoDJ = require('./autodj');

const app = express();
const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const autoDJ = new AutoDJ();

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const BASE_DOMAIN = process.env.BASE_DOMAIN || 'tonesintime.io';
const ICECAST_IMAGE = process.env.ICECAST_IMAGE || 'tonesintime/icecast:latest';
const PORT_RANGE_START = parseInt(process.env.ICECAST_PORT_RANGE_START || '8001');
const PORT_RANGE_END = parseInt(process.env.ICECAST_PORT_RANGE_END || '9000');
const ICECAST_NETWORK = process.env.ICECAST_NETWORK || 'tonesintime';
const ICECAST_ADMIN_PASSWORD = process.env.ICECAST_ADMIN_PASSWORD || 'admin';
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Multer config for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userDir = path.join(UPLOADS_DIR, String(req.user.id));
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    cb(null, userDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['.mp3', '.m4a', '.ogg', '.flac', '.wav'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed (mp3, m4a, ogg, flac, wav)'));
    }
  },
});

// Plan limits
const PLAN_LIMITS = {
  free:  { streams: 1, maxListeners: 50 },
  basic: { streams: 3, maxListeners: 200 },
  pro:   { streams: 10, maxListeners: 1000 },
};

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Stripe webhook needs raw body
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);

app.use(cors());
app.use(express.json());

// Serve dashboard
app.use(express.static(path.join(__dirname, '..', 'dashboard')));

// Auth middleware
function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const token = header.split(' ')[1];
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ---------------------------------------------------------------------------
// Auth Routes
// ---------------------------------------------------------------------------

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, username } = req.body;

    if (!email || !password || !username) {
      return res.status(400).json({ error: 'Email, password, and username are required' });
    }

    if (username.length < 3 || !/^[a-zA-Z0-9_-]+$/.test(username)) {
      return res.status(400).json({ error: 'Username must be 3+ characters, alphanumeric, hyphens and underscores only' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(email, username);
    if (existing) {
      return res.status(409).json({ error: 'Email or username already taken' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = db.prepare(
      'INSERT INTO users (email, username, password_hash) VALUES (?, ?, ?)'
    ).run(email, username, passwordHash);

    const token = jwt.sign(
      { id: result.lastInsertRowid, email, username, plan: 'free' },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      token,
      user: { id: result.lastInsertRowid, email, username, plan: 'free' },
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, username: user.username, plan: user.plan },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: { id: user.id, email: user.email, username: user.username, plan: user.plan },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ---------------------------------------------------------------------------
// Stream Routes
// ---------------------------------------------------------------------------

function findAvailablePort() {
  const usedPorts = db.prepare('SELECT port FROM streams').all().map(r => r.port);
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
    if (!usedPorts.includes(p)) return p;
  }
  return null;
}

function generatePassword(length = 24) {
  return crypto.randomBytes(length).toString('base64url').slice(0, length);
}

app.post('/api/streams/create', authenticate, async (req, res) => {
  try {
    const { name, mount } = req.body;
    const streamName = name || `${req.user.username}'s stream`;
    const streamMount = mount || '/live';

    // Check plan limits
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const limits = PLAN_LIMITS[user.plan] || PLAN_LIMITS.free;
    const streamCount = db.prepare('SELECT COUNT(*) as count FROM streams WHERE user_id = ?').get(req.user.id).count;

    if (streamCount >= limits.streams) {
      return res.status(403).json({
        error: `Your ${user.plan} plan allows ${limits.streams} stream(s). Upgrade to create more.`,
      });
    }

    const port = findAvailablePort();
    if (!port) {
      return res.status(503).json({ error: 'No available ports. Please try again later.' });
    }

    const sourcePassword = generatePassword();
    const containerName = `tonesintime-stream-${req.user.username}-${port}`;

    // Create and start Icecast container
    const container = await docker.createContainer({
      Image: ICECAST_IMAGE,
      name: containerName,
      Env: [
        `ICECAST_SOURCE_PASSWORD=${sourcePassword}`,
        `ICECAST_RELAY_PASSWORD=${generatePassword()}`,
        `ICECAST_ADMIN_PASSWORD=${ICECAST_ADMIN_PASSWORD}`,
        `ICECAST_ADMIN_USER=admin`,
        `ICECAST_PORT=8000`,
        `ICECAST_MOUNT=${streamMount}`,
        `ICECAST_MAX_LISTENERS=${limits.maxListeners}`,
        `ICECAST_HOSTNAME=${req.user.username}.${BASE_DOMAIN}`,
      ],
      ExposedPorts: { '8000/tcp': {} },
      HostConfig: {
        PortBindings: {
          '8000/tcp': [{ HostPort: String(port) }],
        },
        RestartPolicy: { Name: 'unless-stopped' },
        NetworkMode: ICECAST_NETWORK,
      },
      Labels: {
        'tonesintime.user': req.user.username,
        'tonesintime.stream': 'true',
      },
    });

    await container.start();

    const result = db.prepare(
      `INSERT INTO streams (user_id, name, port, mount, source_password, container_id, status, max_listeners)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`
    ).run(req.user.id, streamName, port, streamMount, sourcePassword, container.id, limits.maxListeners);

    const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(result.lastInsertRowid);

    res.status(201).json({
      stream: {
        ...stream,
        listen_url: `http://${req.user.username}.${BASE_DOMAIN}${streamMount}`,
        source_url: `icecast://${req.user.username}.${BASE_DOMAIN}:${port}${streamMount}`,
        direct_url: `http://${BASE_DOMAIN}:${port}${streamMount}`,
      },
    });
  } catch (err) {
    console.error('Stream create error:', err);
    res.status(500).json({ error: 'Failed to create stream: ' + err.message });
  }
});

app.delete('/api/streams/:id', authenticate, async (req, res) => {
  try {
    const stream = db.prepare('SELECT * FROM streams WHERE id = ? AND user_id = ?').get(
      req.params.id,
      req.user.id
    );

    if (!stream) {
      return res.status(404).json({ error: 'Stream not found' });
    }

    // Stop AutoDJ if running for this stream
    autoDJ.stopStream(stream.id);

    // Stop and remove container
    if (stream.container_id) {
      try {
        const container = docker.getContainer(stream.container_id);
        try { await container.stop(); } catch { /* may already be stopped */ }
        await container.remove();
      } catch (err) {
        console.warn('Container cleanup warning:', err.message);
      }
    }

    db.prepare('DELETE FROM streams WHERE id = ?').run(stream.id);

    res.json({ message: 'Stream deleted' });
  } catch (err) {
    console.error('Stream delete error:', err);
    res.status(500).json({ error: 'Failed to delete stream' });
  }
});

app.get('/api/streams', authenticate, async (req, res) => {
  try {
    const streams = db.prepare('SELECT * FROM streams WHERE user_id = ?').all(req.user.id);

    // Enrich with live status and listener count from Docker
    const enriched = await Promise.all(
      streams.map(async (stream) => {
        let listeners = 0;
        let isRunning = false;

        if (stream.container_id) {
          try {
            const container = docker.getContainer(stream.container_id);
            const info = await container.inspect();
            isRunning = info.State.Running;
          } catch {
            // Container may have been removed externally
          }
        }

        const djStatus = autoDJ.getStatus(stream.id);

        return {
          ...stream,
          status: isRunning ? 'running' : 'stopped',
          listeners,
          autodj: djStatus,
          listen_url: `http://${req.user.username}.${BASE_DOMAIN}${stream.mount}`,
          source_url: `icecast://${req.user.username}.${BASE_DOMAIN}:${stream.port}${stream.mount}`,
          direct_url: `http://${BASE_DOMAIN}:${stream.port}${stream.mount}`,
        };
      })
    );

    res.json({ streams: enriched });
  } catch (err) {
    console.error('Stream list error:', err);
    res.status(500).json({ error: 'Failed to list streams' });
  }
});

app.get('/api/streams/:id', authenticate, async (req, res) => {
  try {
    const stream = db.prepare('SELECT * FROM streams WHERE id = ? AND user_id = ?').get(
      req.params.id,
      req.user.id
    );

    if (!stream) {
      return res.status(404).json({ error: 'Stream not found' });
    }

    let listeners = 0;
    let isRunning = false;
    let uptime = null;

    if (stream.container_id) {
      try {
        const container = docker.getContainer(stream.container_id);
        const info = await container.inspect();
        isRunning = info.State.Running;
        if (isRunning && info.State.StartedAt) {
          uptime = Math.floor(
            (Date.now() - new Date(info.State.StartedAt).getTime()) / 1000
          );
        }
      } catch {
        // Container may be gone
      }
    }

    res.json({
      stream: {
        ...stream,
        status: isRunning ? 'running' : 'stopped',
        listeners,
        uptime,
        autodj: autoDJ.getStatus(stream.id),
        listen_url: `http://${req.user.username}.${BASE_DOMAIN}${stream.mount}`,
        source_url: `icecast://${req.user.username}.${BASE_DOMAIN}:${stream.port}${stream.mount}`,
        direct_url: `http://${BASE_DOMAIN}:${stream.port}${stream.mount}`,
        dj_connection: {
          host: `${BASE_DOMAIN}`,
          port: stream.port,
          mount: stream.mount,
          username: 'source',
          password: stream.source_password,
        },
      },
    });
  } catch (err) {
    console.error('Stream detail error:', err);
    res.status(500).json({ error: 'Failed to get stream details' });
  }
});

// ---------------------------------------------------------------------------
// Track Management Routes
// ---------------------------------------------------------------------------

// Get duration using ffprobe (fallback if music-metadata fails)
function getAudioDuration(filePath) {
  return new Promise((resolve) => {
    execFile('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], (err, stdout) => {
      if (err) {
        resolve(0);
      } else {
        resolve(parseFloat(stdout.trim()) || 0);
      }
    });
  });
}

app.post('/api/tracks/upload', authenticate, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    let title = null;
    let artist = null;
    let duration = 0;

    // Try music-metadata first
    try {
      const metadata = await mm.parseFile(req.file.path);
      title = metadata.common.title || null;
      artist = metadata.common.artist || null;
      duration = metadata.format.duration || 0;
    } catch {
      // Fall back to ffprobe for duration
      duration = await getAudioDuration(req.file.path);
    }

    // Default title from filename if not in metadata
    if (!title) {
      title = path.basename(req.file.originalname, path.extname(req.file.originalname));
    }

    const result = db.prepare(
      'INSERT INTO tracks (user_id, filename, title, artist, duration, file_path) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(req.user.id, req.file.originalname, title, artist, duration, req.file.path);

    const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(result.lastInsertRowid);

    res.status(201).json({ track });
  } catch (err) {
    console.error('Track upload error:', err);
    // Clean up file on error
    if (req.file && req.file.path) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
    res.status(500).json({ error: 'Failed to upload track: ' + err.message });
  }
});

app.get('/api/tracks', authenticate, (req, res) => {
  try {
    const tracks = db.prepare('SELECT * FROM tracks WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
    res.json({ tracks });
  } catch (err) {
    console.error('Track list error:', err);
    res.status(500).json({ error: 'Failed to list tracks' });
  }
});

app.delete('/api/tracks/:id', authenticate, (req, res) => {
  try {
    const track = db.prepare('SELECT * FROM tracks WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!track) {
      return res.status(404).json({ error: 'Track not found' });
    }

    // Delete file from disk
    try {
      if (fs.existsSync(track.file_path)) {
        fs.unlinkSync(track.file_path);
      }
    } catch (err) {
      console.warn('File cleanup warning:', err.message);
    }

    db.prepare('DELETE FROM tracks WHERE id = ?').run(track.id);
    res.json({ message: 'Track deleted' });
  } catch (err) {
    console.error('Track delete error:', err);
    res.status(500).json({ error: 'Failed to delete track' });
  }
});

// ---------------------------------------------------------------------------
// Playlist Management Routes
// ---------------------------------------------------------------------------

app.post('/api/playlists', authenticate, (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Playlist name is required' });
    }

    const result = db.prepare('INSERT INTO playlists (user_id, name) VALUES (?, ?)').run(req.user.id, name.trim());
    const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ playlist });
  } catch (err) {
    console.error('Playlist create error:', err);
    res.status(500).json({ error: 'Failed to create playlist' });
  }
});

app.get('/api/playlists', authenticate, (req, res) => {
  try {
    const playlists = db.prepare(`
      SELECT p.*, COUNT(pt.id) as track_count
      FROM playlists p
      LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
      WHERE p.user_id = ?
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `).all(req.user.id);

    res.json({ playlists });
  } catch (err) {
    console.error('Playlist list error:', err);
    res.status(500).json({ error: 'Failed to list playlists' });
  }
});

app.get('/api/playlists/:id', authenticate, (req, res) => {
  try {
    const playlist = db.prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    const tracks = db.prepare(`
      SELECT t.*, pt.position, pt.id as playlist_track_id
      FROM playlist_tracks pt
      JOIN tracks t ON t.id = pt.track_id
      WHERE pt.playlist_id = ?
      ORDER BY pt.position ASC
    `).all(playlist.id);

    res.json({ playlist, tracks });
  } catch (err) {
    console.error('Playlist detail error:', err);
    res.status(500).json({ error: 'Failed to get playlist' });
  }
});

app.put('/api/playlists/:id', authenticate, (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Playlist name is required' });
    }

    const playlist = db.prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    db.prepare('UPDATE playlists SET name = ? WHERE id = ?').run(name.trim(), playlist.id);
    const updated = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlist.id);
    res.json({ playlist: updated });
  } catch (err) {
    console.error('Playlist update error:', err);
    res.status(500).json({ error: 'Failed to update playlist' });
  }
});

app.delete('/api/playlists/:id', authenticate, (req, res) => {
  try {
    const playlist = db.prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    db.prepare('DELETE FROM playlists WHERE id = ?').run(playlist.id);
    res.json({ message: 'Playlist deleted' });
  } catch (err) {
    console.error('Playlist delete error:', err);
    res.status(500).json({ error: 'Failed to delete playlist' });
  }
});

app.post('/api/playlists/:id/tracks', authenticate, (req, res) => {
  try {
    const { track_id, position } = req.body;

    const playlist = db.prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    const track = db.prepare('SELECT * FROM tracks WHERE id = ? AND user_id = ?').get(track_id, req.user.id);
    if (!track) {
      return res.status(404).json({ error: 'Track not found' });
    }

    // Determine position
    let pos = position;
    if (pos === undefined || pos === null) {
      const maxPos = db.prepare('SELECT MAX(position) as max_pos FROM playlist_tracks WHERE playlist_id = ?').get(playlist.id);
      pos = (maxPos.max_pos || 0) + 1;
    }

    db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)').run(playlist.id, track.id, pos);

    res.status(201).json({ message: 'Track added to playlist' });
  } catch (err) {
    console.error('Add track to playlist error:', err);
    res.status(500).json({ error: 'Failed to add track to playlist' });
  }
});

app.delete('/api/playlists/:playlistId/tracks/:trackId', authenticate, (req, res) => {
  try {
    const playlist = db.prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ?').get(req.params.playlistId, req.user.id);
    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    const result = db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?').run(playlist.id, req.params.trackId);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Track not in playlist' });
    }

    res.json({ message: 'Track removed from playlist' });
  } catch (err) {
    console.error('Remove track from playlist error:', err);
    res.status(500).json({ error: 'Failed to remove track from playlist' });
  }
});

app.put('/api/playlists/:id/reorder', authenticate, (req, res) => {
  try {
    const { track_ids } = req.body;
    if (!Array.isArray(track_ids)) {
      return res.status(400).json({ error: 'track_ids must be an array' });
    }

    const playlist = db.prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    const updatePos = db.prepare('UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND track_id = ?');
    const reorder = db.transaction((ids) => {
      for (let i = 0; i < ids.length; i++) {
        updatePos.run(i, playlist.id, ids[i]);
      }
    });

    reorder(track_ids);

    res.json({ message: 'Playlist reordered' });
  } catch (err) {
    console.error('Playlist reorder error:', err);
    res.status(500).json({ error: 'Failed to reorder playlist' });
  }
});

// ---------------------------------------------------------------------------
// Schedule Management Routes
// ---------------------------------------------------------------------------

app.post('/api/schedules', authenticate, (req, res) => {
  try {
    const { stream_id, playlist_id, day_of_week, start_time, end_time } = req.body;

    if (stream_id === undefined || playlist_id === undefined || day_of_week === undefined || !start_time || !end_time) {
      return res.status(400).json({ error: 'stream_id, playlist_id, day_of_week, start_time, and end_time are required' });
    }

    if (day_of_week < 0 || day_of_week > 6) {
      return res.status(400).json({ error: 'day_of_week must be 0-6 (Sunday-Saturday)' });
    }

    if (!/^\d{2}:\d{2}$/.test(start_time) || !/^\d{2}:\d{2}$/.test(end_time)) {
      return res.status(400).json({ error: 'Times must be in HH:MM format' });
    }

    // Verify ownership
    const stream = db.prepare('SELECT * FROM streams WHERE id = ? AND user_id = ?').get(stream_id, req.user.id);
    if (!stream) {
      return res.status(404).json({ error: 'Stream not found' });
    }

    const playlist = db.prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ?').get(playlist_id, req.user.id);
    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    const result = db.prepare(
      'INSERT INTO schedules (user_id, stream_id, playlist_id, day_of_week, start_time, end_time) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(req.user.id, stream_id, playlist_id, day_of_week, start_time, end_time);

    const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ schedule });
  } catch (err) {
    console.error('Schedule create error:', err);
    res.status(500).json({ error: 'Failed to create schedule' });
  }
});

app.get('/api/schedules', authenticate, (req, res) => {
  try {
    const schedules = db.prepare(`
      SELECT s.*, st.name as stream_name, p.name as playlist_name
      FROM schedules s
      JOIN streams st ON st.id = s.stream_id
      JOIN playlists p ON p.id = s.playlist_id
      WHERE s.user_id = ?
      ORDER BY s.day_of_week ASC, s.start_time ASC
    `).all(req.user.id);

    res.json({ schedules });
  } catch (err) {
    console.error('Schedule list error:', err);
    res.status(500).json({ error: 'Failed to list schedules' });
  }
});

app.put('/api/schedules/:id', authenticate, (req, res) => {
  try {
    const schedule = db.prepare('SELECT * FROM schedules WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!schedule) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

    const { stream_id, playlist_id, day_of_week, start_time, end_time } = req.body;

    const updates = {};
    if (stream_id !== undefined) {
      const stream = db.prepare('SELECT * FROM streams WHERE id = ? AND user_id = ?').get(stream_id, req.user.id);
      if (!stream) return res.status(404).json({ error: 'Stream not found' });
      updates.stream_id = stream_id;
    }
    if (playlist_id !== undefined) {
      const playlist = db.prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ?').get(playlist_id, req.user.id);
      if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
      updates.playlist_id = playlist_id;
    }
    if (day_of_week !== undefined) updates.day_of_week = day_of_week;
    if (start_time !== undefined) updates.start_time = start_time;
    if (end_time !== undefined) updates.end_time = end_time;

    const fields = Object.keys(updates);
    if (fields.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = fields.map(f => updates[f]);
    values.push(schedule.id);

    db.prepare(`UPDATE schedules SET ${setClause} WHERE id = ?`).run(...values);

    const updated = db.prepare('SELECT * FROM schedules WHERE id = ?').get(schedule.id);
    res.json({ schedule: updated });
  } catch (err) {
    console.error('Schedule update error:', err);
    res.status(500).json({ error: 'Failed to update schedule' });
  }
});

app.delete('/api/schedules/:id', authenticate, (req, res) => {
  try {
    const schedule = db.prepare('SELECT * FROM schedules WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!schedule) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

    db.prepare('DELETE FROM schedules WHERE id = ?').run(schedule.id);
    res.json({ message: 'Schedule deleted' });
  } catch (err) {
    console.error('Schedule delete error:', err);
    res.status(500).json({ error: 'Failed to delete schedule' });
  }
});

app.put('/api/schedules/:id/toggle', authenticate, (req, res) => {
  try {
    const schedule = db.prepare('SELECT * FROM schedules WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!schedule) {
      return res.status(404).json({ error: 'Schedule not found' });
    }

    const newEnabled = schedule.enabled ? 0 : 1;
    db.prepare('UPDATE schedules SET enabled = ? WHERE id = ?').run(newEnabled, schedule.id);

    const updated = db.prepare('SELECT * FROM schedules WHERE id = ?').get(schedule.id);
    res.json({ schedule: updated });
  } catch (err) {
    console.error('Schedule toggle error:', err);
    res.status(500).json({ error: 'Failed to toggle schedule' });
  }
});

// ---------------------------------------------------------------------------
// Play History Routes
// ---------------------------------------------------------------------------

app.get('/api/history/:streamId', authenticate, (req, res) => {
  try {
    const stream = db.prepare('SELECT * FROM streams WHERE id = ? AND user_id = ?').get(req.params.streamId, req.user.id);
    if (!stream) {
      return res.status(404).json({ error: 'Stream not found' });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = (page - 1) * limit;

    const total = db.prepare('SELECT COUNT(*) as count FROM play_history WHERE stream_id = ?').get(stream.id).count;

    const history = db.prepare(`
      SELECT ph.*, t.title, t.artist, t.filename, t.duration
      FROM play_history ph
      JOIN tracks t ON t.id = ph.track_id
      WHERE ph.stream_id = ?
      ORDER BY ph.played_at DESC
      LIMIT ? OFFSET ?
    `).all(stream.id, limit, offset);

    res.json({
      history,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error('History error:', err);
    res.status(500).json({ error: 'Failed to get play history' });
  }
});

// ---------------------------------------------------------------------------
// AutoDJ Control Routes
// ---------------------------------------------------------------------------

app.post('/api/autodj/:streamId/start', authenticate, (req, res) => {
  try {
    const stream = db.prepare('SELECT * FROM streams WHERE id = ? AND user_id = ?').get(req.params.streamId, req.user.id);
    if (!stream) {
      return res.status(404).json({ error: 'Stream not found' });
    }

    const { playlist_id, shuffle_all } = req.body;

    if (shuffle_all) {
      autoDJ.startShuffleAll(stream.id, req.user.id, {
        port: stream.port,
        mount: stream.mount,
        source_password: stream.source_password,
      });
    } else if (playlist_id) {
      const playlist = db.prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ?').get(playlist_id, req.user.id);
      if (!playlist) {
        return res.status(404).json({ error: 'Playlist not found' });
      }

      autoDJ.startPlaylist(stream.id, playlist_id, {
        port: stream.port,
        mount: stream.mount,
        source_password: stream.source_password,
      });
    } else {
      return res.status(400).json({ error: 'Provide playlist_id or shuffle_all: true' });
    }

    res.json({ message: 'AutoDJ started', status: autoDJ.getStatus(stream.id) });
  } catch (err) {
    console.error('AutoDJ start error:', err);
    res.status(500).json({ error: 'Failed to start AutoDJ' });
  }
});

app.post('/api/autodj/:streamId/stop', authenticate, (req, res) => {
  try {
    const stream = db.prepare('SELECT * FROM streams WHERE id = ? AND user_id = ?').get(req.params.streamId, req.user.id);
    if (!stream) {
      return res.status(404).json({ error: 'Stream not found' });
    }

    autoDJ.stopStream(stream.id);
    res.json({ message: 'AutoDJ stopped' });
  } catch (err) {
    console.error('AutoDJ stop error:', err);
    res.status(500).json({ error: 'Failed to stop AutoDJ' });
  }
});

app.get('/api/autodj/:streamId/status', authenticate, (req, res) => {
  try {
    const stream = db.prepare('SELECT * FROM streams WHERE id = ? AND user_id = ?').get(req.params.streamId, req.user.id);
    if (!stream) {
      return res.status(404).json({ error: 'Stream not found' });
    }

    res.json({ status: autoDJ.getStatus(stream.id) });
  } catch (err) {
    console.error('AutoDJ status error:', err);
    res.status(500).json({ error: 'Failed to get AutoDJ status' });
  }
});

// ---------------------------------------------------------------------------
// Web Player Widget
// ---------------------------------------------------------------------------

app.get('/api/widget/:streamId', (req, res) => {
  try {
    const stream = db.prepare('SELECT s.*, u.username FROM streams s JOIN users u ON u.id = s.user_id WHERE s.id = ?').get(req.params.streamId);
    if (!stream) {
      return res.status(404).send('Stream not found');
    }

    const listenUrl = `http://${stream.username}.${BASE_DOMAIN}${stream.mount}`;
    const directUrl = `http://${BASE_DOMAIN}:${stream.port}${stream.mount}`;

    // Get now playing from play_history
    const nowPlaying = db.prepare(`
      SELECT t.title, t.artist FROM play_history ph
      JOIN tracks t ON t.id = ph.track_id
      WHERE ph.stream_id = ?
      ORDER BY ph.played_at DESC LIMIT 1
    `).get(stream.id);

    const npTitle = nowPlaying ? (nowPlaying.title || 'Unknown') : stream.name;
    const npArtist = nowPlaying ? (nowPlaying.artist || '') : '';

    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${stream.name} - TonesinTime</title>
<style>
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, sans-serif;
    background: transparent;
    color: #f0f0f5;
  }
  .player {
    background: rgba(20, 20, 30, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 16px;
    padding: 20px;
    backdrop-filter: blur(40px);
    -webkit-backdrop-filter: blur(40px);
    max-width: 380px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  }
  .now-playing {
    margin-bottom: 16px;
  }
  .np-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: rgba(240, 240, 245, 0.4);
    margin-bottom: 4px;
  }
  .np-title {
    font-size: 16px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .np-artist {
    font-size: 13px;
    color: rgba(240, 240, 245, 0.6);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .play-btn {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: none;
    background: #7c5bf5;
    color: #fff;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: background 0.2s;
  }
  .play-btn:hover { background: #9172ff; }
  .play-btn svg { width: 20px; height: 20px; }
  .volume-wrap {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .vol-icon { color: rgba(240, 240, 245, 0.5); flex-shrink: 0; }
  .vol-icon svg { width: 16px; height: 16px; display: block; }
  input[type="range"] {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 4px;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.15);
    outline: none;
  }
  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #7c5bf5;
    cursor: pointer;
  }
  .branding {
    margin-top: 12px;
    text-align: right;
    font-size: 10px;
    color: rgba(240, 240, 245, 0.25);
  }
  .branding a { color: rgba(240, 240, 245, 0.35); text-decoration: none; }
</style>
</head>
<body>
<div class="player">
  <div class="now-playing">
    <div class="np-label">Now Playing</div>
    <div class="np-title" id="np-title">${npTitle}</div>
    <div class="np-artist" id="np-artist">${npArtist}</div>
  </div>
  <div class="controls">
    <button class="play-btn" id="play-btn" onclick="togglePlay()">
      <svg id="play-icon" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,3 20,12 6,21"/></svg>
      <svg id="pause-icon" viewBox="0 0 24 24" fill="currentColor" style="display:none"><rect x="5" y="3" width="4" height="18"/><rect x="15" y="3" width="4" height="18"/></svg>
    </button>
    <div class="volume-wrap">
      <div class="vol-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19" fill="currentColor"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
      </div>
      <input type="range" id="volume" min="0" max="100" value="80" oninput="setVolume(this.value)">
    </div>
  </div>
  <div class="branding"><a href="https://tonesintime.io" target="_blank">TonesinTime</a></div>
</div>
<script>
  const audio = new Audio();
  audio.crossOrigin = 'anonymous';
  const streamUrl = '${directUrl}';
  let playing = false;

  audio.volume = 0.8;

  function togglePlay() {
    if (playing) {
      audio.pause();
      audio.src = '';
      playing = false;
      document.getElementById('play-icon').style.display = '';
      document.getElementById('pause-icon').style.display = 'none';
    } else {
      audio.src = streamUrl;
      audio.play().catch(() => {});
      playing = true;
      document.getElementById('play-icon').style.display = 'none';
      document.getElementById('pause-icon').style.display = '';
    }
  }

  function setVolume(v) {
    audio.volume = v / 100;
  }

  // Poll for now-playing updates
  setInterval(async () => {
    try {
      const res = await fetch('/api/widget/${stream.id}/nowplaying');
      const data = await res.json();
      if (data.title) document.getElementById('np-title').textContent = data.title;
      if (data.artist !== undefined) document.getElementById('np-artist').textContent = data.artist || '';
    } catch {}
  }, 15000);
</script>
</body>
</html>`);
  } catch (err) {
    console.error('Widget error:', err);
    res.status(500).send('Widget error');
  }
});

// Now playing endpoint for widget polling
app.get('/api/widget/:streamId/nowplaying', (req, res) => {
  try {
    const nowPlaying = db.prepare(`
      SELECT t.title, t.artist FROM play_history ph
      JOIN tracks t ON t.id = ph.track_id
      WHERE ph.stream_id = ?
      ORDER BY ph.played_at DESC LIMIT 1
    `).get(req.params.streamId);

    if (nowPlaying) {
      res.json({ title: nowPlaying.title || 'Unknown', artist: nowPlaying.artist || '' });
    } else {
      const stream = db.prepare('SELECT name FROM streams WHERE id = ?').get(req.params.streamId);
      res.json({ title: stream ? stream.name : 'TonesinTime', artist: '' });
    }
  } catch (err) {
    res.json({ title: 'TonesinTime', artist: '' });
  }
});

// ---------------------------------------------------------------------------
// Billing Routes
// ---------------------------------------------------------------------------

app.post('/api/billing/subscribe', authenticate, async (req, res) => {
  try {
    const { plan } = req.body;

    if (!['basic', 'pro'].includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan. Choose basic or pro.' });
    }

    const priceId = plan === 'basic'
      ? process.env.STRIPE_PRICE_ID_BASIC
      : process.env.STRIPE_PRICE_ID_PRO;

    if (!priceId) {
      return res.status(500).json({ error: 'Stripe price not configured' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

    // Create or retrieve Stripe customer
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { userId: String(user.id), username: user.username },
      });
      customerId = customer.id;
      db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, user.id);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `http://${BASE_DOMAIN}/dashboard?billing=success`,
      cancel_url: `http://${BASE_DOMAIN}/dashboard?billing=cancelled`,
      metadata: { userId: String(user.id), plan },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Billing error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

async function handleStripeWebhook(req, res) {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const userId = session.metadata?.userId;
      const plan = session.metadata?.plan;
      if (userId && plan) {
        db.prepare('UPDATE users SET plan = ? WHERE id = ?').run(plan, parseInt(userId));
        console.log(`User ${userId} upgraded to ${plan}`);
      }
      break;
    }
    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      const customerId = subscription.customer;
      db.prepare('UPDATE users SET plan = ? WHERE stripe_customer_id = ?').run('free', customerId);
      console.log(`Customer ${customerId} downgraded to free`);
      break;
    }
    default:
      break;
  }

  res.json({ received: true });
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), autodj: autoDJ.getAllStatus() });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`TonesinTime Cloud API running on port ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);

  // Start AutoDJ scheduler
  autoDJ.start();
});

const { app, BrowserWindow, ipcMain, dialog, globalShortcut, Notification, Tray, Menu, nativeImage } = require('electron');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { spawn, execFile, execSync } = require('child_process');

let mainWindow;
let tray = null;
let minimizeToTray = true;
let webSharing = false;
let notificationsEnabled = true;
let notifyListenerConnect = true;
let notifyStreamStatus = true;
let notifyRecordingStatus = true;

function safeSend(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

let streamServer = null;
let connectedClients = [];
let isStreaming = false;
let serverPort = 8000;
let streamMount = '/stream';
let streamMetadata = { title: 'TonesinTime', artist: '', song: '' };

// Burst buffer — stores last ~3 seconds of audio so new clients start instantly
const BURST_BUFFER_MAX = 128; // number of chunks to keep (roughly 2-4 seconds at 256kbps)
let streamBurstBuffer = [];

// Now Playing tracking
let nowPlayingData = {
  title: '',
  artist: '',
  duration: 0,
  elapsed: 0,
  playlist: ''
};
let ffmpegProcess = null;
let currentCodec = 'mp3';

// Recording state
let recordingStream = null;
let isRecording = false;
let recordingStartTime = null;
let recordingFilePath = null;
let recordingBytesWritten = 0;

// Listener tracking
let peakListeners = 0;
let totalSessions = 0;

// Stream health state
let healthBytesSent = 0;
let healthBytesWindow = []; // { time, bytes } entries for bitrate calculation
let healthDroppedConnections = 0;
let healthInterval = null;

// Auto-reconnect state
let autoReconnect = true;
let lastEncoderConfig = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 50;
const RECONNECT_DELAY_MS = 2000;

// ===================== CLOUDFLARE TUNNEL =====================
let tunnelProcess = null;
let tunnelUrl = '';
let tunnelRunning = false;
let cloudflaredPath = '';

function getCloudflaredBinDir() {
  return path.join(app.getPath('userData'), 'bin');
}

function getCloudflaredBinPath() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(getCloudflaredBinDir(), 'cloudflared' + ext);
}

function findCloudflared() {
  // Check userData/bin first
  const localBin = getCloudflaredBinPath();
  if (fs.existsSync(localBin)) {
    cloudflaredPath = localBin;
    return true;
  }
  // Check system PATH
  try {
    const cmd = process.platform === 'win32' ? 'where cloudflared' : 'which cloudflared';
    const result = execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim();
    if (result) {
      cloudflaredPath = result.split('\n')[0].trim();
      return true;
    }
  } catch (e) {}
  return false;
}

function getCloudflaredDownloadUrl() {
  const platform = process.platform;
  const arch = process.arch; // 'arm64' or 'x64'
  if (platform === 'darwin') {
    const archSuffix = arch === 'arm64' ? 'arm64' : 'amd64';
    return `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${archSuffix}.tgz`;
  } else if (platform === 'win32') {
    return 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
  }
  return null;
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const doRequest = (reqUrl, redirectCount) => {
      if (redirectCount > 10) return reject(new Error('Too many redirects'));
      const proto = reqUrl.startsWith('https') ? https : http;
      proto.get(reqUrl, { headers: { 'User-Agent': 'TonesinTime' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return doRequest(res.headers.location, redirectCount + 1);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        }
        const dir = path.dirname(destPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const fileStream = fs.createWriteStream(destPath);
        res.pipe(fileStream);
        fileStream.on('finish', () => { fileStream.close(); resolve(); });
        fileStream.on('error', reject);
      }).on('error', reject);
    };
    doRequest(url, 0);
  });
}

async function installCloudflared() {
  const url = getCloudflaredDownloadUrl();
  if (!url) throw new Error('Unsupported platform for cloudflared');

  const binDir = getCloudflaredBinDir();
  if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });

  if (process.platform === 'win32') {
    // Direct exe download
    const dest = getCloudflaredBinPath();
    await downloadFile(url, dest);
  } else {
    // Download .tgz, extract
    const tgzPath = path.join(binDir, 'cloudflared.tgz');
    await downloadFile(url, tgzPath);
    // Extract using tar
    await new Promise((resolve, reject) => {
      const tar = spawn('tar', ['xzf', tgzPath, '-C', binDir], { stdio: 'pipe' });
      tar.on('close', (code) => {
        // Clean up tgz
        try { fs.unlinkSync(tgzPath); } catch (e) {}
        if (code === 0) resolve();
        else reject(new Error(`tar extraction failed with code ${code}`));
      });
      tar.on('error', reject);
    });
    // Make executable
    const binPath = getCloudflaredBinPath();
    if (fs.existsSync(binPath)) {
      fs.chmodSync(binPath, 0o755);
    } else {
      throw new Error('cloudflared binary not found after extraction');
    }
  }

  cloudflaredPath = getCloudflaredBinPath();
}

function startTunnel(port) {
  if (tunnelProcess) return; // Already running

  const args = ['tunnel', '--url', `http://localhost:${port}`];
  tunnelProcess = spawn(cloudflaredPath, args, {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  tunnelRunning = true;
  tunnelUrl = '';

  // cloudflared outputs the tunnel URL on stderr
  tunnelProcess.stderr.on('data', (data) => {
    const str = data.toString();
    const urlMatch = str.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (urlMatch && !tunnelUrl) {
      tunnelUrl = urlMatch[0];
      safeSend('tunnel-url', tunnelUrl);
      // Auto-push to relay
      relayUpdateStream(tunnelUrl + (streamMount || '/stream'));
    }
  });

  tunnelProcess.stdout.on('data', (data) => {
    const str = data.toString();
    const urlMatch = str.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (urlMatch && !tunnelUrl) {
      tunnelUrl = urlMatch[0];
      safeSend('tunnel-url', tunnelUrl);
      // Auto-push to relay
      relayUpdateStream(tunnelUrl + (streamMount || '/stream'));
    }
  });

  tunnelProcess.on('error', (err) => {
    console.error('[Tunnel] cloudflared error:', err.message);
    tunnelRunning = false;
    tunnelUrl = '';
    safeSend('tunnel-url', '');
  });

  tunnelProcess.on('close', (code) => {
    tunnelProcess = null;
    tunnelRunning = false;
    tunnelUrl = '';
  });
}

function stopTunnel() {
  if (tunnelProcess) {
    try { tunnelProcess.kill('SIGTERM'); } catch (e) {}
    tunnelProcess = null;
  }
  tunnelRunning = false;
  tunnelUrl = '';
}

async function ensureCloudflaredAndStartTunnel(port) {
  if (!findCloudflared()) {
    safeSend('tunnel-url', 'downloading');
    try {
      await installCloudflared();
    } catch (err) {
      console.error('[Tunnel] Failed to install cloudflared:', err.message);
      safeSend('tunnel-url', 'error:' + err.message);
      return;
    }
  }
  safeSend('tunnel-url', 'connecting');
  startTunnel(port);
}

// ===================== RELAY (auto, no accounts) =====================
let relayId = '';
let relaySecret = '';
let relayUrl = 'https://tonesintime.io';

function relayPost(endpoint, body) {
  return new Promise((resolve) => {
    try {
      const url = new URL(endpoint, relayUrl);
      const proto = url.protocol === 'https:' ? https : http;
      const data = JSON.stringify(body);
      const req = proto.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); } });
      });
      req.on('error', () => resolve({}));
      req.write(data);
      req.end();
    } catch(e) { resolve({}); }
  });
}

async function relayEnsureId() {
  if (relayId && relaySecret) return;
  // Check persisted data
  try {
    const dataPath = getDataPath();
    if (fs.existsSync(dataPath)) {
      const saved = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
      if (saved.relayId && saved.relaySecret) {
        relayId = saved.relayId;
        relaySecret = saved.relaySecret;
        return;
      }
    }
  } catch(e) {}
  // Claim a new ID
  const res = await relayPost('/api/claim', {});
  if (res.id && res.secret) {
    relayId = res.id;
    relaySecret = res.secret;
    // Save immediately
    try {
      const dataPath = getDataPath();
      let saved = {};
      try { saved = JSON.parse(fs.readFileSync(dataPath, 'utf-8')); } catch(e) {}
      saved.relayId = relayId;
      saved.relaySecret = relaySecret;
      fs.writeFileSync(dataPath, JSON.stringify(saved, null, 2), 'utf-8');
    } catch(e) {}
  }
}

async function relayUpdateStream(streamUrl) {
  if (!relayId || !relaySecret) return;
  try {
    await relayPost('/api/update', { id: relayId, secret: relaySecret, url: streamUrl || '' });
    safeSend('relay-info', { id: relayId, live: !!streamUrl, listenUrl: `${relayUrl}/listen/${relayId}` });
  } catch(e) {}
}

// Auto-DJ state
let autoDjProcess = null;
let autoDjActive = false;
let autoDjPlaylist = [];
let autoDjCurrentIndex = 0;
let autoDjShuffle = false;
let autoDjShuffledOrder = [];
let scheduleInterval = null;
let activeScheduleId = null;

// ffmpeg-static path — handle both dev and packaged .app
// Always prefer system ffmpeg — more reliable than bundled
let ffmpegPath = '/opt/homebrew/bin/ffmpeg';
try {
  const { execSync } = require('child_process');
  const found = execSync('which ffmpeg 2>/dev/null || echo ""', { encoding: 'utf-8', env: { ...process.env, PATH: (process.env.PATH || '') + ':/opt/homebrew/bin:/usr/local/bin' } }).trim();
  if (found) ffmpegPath = found;
} catch(e) {}
// Fallback to bundled if system not found
if (!fs.existsSync(ffmpegPath)) {
  try {
    ffmpegPath = require('ffmpeg-static');
    if (app.isPackaged) ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
  } catch(e) {}
}

// ffprobe path (alongside ffmpeg-static)
let ffprobePath = '/opt/homebrew/bin/ffprobe';
try {
  const { execSync } = require('child_process');
  const found = execSync('which ffprobe 2>/dev/null || echo ""', { encoding: 'utf-8', env: { ...process.env, PATH: (process.env.PATH || '') + ':/opt/homebrew/bin:/usr/local/bin' } }).trim();
  if (found) ffprobePath = found;
} catch(e) {}

// fpcalc path (Chromaprint — audio fingerprinting)
let fpcalcPath = '/opt/homebrew/bin/fpcalc';
try {
  const found = execSync('which fpcalc 2>/dev/null || echo ""', { encoding: 'utf-8', env: { ...process.env, PATH: (process.env.PATH || '') + ':/opt/homebrew/bin:/usr/local/bin' } }).trim();
  if (found) fpcalcPath = found;
} catch(e) {}

// ===================== SONG RECOGNITION (Chromaprint + AcoustID) =====================

let songRecogActive = false;
let songRecogLoopTimer = null;
let lastRecognizedTitle = '';
const SONG_RECOG_DURATION = 18;
const SONG_RECOG_BUFFER_MAX = 512; // chunks of broadcast audio to keep
let songRecogStreamBuffer = [];

function startSongRecognition(apiKey) {
  if (!apiKey) {
    safeSend('song-recog-progress', { pct: 0, status: 'No API key' });
    return;
  }
  if (!fs.existsSync(fpcalcPath)) {
    safeSend('song-recog-progress', { pct: 0, status: 'fpcalc not found at ' + fpcalcPath });
    return;
  }

  songRecogActive = true;
  songRecogStreamBuffer = [];
  console.log('[SongRecog] Started — tapping broadcast stream');
  safeSend('song-recog-progress', { pct: 0, status: 'Waiting for stream data...' });
  scheduleNextRecogLoop(3000);
}

function stopSongRecognition() {
  songRecogActive = false;
  songRecogStreamBuffer = [];
  if (songRecogLoopTimer) { clearTimeout(songRecogLoopTimer); songRecogLoopTimer = null; }
}

// Called from broadcastToClients — feeds encoded audio to the live capture process
let songRecogCaptureProcess = null;

function feedSongRecogStream(buffer) {
  if (!songRecogActive || !songRecogCaptureProcess) return;
  try {
    if (songRecogCaptureProcess.stdin && songRecogCaptureProcess.stdin.writable) {
      songRecogCaptureProcess.stdin.write(buffer);
    }
  } catch(e) {}
}

async function songRecogLoop() {
  if (!songRecogActive) return;

  try {
    if (!isStreaming) {
      safeSend('song-recog-progress', { pct: 0, status: 'Waiting for stream to start...' });
      scheduleNextRecogLoop(3000);
      return;
    }

    const tmpDir = app.getPath('temp');
    const tmpWav = path.join(tmpDir, `songrecog-${Date.now()}.wav`);
    const contentType = currentCodec === 'opus' ? 'ogg' : currentCodec === 'aac' ? 'adts' : 'mp3';

    safeSend('song-recog-progress', { pct: 10, status: 'Capturing stream audio...' });
    console.log('[SongRecog] Starting capture, codec:', currentCodec, 'format:', contentType);

    // Spawn ffmpeg to decode the live encoded stream piped to stdin → WAV file
    await new Promise((resolve, reject) => {
      songRecogCaptureProcess = spawn(ffmpegPath, [
        '-f', contentType,
        '-i', 'pipe:0',
        '-t', String(SONG_RECOG_DURATION),
        '-ar', '44100', '-ac', '2',
        '-y', tmpWav
      ], { stdio: ['pipe', 'pipe', 'pipe'] });

      let stderr = '';
      songRecogCaptureProcess.stderr.on('data', d => { stderr += d.toString(); });

      songRecogCaptureProcess.on('close', (code) => {
        songRecogCaptureProcess = null;
        console.log('[SongRecog] Capture ffmpeg exited, code:', code);
        if (fs.existsSync(tmpWav) && fs.statSync(tmpWav).size > 10000) {
          resolve();
        } else {
          reject(new Error('Capture too small. stderr: ' + stderr.slice(-200)));
        }
      });

      songRecogCaptureProcess.on('error', (err) => {
        songRecogCaptureProcess = null;
        reject(err);
      });

      // Safety timeout — kill after duration + 5s buffer
      setTimeout(() => {
        if (songRecogCaptureProcess) {
          try { songRecogCaptureProcess.stdin.end(); } catch(e) {}
        }
      }, (SONG_RECOG_DURATION + 5) * 1000);
    });

    if (!songRecogActive) return;

    const fileSize = fs.statSync(tmpWav).size;
    safeSend('song-recog-progress', { pct: 60, status: `Captured ${Math.round(fileSize/1024)}KB, fingerprinting...` });
    console.log('[SongRecog] WAV captured:', fileSize, 'bytes');

    // Fingerprint with fpcalc
    const fpcalcResult = await new Promise((resolve, reject) => {
      execFile(fpcalcPath, ['-json', '-length', String(SONG_RECOG_DURATION), tmpWav], { timeout: 30000 }, (err, stdout) => {
        try { fs.unlinkSync(tmpWav); } catch(e) {}
        if (err) return reject(err);
        try { resolve(JSON.parse(stdout)); } catch(e) { reject(e); }
      });
    });

    if (!songRecogActive) return;

    console.log('[SongRecog] Fingerprint:', fpcalcResult.duration, 's, length:', fpcalcResult.fingerprint?.length);
    safeSend('song-recog-progress', { pct: 80, status: `Fingerprint: ${fpcalcResult.fingerprint?.length || 0} chars, looking up...` });

    if (!fpcalcResult.fingerprint || fpcalcResult.fingerprint.length < 50) {
      safeSend('song-recog-progress', { pct: 0, status: 'Audio too quiet or corrupt — no fingerprint' });
      scheduleNextRecogLoop(10000);
      return;
    }

    // Lookup via AcoustID
    const apiKey = global.acoustidApiKey || '';
    const params = new URLSearchParams({
      client: apiKey,
      meta: 'recordings releases releasegroups tracks compress',
      duration: Math.round(fpcalcResult.duration),
      fingerprint: fpcalcResult.fingerprint
    });

    const lookupResult = await new Promise((resolve, reject) => {
      const postData = params.toString();
      const req = https.request({
        hostname: 'api.acoustid.org', port: 443, path: '/v2/lookup', method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) }
      }, (res) => {
        let d = '';
        res.on('data', chunk => d += chunk);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });

    console.log('[SongRecog] API:', lookupResult.status, 'results:', lookupResult.results?.length || 0);

    if (lookupResult.status === 'ok' && lookupResult.results && lookupResult.results.length > 0) {
      const best = lookupResult.results[0];
      if (best.score >= 0.4 && best.recordings && best.recordings.length > 0) {
        const rec = best.recordings[0];
        const title = rec.title || 'Unknown';
        const artist = (rec.artists && rec.artists.length > 0) ? rec.artists.map(a => a.name).join(', ') : 'Unknown';
        const album = (rec.releasegroups && rec.releasegroups.length > 0) ? rec.releasegroups[0].title || '' : '';
        const fullTitle = `${artist} - ${title}`;

        if (fullTitle !== lastRecognizedTitle) {
          lastRecognizedTitle = fullTitle;
          console.log(`[SongRecog] IDENTIFIED: ${fullTitle} (${(best.score * 100).toFixed(0)}%)`);
          safeSend('song-recognized', { title, artist, album, score: Math.round(best.score * 100) });
        } else {
          safeSend('song-recog-progress', { pct: 100, status: `Still playing: ${title}` });
        }
      } else {
        safeSend('song-recog-progress', { pct: 0, status: `No confident match (score: ${best.score ? (best.score * 100).toFixed(0) + '%' : 'N/A'})` });
      }
    } else {
      safeSend('song-recog-progress', { pct: 0, status: 'No match in database' });
    }

  } catch (err) {
    console.error('[SongRecog] Error:', err.message);
    safeSend('song-recog-progress', { pct: 0, status: 'Error: ' + err.message });
  }

  scheduleNextRecogLoop(5000);
}

function scheduleNextRecogLoop(delay) {
  if (!songRecogActive) return;
  songRecogLoopTimer = setTimeout(() => songRecogLoop(), delay);
}

// IPC handlers for song recognition
ipcMain.on('start-song-recog', (event, data) => {
  const apiKey = typeof data === 'string' ? data : data.apiKey;
  const deviceName = typeof data === 'object' ? data.deviceName : '';
  global.acoustidApiKey = apiKey;
  global.songRecogDeviceName = deviceName || '';
  startSongRecognition(apiKey);
});

ipcMain.on('stop-song-recog', () => {
  stopSongRecognition();
});

ipcMain.handle('check-fpcalc', async () => {
  return fs.existsSync(fpcalcPath);
});

ipcMain.handle('test-song-recog', async (event, data) => {
  try {
    const { deviceName, apiKey } = data;

    const tmpDir = app.getPath('temp');
    const tmpFile = path.join(tmpDir, `tonesintime-test-${Date.now()}.wav`);

    // Step 1: List available audio devices
    const deviceList = await new Promise((resolve) => {
      execFile(ffmpegPath, ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
        { timeout: 5000, env: { ...process.env, PATH: (process.env.PATH || '') + ':/opt/homebrew/bin:/usr/local/bin' } },
        (err, stdout, stderr) => {
          // ffmpeg always "fails" with list_devices, output is in stderr
          resolve(stderr || stdout || '');
        });
    });

    console.log('[SongRecog Test] Available devices:\n', deviceList);

    // Find audio device index — look for the device name or use first audio device
    const audioLines = deviceList.split('\n');
    let audioDeviceIndex = '0'; // default
    let foundDevice = 'default';

    // Find audio devices section and pick the right one
    let inAudioSection = false;
    for (const line of audioLines) {
      if (line.includes('audio devices')) { inAudioSection = true; continue; }
      if (inAudioSection) {
        const match = line.match(/\[(\d+)\]\s+(.+)/);
        if (match) {
          const idx = match[1];
          const name = match[2].trim();
          // Prefer Roland or the user-specified device, skip virtual devices
          if (deviceName && name.toLowerCase().includes(deviceName.toLowerCase())) {
            audioDeviceIndex = idx;
            foundDevice = name;
            break;
          }
          if (name.toLowerCase().includes('roland') || name.toLowerCase().includes('audio interface') || name.toLowerCase().includes('usb')) {
            audioDeviceIndex = idx;
            foundDevice = name;
          }
          if (foundDevice === 'default') {
            audioDeviceIndex = idx;
            foundDevice = name;
          }
        }
      }
    }

    console.log('[SongRecog Test] Using audio device:', audioDeviceIndex, '-', foundDevice);
    safeSend('song-recog-progress', { pct: 10, status: `Recording from: ${foundDevice}` });

    // Step 2: Record 15 seconds directly from the audio device via ffmpeg
    await new Promise((resolve, reject) => {
      const args = [
        '-f', 'avfoundation',
        '-i', `:${audioDeviceIndex}`,
        '-t', '15',
        '-ar', '44100',
        '-ac', '2',
        '-y',
        tmpFile
      ];

      console.log('[SongRecog Test] Recording command: ffmpeg', args.join(' '));

      const proc = spawn(ffmpegPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PATH: (process.env.PATH || '') + ':/opt/homebrew/bin:/usr/local/bin' }
      });

      let stderrOut = '';
      proc.stderr.on('data', (d) => { stderrOut += d.toString(); });

      proc.on('close', (code) => {
        console.log('[SongRecog Test] ffmpeg exited with code:', code);
        if (fs.existsSync(tmpFile) && fs.statSync(tmpFile).size > 1000) {
          resolve();
        } else {
          reject(new Error('Recording failed (code ' + code + '): ' + stderrOut.slice(-300)));
        }
      });

      proc.on('error', (err) => reject(err));
    });

    const fileSize = fs.statSync(tmpFile).size;
    console.log('[SongRecog Test] WAV recorded:', fileSize, 'bytes');
    safeSend('song-recog-progress', { pct: 50, status: `Recorded ${Math.round(fileSize/1024)}KB, fingerprinting...` });

    // Check fpcalc exists
    if (!fs.existsSync(fpcalcPath)) {
      return { error: 'fpcalc not found at ' + fpcalcPath };
    }

    // Run fpcalc
    const fpcalcResult = await new Promise((resolve, reject) => {
      execFile(fpcalcPath, ['-json', '-length', '15', tmpFile], { timeout: 30000 }, (err, stdout, stderr) => {
        // Keep the file for debugging — log path
        console.log('[SongRecog Test] WAV file kept at:', tmpFile);
        if (err) return reject(new Error('fpcalc failed: ' + err.message + ' stderr: ' + stderr));
        try { resolve(JSON.parse(stdout)); } catch(e) { reject(new Error('fpcalc bad output: ' + stdout.slice(0, 200))); }
      });
    });

    console.log('[SongRecog Test] Fingerprint — duration:', fpcalcResult.duration, 'length:', fpcalcResult.fingerprint?.length);

    if (!fpcalcResult.fingerprint) {
      return { error: 'No fingerprint generated — audio may be silent', fpLength: 0, fpDuration: fpcalcResult.duration };
    }

    // Query AcoustID
    const params = new URLSearchParams({
      client: apiKey,
      meta: 'recordings recordingids releasegroups releases tracks',
      duration: Math.round(fpcalcResult.duration),
      fingerprint: fpcalcResult.fingerprint
    });

    const lookupResult = await new Promise((resolve, reject) => {
      const postData = params.toString();
      const req = https.request({
        hostname: 'api.acoustid.org', port: 443, path: '/v2/lookup', method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) }
      }, (res) => {
        let d = '';
        res.on('data', chunk => d += chunk);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });

    console.log('[SongRecog Test] API response:', JSON.stringify(lookupResult).slice(0, 500));

    if (lookupResult.status !== 'ok') {
      return { error: 'API error: ' + (lookupResult.error?.message || lookupResult.status), fpLength: fpcalcResult.fingerprint.length, fpDuration: fpcalcResult.duration };
    }

    if (lookupResult.results && lookupResult.results.length > 0) {
      const best = lookupResult.results[0];
      if (best.score >= 0.3 && best.recordings && best.recordings.length > 0) {
        const rec = best.recordings[0];
        return {
          title: rec.title || 'Unknown',
          artist: (rec.artists && rec.artists.length > 0) ? rec.artists.map(a => a.name).join(', ') : 'Unknown',
          album: (rec.releasegroups && rec.releasegroups.length > 0) ? rec.releasegroups[0].title || '' : '',
          score: Math.round(best.score * 100),
          fpLength: fpcalcResult.fingerprint.length,
          fpDuration: fpcalcResult.duration,
          device: foundDevice,
          apiStatus: lookupResult.status,
          apiResults: lookupResult.results.length
        };
      }
    }

    return {
      fpLength: fpcalcResult.fingerprint.length,
      fpDuration: fpcalcResult.duration,
      device: foundDevice,
      apiStatus: lookupResult.status,
      apiResults: lookupResult.results?.length || 0
    };
  } catch (err) {
    console.error('[SongRecog Test] Error:', err);
    return { error: err.message };
  }
});

// Data persistence path
function getDataPath() {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'tonesintime-data.json');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    resizable: true,
    minWidth: 700,
    minHeight: 450,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
}

const CONTENT_TYPES = {
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
  opus: 'audio/ogg'
};

const CODEC_LABELS = {
  mp3: 'MP3',
  aac: 'AAC',
  opus: 'Opus (OGG)'
};

// Start ffmpeg encoder process (for live mode - takes PCM stdin)
function startEncoder(codec, bitrate, sampleRate) {
  if (ffmpegProcess) {
    ffmpegProcess.kill('SIGTERM');
    ffmpegProcess = null;
  }

  // Save config for auto-reconnect
  lastEncoderConfig = { codec, bitrate, sampleRate };
  currentCodec = codec;
  let outputArgs = [];

  switch (codec) {
    case 'mp3':
      outputArgs = ['-c:a', 'libmp3lame', '-b:a', `${bitrate}k`, '-f', 'mp3'];
      break;
    case 'aac':
      outputArgs = ['-c:a', 'aac', '-b:a', `${bitrate}k`, '-f', 'adts'];
      break;
    case 'opus':
      outputArgs = ['-c:a', 'libopus', '-b:a', `${bitrate}k`, '-vbr', 'on', '-application', 'audio', '-f', 'ogg'];
      break;
  }

  const args = [
    '-f', 's16le',
    '-ar', `${sampleRate}`,
    '-ac', '2',
    '-i', 'pipe:0',
    ...outputArgs,
    '-flush_packets', '1',
    'pipe:1'
  ];

  ffmpegProcess = spawn(ffmpegPath, args, {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  ffmpegProcess.stdout.on('data', (data) => {
    broadcastToClients(data);
  });

  ffmpegProcess.stderr.on('data', () => {});

  ffmpegProcess.on('close', (code) => {
    ffmpegProcess = null;
    // Auto-reconnect if unexpected close while streaming
    if (isStreaming && autoReconnect && lastEncoderConfig && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      if (notifyStreamStatus) showNotification('Stream reconnecting...', `Attempt ${reconnectAttempts}`);
      safeSend('reconnect-status', { attempting: true, attempt: reconnectAttempts });
      reconnectTimer = setTimeout(() => {
        if (isStreaming && lastEncoderConfig) {
          startEncoder(lastEncoderConfig.codec, lastEncoderConfig.bitrate, lastEncoderConfig.sampleRate);
          reconnectAttempts = 0;
          safeSend('reconnect-status', { attempting: false, attempt: 0 });
        }
      }, RECONNECT_DELAY_MS);
    }
  });

  reconnectAttempts = 0;
  return ffmpegProcess;
}

function stopEncoder() {
  autoReconnect = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ffmpegProcess) {
    try {
      ffmpegProcess.stdin.end();
      ffmpegProcess.kill('SIGTERM');
    } catch (e) {}
    ffmpegProcess = null;
  }
  lastEncoderConfig = null;
  reconnectAttempts = 0;
}

// Built-in HTTP streaming server
function startStreamServer(port, mount, codec) {
  return new Promise((resolve, reject) => {
    if (streamServer) {
      streamServer.close();
      connectedClients = [];
    }

    serverPort = port;
    streamMount = mount.startsWith('/') ? mount : '/' + mount;
    currentCodec = codec || 'mp3';

    streamServer = http.createServer((req, res) => {
      if (req.url === '/') {
        const html = `<!DOCTYPE html><html><head><title>TonesinTime</title>
          <style>body{font-family:-apple-system,sans-serif;background:#1c1c1e;color:#f5f5f7;padding:40px;max-width:500px;margin:0 auto;}
          h1{font-size:24px;}a{color:#64d2ff;}p{color:rgba(255,255,255,0.6);line-height:1.8;}</style></head><body>
          <h1>TonesinTime</h1>
          <p>Stream: <a href="${streamMount}">${streamMount}</a></p>
          <p>Codec: ${CODEC_LABELS[currentCodec]}</p>
          <p>Listeners: ${connectedClients.length}</p>
          <p>Status: ${isStreaming ? 'LIVE' : 'Offline'}</p>
          <p>Now Playing: ${streamMetadata.song || streamMetadata.title}</p>
        </body></html>`;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        return;
      }

      // Status API — returns JSON for website/embed to poll
      if (req.url === '/status') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache'
        });
        res.end(JSON.stringify({
          live: isStreaming,
          title: streamMetadata.title || 'TonesinTime',
          song: streamMetadata.song || '',
          artist: streamMetadata.artist || '',
          listeners: connectedClients.length,
          countdown: streamMetadata.countdown || 0,
          nextEvent: streamMetadata.nextEvent || ''
        }));
        return;
      }

      // CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400'
        });
        res.end();
        return;
      }

      // Now Playing API
      if (req.url === '/nowplaying') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache'
        });
        res.end(JSON.stringify({
          title: nowPlayingData.title || streamMetadata.song || streamMetadata.title || '',
          artist: nowPlayingData.artist || streamMetadata.artist || '',
          duration: nowPlayingData.duration || 0,
          elapsed: nowPlayingData.elapsed || 0,
          playlist: nowPlayingData.playlist || ''
        }));
        return;
      }

      // Now Playing HTML widget
      if (req.url === '/nowplaying.html') {
        const npHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Now Playing - TonesinTime</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
@keyframes slideIn{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:transparent;display:flex;align-items:center;justify-content:center;min-height:100vh;overflow:hidden}
.card{background:rgba(20,20,30,0.55);backdrop-filter:blur(40px);-webkit-backdrop-filter:blur(40px);border:1px solid rgba(255,255,255,0.1);border-radius:20px;padding:28px 32px;max-width:420px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,0.4),inset 0 1px 0 rgba(255,255,255,0.05);animation:slideIn 0.6s ease}
.top-row{display:flex;align-items:center;gap:12px;margin-bottom:16px}
.disc{width:48px;height:48px;border-radius:50%;background:conic-gradient(from 0deg,#1a1a2e,#2d2d44,#1a1a2e);border:3px solid rgba(255,255,255,0.08);flex-shrink:0;position:relative}
.disc::after{content:'';position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:12px;height:12px;border-radius:50%;background:rgba(255,255,255,0.1)}
.disc.spinning{animation:spin 3s linear infinite}
.live-badge{display:inline-flex;align-items:center;gap:5px;font-size:9px;font-weight:700;letter-spacing:0.12em;color:#ff4444;background:rgba(255,68,68,0.12);padding:3px 10px;border-radius:99px}
.live-dot{width:6px;height:6px;border-radius:50%;background:#ff4444;animation:pulse 1.5s ease-in-out infinite}
.offline-badge{display:inline-flex;font-size:9px;font-weight:700;letter-spacing:0.12em;color:rgba(255,255,255,0.35);background:rgba(255,255,255,0.06);padding:3px 10px;border-radius:99px}
.meta{flex:1;min-width:0}
.title{font-size:18px;font-weight:700;color:#f0f0f5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3}
.artist{font-size:13px;color:rgba(240,240,245,0.5);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.progress-wrap{margin-top:4px}
.progress-bar{height:4px;background:rgba(255,255,255,0.08);border-radius:2px;overflow:hidden}
.progress-fill{height:100%;background:linear-gradient(90deg,#7c5bf5,#a78bfa);border-radius:2px;transition:width 1s linear;width:0%}
.times{display:flex;justify-content:space-between;margin-top:5px}
.times span{font-size:10px;color:rgba(240,240,245,0.35);font-family:'SF Mono',monospace}
.playlist-name{margin-top:12px;font-size:10px;color:rgba(240,240,245,0.25);text-transform:uppercase;letter-spacing:0.1em;text-align:center}
.idle{text-align:center;padding:20px 0;color:rgba(240,240,245,0.3);font-size:13px}
</style></head><body>
<div class="card" id="card">
  <div id="content" class="idle">Waiting for stream...</div>
</div>
<script>
function fmt(s){if(!s||s<=0)return'0:00';const m=Math.floor(s/60);const sec=Math.floor(s%60);return m+':'+String(sec).padStart(2,'0')}
function update(){
  fetch('/nowplaying').then(r=>r.json()).then(d=>{
    const c=document.getElementById('content');
    if(!d.title&&!d.artist){c.className='idle';c.innerHTML='Waiting for stream...';return}
    const pct=d.duration>0?Math.min(100,(d.elapsed/d.duration)*100):0;
    const playing=!!(d.title||d.artist);
    c.className='';
    c.innerHTML=
      '<div class="top-row">'+
        '<div class="disc'+(playing?' spinning':'')+'"></div>'+
        '<div class="meta">'+
          '<div class="title">'+(d.title||'Unknown Track')+'</div>'+
          '<div class="artist">'+(d.artist||'Unknown Artist')+'</div>'+
        '</div>'+
        (playing?'<span class="live-badge"><span class="live-dot"></span>LIVE</span>':'<span class="offline-badge">OFFLINE</span>')+
      '</div>'+
      '<div class="progress-wrap">'+
        '<div class="progress-bar"><div class="progress-fill" style="width:'+pct+'%"></div></div>'+
        '<div class="times"><span>'+fmt(d.elapsed)+'</span><span>'+fmt(d.duration)+'</span></div>'+
      '</div>'+
      (d.playlist?'<div class="playlist-name">'+d.playlist+'</div>':'');
  }).catch(()=>{
    document.getElementById('content').className='idle';
    document.getElementById('content').innerHTML='Waiting for stream...';
  });
}
update();setInterval(update,2000);
</script></body></html>`;
        res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
        res.end(npHtml);
        return;
      }

      if (req.url === streamMount || req.url === streamMount + '/') {
        const contentType = CONTENT_TYPES[currentCodec] || 'audio/mpeg';
        const bitrate = currentBitrate || 256;

        // Detect ICY metadata support (most players send this header)
        const wantsIcy = req.headers['icy-metadata'] === '1';

        // Use raw response to avoid Node's chunked encoding — Chrome handles
        // a continuous byte stream far better than Transfer-Encoding: chunked.
        // Writing directly to the socket with HTTP/1.0-style headers forces
        // identity transfer encoding which Chrome's audio pipeline prefers.
        res.useChunkedEncodingByDefault = false;

        const headers = {
          'Content-Type': contentType,
          'Connection': 'close',
          'Cache-Control': 'no-cache, no-store, no-transform',
          'Pragma': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET',
          'Accept-Ranges': 'none',
          'icy-name': streamMetadata.title || 'TonesinTime',
          'icy-genre': 'Various',
          'icy-br': String(bitrate),
          'icy-sr': '44100',
          'icy-pub': '1'
        };

        // If client wants ICY metadata, set the metaint header
        if (wantsIcy) {
          headers['icy-metaint'] = '16384';
        }

        res.writeHead(200, headers);

        // Disable Nagle's algorithm for lower latency
        req.socket.setNoDelay(true);

        // Send initial burst from buffer so Chrome has data immediately
        // This prevents the long initial buffering delay
        if (streamBurstBuffer.length > 0) {
          try {
            const burst = Buffer.concat(streamBurstBuffer);
            res.write(burst);
          } catch (e) { /* client may have disconnected */ }
        }

        const client = {
          id: Date.now() + Math.random(),
          res,
          ip: req.socket.remoteAddress,
          connectedAt: Date.now(),
          wantsIcy,
          icyByteCount: 0
        };
        connectedClients.push(client);
        totalSessions++;
        if (connectedClients.length > peakListeners) peakListeners = connectedClients.length;
        sendListenerDetails();

        req.on('close', () => {
          connectedClients = connectedClients.filter(c => c.id !== client.id);
          sendListenerDetails();
        });

        // Keep the connection alive with periodic padding if needed
        client.keepAliveTimer = setInterval(() => {
          if (!client.res.destroyed) {
            try { client.res.write(Buffer.alloc(0)); } catch (e) {
              clearInterval(client.keepAliveTimer);
            }
          } else {
            clearInterval(client.keepAliveTimer);
          }
        }, 15000);

        req.on('close', () => {
          if (client.keepAliveTimer) clearInterval(client.keepAliveTimer);
        });

        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    streamServer.on('error', (err) => reject(err));
    streamServer.listen(port, '0.0.0.0', () => resolve({ port, mount: streamMount }));
  });
}

function buildIcyMetadata() {
  const song = streamMetadata.song || `${streamMetadata.artist || ''} - ${streamMetadata.title || ''}`.replace(/^ - | - $/g, '');
  const text = `StreamTitle='${song.replace(/'/g, "\\'")}';`;
  // ICY metadata block: 1 byte length prefix (in 16-byte units), then padded text
  const metaLen = Math.ceil(text.length / 16);
  const block = Buffer.alloc(1 + metaLen * 16, 0);
  block[0] = metaLen;
  block.write(text, 1, 'utf-8');
  return block;
}

function broadcastToClients(buffer) {
  // Add to burst buffer for new client quick-start
  streamBurstBuffer.push(buffer);
  if (streamBurstBuffer.length > BURST_BUFFER_MAX) {
    streamBurstBuffer.shift();
  }

  // Feed to song recognition (taps the actual broadcast audio)
  feedSongRecogStream(buffer);

  const deadClients = [];
  const ICY_METAINT = 16384;

  connectedClients.forEach(client => {
    try {
      if (client.wantsIcy) {
        // Interleave ICY metadata at the correct byte interval
        let offset = 0;
        while (offset < buffer.length) {
          const remaining = ICY_METAINT - client.icyByteCount;
          const chunk = buffer.slice(offset, offset + remaining);
          client.res.write(chunk);
          client.icyByteCount += chunk.length;
          offset += chunk.length;

          if (client.icyByteCount >= ICY_METAINT) {
            // Insert ICY metadata block
            client.res.write(buildIcyMetadata());
            client.icyByteCount = 0;
          }
        }
      } else {
        client.res.write(buffer);
      }
    } catch (e) {
      deadClients.push(client.id);
    }
  });
  if (deadClients.length > 0) {
    healthDroppedConnections += deadClients.length;
    connectedClients = connectedClients.filter(c => !deadClients.includes(c.id));
    safeSend('listener-update', connectedClients.length);
  }

  // Track stream health bytes
  const now = Date.now();
  healthBytesSent += buffer.length;
  healthBytesWindow.push({ time: now, bytes: buffer.length });
  // Keep only last 60 seconds
  const cutoff = now - 60000;
  healthBytesWindow = healthBytesWindow.filter(e => e.time >= cutoff);

  // Write to recording file if recording
  if (isRecording && recordingStream && recordingStream.writable) {
    try {
      recordingStream.write(buffer);
      recordingBytesWritten += buffer.length;
    } catch (e) {
      // Stop recording on write error
      stopRecordingInternal();
    }
  }
}

let lastListenerCount = 0;

function sendListenerDetails() {
  const now = Date.now();
  const currentCount = connectedClients.length;
  safeSend('listener-update', currentCount);
  safeSend('listener-details', {
    current: currentCount,
    peak: peakListeners,
    totalSessions,
    clients: connectedClients.map(c => ({
      ip: (c.ip || '').replace('::ffff:', ''),
      duration: Math.floor((now - c.connectedAt) / 1000)
    }))
  });

  // Notification on listener connect
  if (currentCount > lastListenerCount && notifyListenerConnect) {
    showNotification('Listener connected', `${currentCount} listener${currentCount !== 1 ? 's' : ''} connected`);
  }
  lastListenerCount = currentCount;

  // Update tray
  updateTrayTooltip();
  updateTrayMenu();
}

function stopStreamServer() {
  connectedClients.forEach(client => {
    if (client.keepAliveTimer) clearInterval(client.keepAliveTimer);
    try { client.res.end(); } catch (e) {}
  });
  connectedClients = [];
  streamBurstBuffer = [];
  if (streamServer) { streamServer.close(); streamServer = null; }
}

// ===================== AUTO-DJ =====================

function getFileMetadata(filePath) {
  return new Promise((resolve) => {
    // Try ffprobe first, fall back to basic info
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ];

    execFile(ffprobePath, args, { timeout: 10000 }, (err, stdout) => {
      const basename = path.basename(filePath, path.extname(filePath));
      let title = basename;
      let artist = 'Unknown Artist';
      let duration = 0;

      if (!err && stdout) {
        try {
          const info = JSON.parse(stdout);
          if (info.format) {
            duration = parseFloat(info.format.duration) || 0;
            const tags = info.format.tags || {};
            // Tags can be different cases
            title = tags.title || tags.TITLE || basename;
            artist = tags.artist || tags.ARTIST || tags.album_artist || tags.ALBUM_ARTIST || 'Unknown Artist';
          }
        } catch (e) {}
      }

      resolve({
        path: filePath,
        title,
        artist,
        duration,
        filename: path.basename(filePath)
      });
    });
  });
}

let crossfadeDuration = 4; // seconds (adjustable from UI)
let crossfadeTimer = null;
let crossfadeProcess = null;
let currentBitrate = 128;
let currentSampleRate = 44100;

function getOutputArgs(codec, bitrate) {
  switch (codec) {
    case 'mp3': return ['-c:a', 'libmp3lame', '-b:a', `${bitrate}k`, '-f', 'mp3'];
    case 'aac': return ['-c:a', 'aac', '-b:a', `${bitrate}k`, '-f', 'adts'];
    case 'opus': return ['-c:a', 'libopus', '-b:a', `${bitrate}k`, '-vbr', 'on', '-application', 'audio', '-f', 'ogg'];
    default: return ['-c:a', 'libmp3lame', '-b:a', `${bitrate}k`, '-f', 'mp3'];
  }
}

function startAutoDjTrack(trackIndex, codec, bitrate, sampleRate) {
  if (!autoDjActive || autoDjPlaylist.length === 0) return;

  const order = autoDjShuffle ? autoDjShuffledOrder : autoDjPlaylist.map((_, i) => i);
  if (order.length === 0) return;

  const idx = trackIndex % order.length;
  autoDjCurrentIndex = idx;
  const track = autoDjPlaylist[order[idx]];

  if (!track || !track.path) {
    startAutoDjTrack(trackIndex + 1, codec, bitrate, sampleRate);
    return;
  }

  // Update metadata
  streamMetadata.song = `${track.artist} - ${track.title}`;
  nowPlayingData.title = track.title;
  nowPlayingData.artist = track.artist;
  nowPlayingData.duration = track.duration || 0;
  nowPlayingData.elapsed = 0;
  safeSend('now-playing', {
    title: track.title,
    artist: track.artist,
    index: idx,
    total: order.length,
    path: track.path
  });

  const outputArgs = getOutputArgs(codec, bitrate);

  // Apply fade-in to the start of this track
  const fadeInFilter = `afade=t=in:st=0:d=${crossfadeDuration}`;

  const encodeArgs = [
    '-i', track.path,
    '-af', fadeInFilter,
    '-ar', `${sampleRate}`,
    '-ac', '2',
    ...outputArgs,
    '-flush_packets', '1',
    'pipe:1'
  ];

  // Clean up previous
  if (crossfadeTimer) { clearTimeout(crossfadeTimer); crossfadeTimer = null; }

  // If there's an existing process, let it fade out while we start the new one
  if (autoDjProcess) {
    const oldProcess = autoDjProcess;
    setTimeout(() => {
      try { oldProcess.kill('SIGTERM'); } catch (e) {}
    }, crossfadeDuration * 1000);
    autoDjProcess = null;
  }

  console.log('[AutoDJ] Playing:', track.title, '-', track.path);

  autoDjProcess = spawn(ffmpegPath, encodeArgs, {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  autoDjProcess.on('error', (err) => {
    console.error('[AutoDJ] ffmpeg error:', err.message);
  });

  autoDjProcess.stdout.on('data', (data) => {
    broadcastToClients(data);
    safeSend('autodj-audio-data', data.length);
  });

  autoDjProcess.stderr.on('data', (data) => {
    const str = data.toString();
    const timeMatch = str.match(/time=(\d+):(\d+):(\d+\.\d+)/);
    if (timeMatch) {
      const secs = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseFloat(timeMatch[3]);
      nowPlayingData.elapsed = Math.floor(secs);
      safeSend('autodj-progress', {
        currentTime: secs,
        duration: track.duration
      });

      // Start next track early for crossfade (when current track is near the end)
      if (track.duration > crossfadeDuration * 2 && secs >= track.duration - crossfadeDuration && !crossfadeTimer) {
        crossfadeTimer = setTimeout(() => {}, 0); // flag to prevent re-trigger
        // Start fade-out on current track by spawning a new process with fade
        startCrossfadeToNext(trackIndex + 1, codec, bitrate, sampleRate);
      }
    }
  });

  autoDjProcess.on('close', (code) => {
    // Only advance if crossfade didn't already start the next track
    if (autoDjProcess && autoDjProcess.pid === undefined) return;
    if (autoDjActive && !crossfadeTimer) {
      autoDjProcess = null;
      startAutoDjTrack(trackIndex + 1, codec, bitrate, sampleRate);
    }
  });

  // Start analysis for VU meters
  startAnalysisProcess(track.path, sampleRate);
}

function startCrossfadeToNext(nextIndex, codec, bitrate, sampleRate) {
  if (!autoDjActive || autoDjPlaylist.length === 0) return;

  const order = autoDjShuffle ? autoDjShuffledOrder : autoDjPlaylist.map((_, i) => i);
  if (order.length === 0) return;

  const idx = nextIndex % order.length;
  const nextTrack = autoDjPlaylist[order[idx]];
  if (!nextTrack || !nextTrack.path) return;

  // Kill the old process after crossfade duration
  const oldProcess = autoDjProcess;
  autoDjProcess = null;

  // Update metadata to next track
  autoDjCurrentIndex = idx;
  streamMetadata.song = `${nextTrack.artist} - ${nextTrack.title}`;
  nowPlayingData.title = nextTrack.title;
  nowPlayingData.artist = nextTrack.artist;
  nowPlayingData.duration = nextTrack.duration || 0;
  nowPlayingData.elapsed = 0;
  safeSend('now-playing', {
    title: nextTrack.title,
    artist: nextTrack.artist,
    index: idx,
    total: order.length,
    path: nextTrack.path
  });

  const outputArgs = getOutputArgs(codec, bitrate);
  const fadeInFilter = `afade=t=in:st=0:d=${crossfadeDuration}`;

  const encodeArgs = [
    '-i', nextTrack.path,
    '-af', fadeInFilter,
    '-ar', `${sampleRate}`,
    '-ac', '2',
    ...outputArgs,
    '-flush_packets', '1',
    'pipe:1'
  ];

  autoDjProcess = spawn(ffmpegPath, encodeArgs, {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  autoDjProcess.stdout.on('data', (data) => {
    broadcastToClients(data);
    safeSend('autodj-audio-data', data.length);
  });

  autoDjProcess.stderr.on('data', (data) => {
    const str = data.toString();
    const timeMatch = str.match(/time=(\d+):(\d+):(\d+\.\d+)/);
    if (timeMatch) {
      const secs = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseFloat(timeMatch[3]);
      nowPlayingData.elapsed = Math.floor(secs);
      safeSend('autodj-progress', {
        currentTime: secs,
        duration: nextTrack.duration
      });

      if (nextTrack.duration > crossfadeDuration * 2 && secs >= nextTrack.duration - crossfadeDuration && !crossfadeTimer) {
        crossfadeTimer = setTimeout(() => {}, 0);
        startCrossfadeToNext(nextIndex + 1, codec, bitrate, sampleRate);
      }
    }
  });

  autoDjProcess.on('close', (code) => {
    if (autoDjActive && !crossfadeTimer) {
      autoDjProcess = null;
      crossfadeTimer = null;
      startAutoDjTrack(nextIndex + 1, codec, bitrate, sampleRate);
    }
  });

  // Fade out and kill old process
  setTimeout(() => {
    if (oldProcess) {
      try { oldProcess.kill('SIGTERM'); } catch (e) {}
    }
    crossfadeTimer = null;
  }, crossfadeDuration * 1000);

  startAnalysisProcess(nextTrack.path, sampleRate);
}

let analysisProcess = null;

function startAnalysisProcess(filePath, sampleRate) {
  if (analysisProcess) {
    try { analysisProcess.kill('SIGTERM'); } catch (e) {}
    analysisProcess = null;
  }

  const args = [
    '-i', filePath,
    '-ar', `${sampleRate}`,
    '-ac', '2',
    '-f', 's16le',
    '-acodec', 'pcm_s16le',
    'pipe:1'
  ];

  analysisProcess = spawn(ffmpegPath, args, {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  analysisProcess.stdout.on('data', (data) => {
    // Send raw PCM to renderer for VU meter and spectrum analysis
    // Throttle: only send chunks periodically
    safeSend('autodj-pcm', Array.from(new Uint8Array(data.slice(0, 8192))));
  });

  analysisProcess.stderr.on('data', () => {});

  analysisProcess.on('close', () => {
    analysisProcess = null;
  });
}

function stopAnalysisProcess() {
  if (analysisProcess) {
    try { analysisProcess.kill('SIGTERM'); } catch (e) {}
    analysisProcess = null;
  }
}

function shuffleArray(arr) {
  const shuffled = arr.map((_, i) => i);
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function stopAutoDj() {
  autoDjActive = false;
  if (autoDjProcess) {
    try { autoDjProcess.kill('SIGTERM'); } catch (e) {}
    autoDjProcess = null;
  }
  stopAnalysisProcess();
  autoDjPlaylist = [];
  autoDjCurrentIndex = 0;
  nowPlayingData = { title: '', artist: '', duration: 0, elapsed: 0, playlist: '' };
  safeSend('now-playing', null);
}

// Schedule checker
function startScheduleChecker() {
  if (scheduleInterval) return;
  scheduleInterval = setInterval(() => {
    checkSchedules();
  }, 30000);
}

function checkSchedules() {
  try {
    const dataPath = getDataPath();
    if (!fs.existsSync(dataPath)) return;
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    const schedules = data.schedules || [];
    const playlists = data.playlists || [];

    const now = new Date();
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const currentDay = dayNames[now.getDay()];
    const currentTime = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');

    let shouldBeActive = null;
    for (const schedule of schedules) {
      if (!schedule.enabled) continue;
      const dayMatch = schedule.day === 'Every Day' || schedule.day === currentDay;
      if (!dayMatch) continue;
      if (currentTime >= schedule.startTime && currentTime < schedule.endTime) {
        shouldBeActive = schedule;
        break;
      }
    }

    if (shouldBeActive && !autoDjActive && !isStreaming) {
      // Find the playlist
      const playlist = playlists.find(p => p.name === shouldBeActive.playlist);
      if (playlist && playlist.tracks.length > 0) {
        activeScheduleId = shouldBeActive.id;
        safeSend('schedule-triggered', {
          schedule: shouldBeActive,
          playlist: playlist
        });
      }
    } else if (!shouldBeActive && autoDjActive && activeScheduleId) {
      // Schedule ended, stop auto-DJ
      activeScheduleId = null;
      safeSend('schedule-ended');
    }
  } catch (e) {
    // Silently ignore schedule check errors
  }
}

// IPC handlers
// Server-only start — no audio encoding, just HTTP server + tunnel
ipcMain.handle('start-server-only', async (event, config) => {
  try {
    const result = await startStreamServer(config.port, config.mount, config.codec || 'mp3');
    streamMetadata.title = config.stationName || 'TonesinTime';
    peakListeners = 0;
    totalSessions = 0;
    startHealthMonitor();
    if (notifyStreamStatus) showNotification('Server started', `Port ${config.port}`);
    updateTrayTooltip();
    updateTrayMenu();
    // Permanent tunnel runs as system service — no need to start from app
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('start-server', async (event, config) => {
  try {
    // Only start HTTP server if not already running
    if (!streamServer) {
      await startStreamServer(config.port, config.mount, config.codec);
      peakListeners = 0;
      totalSessions = 0;
      startHealthMonitor();
    }
    streamMetadata.title = config.stationName || 'TonesinTime';
    autoReconnect = true;
    startEncoder(config.codec, config.bitrate, config.sampleRate || 44100);
    if (notifyStreamStatus) showNotification('Stream started', `Listening on port ${config.port}`);
    updateTrayTooltip();
    updateTrayMenu();
    // Permanent tunnel runs as system service — no need to start from app
    return { success: true, codec: config.codec };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('stop-server', async () => {
  if (isRecording) stopRecordingInternal();
  stopHealthMonitor();
  stopEncoder();
  stopStreamServer();
  stopTunnel();
  isStreaming = false;
  relayUpdateStream(''); // Tell relay we're offline
  if (notifyStreamStatus) showNotification('Stream stopped', '');
  updateTrayTooltip();
  updateTrayMenu();
  return { success: true };
});

ipcMain.on('pcm-data', (event, data) => {
  isStreaming = true;
  if (ffmpegProcess && ffmpegProcess.stdin.writable) {
    try { ffmpegProcess.stdin.write(Buffer.from(data)); } catch (e) {}
  }
});

ipcMain.on('stream-stopped', () => {
  isStreaming = false;
  stopEncoder();
});

ipcMain.on('update-metadata', (event, metadata) => {
  streamMetadata = { ...streamMetadata, ...metadata };
  // Update now playing from manual input
  if (metadata.song) {
    const parts = metadata.song.split(' - ');
    if (parts.length >= 2) {
      nowPlayingData.artist = parts[0].trim();
      nowPlayingData.title = parts.slice(1).join(' - ').trim();
    } else {
      nowPlayingData.title = metadata.song;
    }
  }
  if (metadata.title && !metadata.song) {
    nowPlayingData.title = metadata.title;
  }
});

ipcMain.handle('get-local-ip', async () => {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
});

ipcMain.handle('get-public-ip', async () => {
  try {
    return await new Promise((resolve) => {
      const https = require('https');
      https.get('https://api.ipify.org', (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => resolve(data.trim()));
      }).on('error', () => {
        // Fallback
        const http2 = require('http');
        http2.get('http://checkip.amazonaws.com', (res) => {
          let data = '';
          res.on('data', (chunk) => data += chunk);
          res.on('end', () => resolve(data.trim()));
        }).on('error', () => resolve(''));
      });
    });
  } catch (e) { return ''; }
});

ipcMain.handle('get-tunnel-status', async () => {
  return {
    installed: findCloudflared(),
    running: tunnelRunning,
    url: tunnelUrl
  };
});

ipcMain.handle('check-ffmpeg', async () => {
  try {
    const test = spawn(ffmpegPath, ['-version']);
    return new Promise((resolve) => {
      test.on('close', (code) => resolve(code === 0));
      test.on('error', () => resolve(false));
    });
  } catch (e) { return false; }
});

// ===================== AUTO-DJ IPC =====================

ipcMain.handle('select-audio-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Audio Files',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Audio Files', extensions: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'aiff'] }
    ]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true, files: [] };
  }

  const files = [];
  for (const filePath of result.filePaths) {
    const meta = await getFileMetadata(filePath);
    files.push(meta);
  }

  return { canceled: false, files };
});

ipcMain.handle('start-autodj', async (event, config) => {
  try {
    // config: { tracks, codec, bitrate, sampleRate, port, mount, stationName, shuffle }
    const { tracks, codec, bitrate, sampleRate, port, mount, stationName, shuffle } = config;

    if (!tracks || tracks.length === 0) {
      return { success: false, error: 'No tracks provided' };
    }

    // Validate tracks have paths
    const validTracks = tracks.filter(t => t && t.path && fs.existsSync(t.path));
    if (validTracks.length === 0) {
      return { success: false, error: 'No valid track files found. Tracks may have been moved or deleted.' };
    }

    // Start stream server if not already running
    if (!streamServer) {
      await startStreamServer(port, mount, codec);
    }

    streamMetadata.title = stationName || 'TonesinTime';
    nowPlayingData.playlist = config.playlistName || '';
    currentCodec = codec;
    currentBitrate = bitrate;
    currentSampleRate = sampleRate || 44100;
    autoDjActive = true;
    autoDjPlaylist = validTracks;
    autoDjShuffle = shuffle || false;
    autoDjCurrentIndex = 0;
    isStreaming = true;

    if (autoDjShuffle) {
      autoDjShuffledOrder = shuffleArray(tracks);
    }

    // Stop any live encoder
    if (ffmpegProcess) {
      stopEncoder();
    }

    // Start playing first track
    startAutoDjTrack(0, codec, bitrate, sampleRate || 44100);
    startHealthMonitor();
    if (notifyStreamStatus) showNotification('Program started', stationName || 'TonesinTime');
    updateTrayTooltip();
    updateTrayMenu();
    // Permanent tunnel runs as system service

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('stop-autodj', async () => {
  if (isRecording) stopRecordingInternal();
  stopHealthMonitor();
  stopAutoDj();
  stopStreamServer();
  stopTunnel();
  isStreaming = false;
  relayUpdateStream(''); // Tell relay we're offline
  if (notifyStreamStatus) showNotification('Program stopped', '');
  updateTrayTooltip();
  updateTrayMenu();
  return { success: true };
});

ipcMain.handle('save-data', async (event, data) => {
  try {
    const dataPath = getDataPath();
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('load-data', async () => {
  try {
    const dataPath = getDataPath();
    if (fs.existsSync(dataPath)) {
      const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
      return { success: true, data };
    }
    return { success: true, data: { library: [], playlists: [], schedules: [] } };
  } catch (err) {
    return { success: false, error: err.message, data: { library: [], playlists: [], schedules: [] } };
  }
});

ipcMain.handle('get-track-metadata', async (event, filePath) => {
  return await getFileMetadata(filePath);
});

// ===================== SOUND BOARD =====================

let activeSoundProcesses = [];

ipcMain.handle('play-sound', async (event, filePath) => {
  try {
    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'File not found' };
    }
    if (!isStreaming) {
      return { success: false, error: 'Not streaming' };
    }

    const codec = currentCodec || 'mp3';
    const outputArgs = getOutputArgs(codec, 192);

    const soundProcess = spawn(ffmpegPath, [
      '-i', filePath,
      '-ar', '44100',
      '-ac', '2',
      ...outputArgs,
      '-flush_packets', '1',
      'pipe:1'
    ], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    activeSoundProcesses.push(soundProcess);

    soundProcess.stdout.on('data', (data) => {
      broadcastToClients(data);
    });

    soundProcess.stderr.on('data', () => {});

    soundProcess.on('close', () => {
      activeSoundProcesses = activeSoundProcesses.filter(p => p !== soundProcess);
      safeSend('sound-finished', filePath);
    });

    soundProcess.on('error', (err) => {
      console.error('[SoundBoard] ffmpeg error:', err.message);
      activeSoundProcesses = activeSoundProcesses.filter(p => p !== soundProcess);
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('select-sound-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Sound Effect',
    properties: ['openFile'],
    filters: [
      { name: 'Audio Files', extensions: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'aiff'] }
    ]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }

  return { canceled: false, filePath: result.filePaths[0], filename: path.basename(result.filePaths[0]) };
});

// ===================== RECORDING =====================

function getRecordingFilePath() {
  const os = require('os');
  let dir;
  try {
    dir = app.getPath('music');
  } catch (e) {
    dir = app.getPath('desktop');
  }
  const now = new Date();
  const dateStr = now.getFullYear() + '-' +
    String(now.getMonth() + 1).padStart(2, '0') + '-' +
    String(now.getDate()).padStart(2, '0') + '_' +
    String(now.getHours()).padStart(2, '0') + '-' +
    String(now.getMinutes()).padStart(2, '0');
  const ext = currentCodec === 'aac' ? 'aac' : currentCodec === 'opus' ? 'ogg' : 'mp3';
  return path.join(dir, `TonesinTime_${dateStr}.${ext}`);
}

function stopRecordingInternal() {
  const wasRecording = isRecording;
  isRecording = false;
  if (recordingStream) {
    try { recordingStream.end(); } catch (e) {}
    recordingStream = null;
  }
  if (wasRecording && notifyRecordingStatus) showNotification('Recording stopped', recordingFilePath || '');
  safeSend('recording-status', { recording: false, duration: 0, fileSize: 0, filePath: recordingFilePath });
  recordingFilePath = null;
  recordingBytesWritten = 0;
  recordingStartTime = null;
}

ipcMain.handle('start-recording', async () => {
  if (isRecording) return { success: false, error: 'Already recording' };
  if (!isStreaming) return { success: false, error: 'Not streaming' };

  try {
    recordingFilePath = getRecordingFilePath();
    recordingStream = fs.createWriteStream(recordingFilePath);
    recordingBytesWritten = 0;
    recordingStartTime = Date.now();
    isRecording = true;
    if (notifyRecordingStatus) showNotification('Recording started', recordingFilePath);
    updateTrayMenu();

    // Start sending recording status updates
    const recStatusInterval = setInterval(() => {
      if (!isRecording) {
        clearInterval(recStatusInterval);
        return;
      }
      const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
      safeSend('recording-status', {
        recording: true,
        duration: elapsed,
        fileSize: recordingBytesWritten,
        filePath: recordingFilePath
      });
    }, 500);

    return { success: true, filePath: recordingFilePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('stop-recording', async () => {
  if (!isRecording) return { success: false, error: 'Not recording' };
  const savedPath = recordingFilePath;
  stopRecordingInternal();
  return { success: true, filePath: savedPath };
});

// ===================== STREAM HEALTH =====================

function startHealthMonitor() {
  if (healthInterval) return;
  healthBytesSent = 0;
  healthBytesWindow = [];
  healthDroppedConnections = 0;

  healthInterval = setInterval(() => {
    if (!isStreaming) {
      stopHealthMonitor();
      return;
    }

    const now = Date.now();
    const cutoff = now - 60000;
    healthBytesWindow = healthBytesWindow.filter(e => e.time >= cutoff);

    // Calculate current bitrate from last 2 seconds
    const recentCutoff = now - 2000;
    const recentBytes = healthBytesWindow
      .filter(e => e.time >= recentCutoff)
      .reduce((sum, e) => sum + e.bytes, 0);
    const bitrateKbps = Math.round((recentBytes * 8) / 2000); // kbps over 2s window

    // Build sparkline data: bitrate per second for last 60 seconds
    const sparkline = [];
    for (let s = 59; s >= 0; s--) {
      const secStart = now - (s + 1) * 1000;
      const secEnd = now - s * 1000;
      const secBytes = healthBytesWindow
        .filter(e => e.time >= secStart && e.time < secEnd)
        .reduce((sum, e) => sum + e.bytes, 0);
      sparkline.push(Math.round((secBytes * 8) / 1000)); // kbps
    }

    safeSend('stream-health', {
      bitrateKbps,
      totalBytesSent: healthBytesSent,
      droppedConnections: healthDroppedConnections,
      bufferOk: ffmpegProcess !== null && ffmpegProcess.stdin.writable,
      sparkline
    });

    // Also update listener details (durations)
    sendListenerDetails();
  }, 1000);
}

function stopHealthMonitor() {
  if (healthInterval) {
    clearInterval(healthInterval);
    healthInterval = null;
  }
}

// ===================== NOTIFICATIONS =====================

function showNotification(title, body) {
  if (!notificationsEnabled) return;
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}

// ===================== TRAY =====================

function createTray() {
  const iconPath = path.join(__dirname, 'build', 'icon-16.png');
  let trayIcon;
  if (process.platform === 'darwin') {
    trayIcon = nativeImage.createFromPath(iconPath);
    trayIcon.setTemplateImage(true);
  } else {
    trayIcon = nativeImage.createFromPath(iconPath);
  }
  tray = new Tray(trayIcon);
  tray.setToolTip('TonesinTime - Offline');
  updateTrayMenu();

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
}

function updateTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    {
      label: 'Show Window',
      click: () => {
        if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
      }
    },
    {
      label: isStreaming ? 'Stop Stream' : 'Start Stream',
      click: () => {
        safeSend('shortcut-toggle-stream');
      }
    },
    {
      label: isRecording ? 'Stop Recording' : 'Start Recording',
      click: () => {
        safeSend('shortcut-toggle-record');
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        forceQuit = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);
}

function updateTrayTooltip() {
  if (!tray) return;
  if (isStreaming) {
    const count = connectedClients.length;
    tray.setToolTip(`TonesinTime - LIVE (${count} listener${count !== 1 ? 's' : ''})`);
  } else {
    tray.setToolTip('TonesinTime - Offline');
  }
}

// ===================== GLOBAL SHORTCUTS =====================

function registerGlobalShortcuts() {
  globalShortcut.register('CmdOrCtrl+Shift+S', () => {
    safeSend('shortcut-toggle-stream');
  });
  globalShortcut.register('CmdOrCtrl+Shift+R', () => {
    safeSend('shortcut-toggle-record');
  });
  globalShortcut.register('CmdOrCtrl+Shift+M', () => {
    safeSend('shortcut-toggle-mute');
  });
}

// ===================== PROGRAM CONTROLS IPC =====================

ipcMain.on('update-crossfade', (event, duration) => {
  // Dynamically update crossfade duration (was const, now let)
  if (typeof duration === 'number' && duration >= 0 && duration <= 12) {
    crossfadeDuration = duration;
    console.log('[AutoDJ] Crossfade duration set to', duration, 'seconds');
  }
});

ipcMain.on('autodj-skip-forward', () => {
  if (autoDjActive && autoDjProcess) {
    console.log('[AutoDJ] Skipping forward');
    try { autoDjProcess.kill('SIGTERM'); } catch (e) {}
    autoDjProcess = null;
    if (crossfadeTimer) { clearTimeout(crossfadeTimer); crossfadeTimer = null; }
    startAutoDjTrack(autoDjCurrentIndex + 1, currentCodec, currentBitrate, currentSampleRate);
  }
});

ipcMain.on('autodj-skip-back', () => {
  if (autoDjActive && autoDjProcess) {
    console.log('[AutoDJ] Skipping back');
    try { autoDjProcess.kill('SIGTERM'); } catch (e) {}
    autoDjProcess = null;
    if (crossfadeTimer) { clearTimeout(crossfadeTimer); crossfadeTimer = null; }
    const prevIdx = autoDjCurrentIndex > 0 ? autoDjCurrentIndex - 1 : 0;
    startAutoDjTrack(prevIdx, currentCodec, currentBitrate, currentSampleRate);
  }
});

// ===================== SETTINGS IPC =====================

ipcMain.on('update-settings', (event, settings) => {
  if (settings.notificationsEnabled !== undefined) notificationsEnabled = settings.notificationsEnabled;
  if (settings.notifyListenerConnect !== undefined) notifyListenerConnect = settings.notifyListenerConnect;
  if (settings.notifyStreamStatus !== undefined) notifyStreamStatus = settings.notifyStreamStatus;
  if (settings.notifyRecordingStatus !== undefined) notifyRecordingStatus = settings.notifyRecordingStatus;
  if (settings.minimizeToTray !== undefined) minimizeToTray = settings.minimizeToTray;
  if (settings.webSharing !== undefined) webSharing = settings.webSharing;
});

// ===================== WEBSITE AUTO-UPDATE =====================

ipcMain.handle('update-website', async (event, { streamUrl }) => {
  try {
    // Try common locations for the website directory
    const homedir = require('os').homedir();
    const possiblePaths = [
      path.join(homedir, 'Desktop', 'development', 'toneintime'),
      path.join(__dirname, '..', '..', 'toneintime'),
      path.join(__dirname, '..', 'toneintime'),
    ];
    const websiteDir = possiblePaths.find(p => fs.existsSync(path.join(p, 'index.html')));
    if (!websiteDir) {
      return { success: false, error: 'Website directory not found' };
    }
    const websitePath = path.join(websiteDir, 'index.html');

    let html = fs.readFileSync(websitePath, 'utf-8');
    // Replace the stream URL in the website
    html = html.replace(
      /const STREAM_URL = urlParams\.get\('stream'\) \|\| '[^']*';/,
      `const STREAM_URL = urlParams.get('stream') || '${streamUrl}';`
    );
    fs.writeFileSync(websitePath, html, 'utf-8');

    // Deploy to Firebase
    const { execSync } = require('child_process');
    execSync('firebase deploy --only hosting', { cwd: websiteDir, timeout: 60000, env: { ...process.env, PATH: process.env.PATH + ':/opt/homebrew/bin:/usr/local/bin' } });

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ===================== RELAY IPC =====================

ipcMain.handle('get-relay-info', async () => {
  await relayEnsureId();
  return { id: relayId, listenUrl: relayId ? `${relayUrl}/listen/${relayId}` : '' };
});

// ===================== APP LIFECYCLE =====================

let forceQuit = false;

app.whenReady().then(() => {
  createWindow();
  createTray();
  registerGlobalShortcuts();
  startScheduleChecker();
  relayEnsureId().then(() => {
    if (relayId) safeSend('relay-info', { id: relayId, live: false, listenUrl: `${relayUrl}/listen/${relayId}` });
  });

  // Load settings from persisted data
  try {
    const dataPath = getDataPath();
    if (fs.existsSync(dataPath)) {
      const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
      if (data.settings) {
        notificationsEnabled = data.settings.notificationsEnabled !== false;
        notifyListenerConnect = data.settings.notifyListenerConnect !== false;
        notifyStreamStatus = data.settings.notifyStreamStatus !== false;
        notifyRecordingStatus = data.settings.notifyRecordingStatus !== false;
        minimizeToTray = data.settings.minimizeToTray !== false;
        webSharing = data.settings.webSharing === true;
      }
    }
  } catch (e) {}

  mainWindow.on('close', (e) => {
    if (forceQuit) return;
    if (minimizeToTray) {
      e.preventDefault();
      if (process.platform === 'darwin') {
        mainWindow.hide();
      } else {
        mainWindow.hide();
      }
    }
  });
});

app.on('before-quit', () => {
  forceQuit = true;
});

app.on('window-all-closed', () => {
  if (!minimizeToTray) {
    if (isRecording) stopRecordingInternal();
    stopHealthMonitor();
    stopEncoder();
    stopAutoDj();
    stopStreamServer();
    stopTunnel();
    if (scheduleInterval) clearInterval(scheduleInterval);
    globalShortcut.unregisterAll();
    app.quit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (isRecording) stopRecordingInternal();
  stopHealthMonitor();
  stopEncoder();
  stopAutoDj();
  stopStreamServer();
  stopTunnel();
  if (scheduleInterval) clearInterval(scheduleInterval);
});

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

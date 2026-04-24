const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('slRadio', {
  // Live mode
  startServerOnly: (config) => ipcRenderer.invoke('start-server-only', config),
  startServer: (config) => ipcRenderer.invoke('start-server', config),
  stopServer: () => ipcRenderer.invoke('stop-server'),
  sendPcmData: (data) => ipcRenderer.send('pcm-data', data),
  streamStopped: () => ipcRenderer.send('stream-stopped'),
  updateMetadata: (metadata) => ipcRenderer.send('update-metadata', metadata),
  getLocalIp: () => ipcRenderer.invoke('get-local-ip'),
  checkFfmpeg: () => ipcRenderer.invoke('check-ffmpeg'),
  onListenerUpdate: (callback) => ipcRenderer.on('listener-update', (_, count) => callback(count)),
  onListenerDetails: (callback) => ipcRenderer.on('listener-details', (_, data) => callback(data)),
  onReconnectStatus: (callback) => ipcRenderer.on('reconnect-status', (_, status) => callback(status)),

  // Recording
  startRecording: () => ipcRenderer.invoke('start-recording'),
  stopRecording: () => ipcRenderer.invoke('stop-recording'),
  onRecordingStatus: (callback) => ipcRenderer.on('recording-status', (_, status) => callback(status)),

  // Stream Health
  onStreamHealth: (callback) => ipcRenderer.on('stream-health', (_, data) => callback(data)),

  // Auto-DJ
  getTrackMetadata: (filePath) => ipcRenderer.invoke('get-track-metadata', filePath),
  selectAudioFiles: () => ipcRenderer.invoke('select-audio-files'),
  startAutoDj: (config) => ipcRenderer.invoke('start-autodj', config),
  stopAutoDj: () => ipcRenderer.invoke('stop-autodj'),
  onNowPlaying: (callback) => ipcRenderer.on('now-playing', (_, info) => callback(info)),
  onAutoDjProgress: (callback) => ipcRenderer.on('autodj-progress', (_, progress) => callback(progress)),
  onAutoDjPcm: (callback) => ipcRenderer.on('autodj-pcm', (_, data) => callback(data)),
  onAutoDjAudioData: (callback) => ipcRenderer.on('autodj-audio-data', (_, size) => callback(size)),

  // Sound Board
  playSound: (filePath) => ipcRenderer.invoke('play-sound', filePath),
  selectSoundFile: () => ipcRenderer.invoke('select-sound-file'),
  onSoundFinished: (callback) => ipcRenderer.on('sound-finished', (_, filePath) => callback(filePath)),

  // Persistence
  saveData: (data) => ipcRenderer.invoke('save-data', data),
  loadData: () => ipcRenderer.invoke('load-data'),

  // Schedule events
  onScheduleTriggered: (callback) => ipcRenderer.on('schedule-triggered', (_, data) => callback(data)),
  onScheduleEnded: (callback) => ipcRenderer.on('schedule-ended', () => callback()),

  // Global shortcuts
  onShortcutToggleStream: (callback) => ipcRenderer.on('shortcut-toggle-stream', () => callback()),
  onShortcutToggleRecord: (callback) => ipcRenderer.on('shortcut-toggle-record', () => callback()),
  onShortcutToggleMute: (callback) => ipcRenderer.on('shortcut-toggle-mute', () => callback()),

  // Settings
  updateSettings: (settings) => ipcRenderer.send('update-settings', settings),

  // Public IP
  getPublicIp: () => ipcRenderer.invoke('get-public-ip'),

  // Cloudflare Tunnel
  onTunnelUrl: (callback) => ipcRenderer.on('tunnel-url', (_, url) => callback(url)),
  getTunnelStatus: () => ipcRenderer.invoke('get-tunnel-status'),

  // Website auto-update
  updateWebsite: (data) => ipcRenderer.invoke('update-website', data),

  // Relay (auto, no accounts)
  getRelayInfo: () => ipcRenderer.invoke('get-relay-info'),
  onRelayInfo: (callback) => ipcRenderer.on('relay-info', (_, info) => callback(info)),

  // Song recognition
  startSongRecog: (data) => ipcRenderer.send('start-song-recog', data),
  stopSongRecog: () => ipcRenderer.send('stop-song-recog'),
  onSongRecognized: (callback) => ipcRenderer.on('song-recognized', (_, data) => callback(data)),
  onSongRecogProgress: (callback) => ipcRenderer.on('song-recog-progress', (_, data) => callback(data)),
  checkFpcalc: () => ipcRenderer.invoke('check-fpcalc'),
  testSongRecog: (wavData) => ipcRenderer.invoke('test-song-recog', wavData),

  // Program controls
  send: (channel, data) => {
    const allowed = ['update-crossfade', 'autodj-skip-forward', 'autodj-skip-back', 'broadcast-dump'];
    if (allowed.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  }
});

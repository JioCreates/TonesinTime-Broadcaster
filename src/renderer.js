let audioContext = null;
let mediaStream = null;
let scriptProcessor = null;
let gainNode = null;
let analyserL = null;
let analyserR = null;
let isLive = false;
let localIp = '';
let uptimeInterval = null;
let streamStartTime = null;

// Peak hold state
let peakLValue = 0;
let peakRValue = 0;

const PEAK_HOLD_MS = 1500;
const PEAK_DECAY_RATE = 0.5;

// Limiter state
let limiterNode = null;
let limiterEnabled = false;
let limiterOutputGain = null;
let limiterGrAnimFrame = null;

// Recording state
let recordingActive = false;

// Tunnel state
let currentTunnelUrl = '';

// Mute state for shortcut
let isMuted = false;
let preMuteGain = 100;

// Relay state (auto, no accounts)
let relayId = '';
let relayListenUrl = '';

// Settings state
let appSettings = {
  theme: 'dark',
  minimizeToTray: true,
  notificationsEnabled: true,
  notifyListenerConnect: true,
  notifyStreamStatus: true,
  notifyRecordingStatus: true,
  relayUrl: 'https://tonesintime.io',
  relayToken: '',
  relayUsername: ''
};

const CODEC_HINTS = {
  mp3: 'Compatible with all players and web browsers',
  aac: 'Better quality than MP3 — web browsers only (not SL)',
  opus: 'Best quality at any bitrate — web browsers only (not SL)'
};

const CODEC_TYPES = {
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
  opus: 'audio/ogg; codecs=opus'
};

// ===================== AUTO-DJ STATE =====================
let currentTab = 'live';
let library = [];
let playlists = [];
let schedules = [];
let selectedPlaylistIndex = -1;
let autoDjRunning = false;
let draggedTrackIndex = -1;

// Auto-DJ audio analysis state
let autoDjAudioContext = null;
let autoDjAnalyserL = null;
let autoDjAnalyserR = null;
let autoDjScriptNode = null;
let autoDjSourceNode = null;
let autoDjPcmBuffer = [];
let autoDjMeterAnimFrame = null;

// ===================== RESPONSIVE ZOOM =====================
const BASE_WIDTH = 1280;
const BASE_HEIGHT = 850;

function updateUIZoom() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  // Scale based on the smaller ratio so it fits both dimensions
  const scaleW = w / BASE_WIDTH;
  const scaleH = h / BASE_HEIGHT;
  const scale = Math.min(scaleW, scaleH);
  // Clamp between 0.7 and 2.0
  const zoom = Math.max(0.7, Math.min(2.0, scale));
  document.documentElement.style.setProperty('--ui-zoom', zoom);
}

window.addEventListener('resize', updateUIZoom);

// Apply theme immediately before async work
try {
  if (localStorage.getItem('theme') === 'light') {
    document.body.classList.add('light-theme');
  }
} catch(e) {}

let publicIp = '';

async function init() {
  updateUIZoom();
  localIp = await window.slRadio.getLocalIp();
  publicIp = await window.slRadio.getPublicIp() || '';

  const hasFfmpeg = await window.slRadio.checkFfmpeg();
  if (!hasFfmpeg) {
    document.getElementById('codecHint').textContent = 'Warning: ffmpeg not found — encoding may fail';
    document.getElementById('codecHint').style.color = '#ff453a';
  }

  await loadAudioDevices();

  window.slRadio.onListenerUpdate((count) => {
    document.getElementById('listenerCount').textContent =
      count + (count === 1 ? ' listener' : ' listeners');
  });

  window.slRadio.onListenerDetails((data) => {
    document.getElementById('lsCurrent').textContent = data.current;
    document.getElementById('lsPeak').textContent = data.peak;
    document.getElementById('lsTotal').textContent = data.totalSessions;

    const badge = document.getElementById('listenerBadge');
    badge.textContent = data.current;
    badge.className = 'listener-badge' + (data.current > 0 ? ' has-listeners' : '');

    const listEl = document.getElementById('listenerList');
    if (data.clients.length === 0) {
      listEl.innerHTML = '<div class="track-list-empty">No listeners connected</div>';
    } else {
      listEl.innerHTML = data.clients.map(c => {
        const mins = Math.floor(c.duration / 60);
        const secs = c.duration % 60;
        const dur = `${mins}:${String(secs).padStart(2, '0')}`;
        return `<div class="listener-item"><span class="listener-ip">${c.ip}</span><span class="listener-duration">${dur}</span></div>`;
      }).join('');
    }
    updateListenerKPI(data);
  });

  window.slRadio.onReconnectStatus((status) => {
    const el = document.getElementById('reconnectStatus');
    if (status.attempting) {
      el.textContent = `Reconnecting encoder... (attempt ${status.attempt})`;
      el.style.display = 'block';
    } else {
      el.style.display = 'none';
    }
  });

  // Recording status handler
  window.slRadio.onRecordingStatus((status) => {
    recordingActive = status.recording;
    const statusEl = document.getElementById('recordingStatus');
    const btn = document.getElementById('recordBtn');
    if (status.recording) {
      statusEl.style.display = 'flex';
      btn.textContent = 'Stop Recording';
      btn.classList.add('recording-active');
      document.getElementById('recDuration').textContent = formatRecordingDuration(status.duration);
      document.getElementById('recFilesize').textContent = formatFileSize(status.fileSize);
    } else {
      statusEl.style.display = 'none';
      btn.innerHTML = '<span class="rec-dot"></span> Record';
      btn.classList.remove('recording-active');
    }
  });

  // Stream health handler
  window.slRadio.onStreamHealth((data) => {
    drawHealthSparkline(data.sparkline);
    updateAnalyticsDashboard(data);
  });

  // Tunnel URL handler
  window.slRadio.onTunnelUrl((url) => {
    updateTunnelUI(url);
  });

  document.getElementById('nowPlaying').addEventListener('input', (e) => {
    window.slRadio.updateMetadata({ song: e.target.value });
  });
  document.getElementById('stationName').addEventListener('input', (e) => {
    window.slRadio.updateMetadata({ title: e.target.value });
  });
  document.getElementById('codec').addEventListener('change', (e) => {
    document.getElementById('codecHint').textContent = CODEC_HINTS[e.target.value];
  });
  document.getElementById('gainSlider').addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    document.getElementById('gainValue').textContent = val + '%';
    if (gainNode) gainNode.gain.value = val / 100;
  });

  // Auto-DJ event handlers
  window.slRadio.onNowPlaying((info) => {
    if (info) {
      document.getElementById('npTitle').textContent = info.title || '--';
      document.getElementById('npArtist').textContent = info.artist || '--';
      document.getElementById('npProgress').style.width = '0%';
      document.getElementById('npCurrentTime').textContent = '0:00';
      const dur = findTrackDuration(info.path);
      document.getElementById('npDuration').textContent = formatDuration(dur);

      // Update deck mode badge
      const badge = document.getElementById('deckModeBadge');
      if (badge) { badge.textContent = 'ON AIR'; badge.classList.add('on-air'); }

      // Update up-next queue
      renderUpNext(info.index, info.total);

      // Add to program log
      addProgramLogEntry('song', info.title, info.artist);

      // Update program play button state
      const playBtn = document.getElementById('programPlayBtn');
      if (playBtn) {
        playBtn.innerHTML = '&#10074;&#10074;';
        playBtn.classList.add('playing');
      }
    } else {
      document.getElementById('npTitle').textContent = 'No Track Loaded';
      document.getElementById('npArtist').textContent = 'Select a playlist and press play';
      const badge = document.getElementById('deckModeBadge');
      if (badge) { badge.textContent = 'STOPPED'; badge.classList.remove('on-air'); }
    }
  });

  window.slRadio.onAutoDjProgress((progress) => {
    if (progress.duration > 0) {
      const pct = Math.min(100, (progress.currentTime / progress.duration) * 100);
      document.getElementById('npProgress').style.width = pct + '%';
      document.getElementById('npCurrentTime').textContent = formatDuration(progress.currentTime);
    }
  });

  // Auto-DJ PCM data for VU meters
  window.slRadio.onAutoDjPcm((data) => {
    if (autoDjRunning) {
      processAutoDjPcm(data);
    }
  });

  // Schedule events
  window.slRadio.onScheduleTriggered(async (data) => {
    // Auto-start the scheduled playlist
    if (!autoDjRunning && !isLive) {
      // Switch to auto-dj tab
      switchTab('autodj');
      // Find playlist index
      const idx = playlists.findIndex(p => p.name === data.playlist.name);
      if (idx >= 0) {
        selectedPlaylistIndex = idx;
        renderPlaylistTabs();
        renderPlaylistTracks();
        await startAutoDj();
      }
    }
  });

  window.slRadio.onScheduleEnded(async () => {
    if (autoDjRunning) {
      await stopAutoDj();
    }
  });

  // Fix shortcut labels for macOS
  if (navigator.platform.indexOf('Mac') !== -1) {
    document.querySelectorAll('.shortcut-mod').forEach(el => {
      el.textContent = el.textContent.replace('Ctrl+', 'Cmd+');
    });
  }

  // Global shortcut handlers
  window.slRadio.onShortcutToggleStream(() => {
    if (autoDjRunning) {
      toggleAutoDj();
      showToast(autoDjRunning ? 'Program stopped' : 'Program started');
    } else {
      toggleStream();
      showToast(isLive ? 'Stream stopped' : 'Stream started');
    }
  });

  window.slRadio.onShortcutToggleRecord(() => {
    if (!isLive) {
      showToast('Start streaming before recording');
      return;
    }
    toggleRecording();
    showToast(recordingActive ? 'Recording stopped' : 'Recording started');
  });

  window.slRadio.onShortcutToggleMute(() => {
    const slider = document.getElementById('gainSlider');
    if (isMuted) {
      // Restore gain
      slider.value = preMuteGain;
      document.getElementById('gainValue').textContent = preMuteGain + '%';
      if (gainNode) gainNode.gain.value = preMuteGain / 100;
      isMuted = false;
      showToast('Unmuted (' + preMuteGain + '%)');
    } else {
      // Save and mute
      preMuteGain = parseInt(slider.value);
      slider.value = 0;
      document.getElementById('gainValue').textContent = '0%';
      if (gainNode) gainNode.gain.value = 0;
      isMuted = true;
      showToast('Muted');
    }
  });

  // Sound board finished handler
  window.slRadio.onSoundFinished((filePath) => {
    playingSounds.delete(filePath);
    renderSoundBoard();
  });

  // Relay info (auto, no accounts)
  window.slRadio.onRelayInfo((info) => {
    relayId = info.id || '';
    relayListenUrl = info.listenUrl || '';
  });

  // Get relay ID on startup
  const relayInfo = await window.slRadio.getRelayInfo();
  relayId = relayInfo.id || '';
  relayListenUrl = relayInfo.listenUrl || '';

  // Song recognition handlers
  window.slRadio.onSongRecognized((data) => {
    onSongRecognized(data);
  });

  window.slRadio.onSongRecogProgress((data) => {
    const display = document.getElementById('songRecogDisplay');
    if (display && songRecogRunning) {
      const status = data.status || `${data.pct}% captured`;
      display.innerHTML = `<div class="song-recog-listening">${escapeHtml(status)}</div>`;
      display.classList.remove('has-match');
    }
  });

  // Load persisted data
  await loadPersistedData();

  // Restore AcoustID key (default to built-in key)
  if (!appSettings.acoustidApiKey) {
    appSettings.acoustidApiKey = 'CbDaEHIP3Y';
  }
  const keyInput = document.getElementById('acoustidApiKey');
  if (keyInput) keyInput.value = appSettings.acoustidApiKey;

  // Start silence detection
  startSilenceDetection();
}

function findTrackDuration(trackPath) {
  const track = library.find(t => t.path === trackPath);
  return track ? track.duration : 0;
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

// ===================== TAB NAVIGATION =====================

function switchTab(tab) {
  currentTab = tab;
  document.getElementById('tabLive').classList.toggle('active', tab === 'live');
  document.getElementById('tabAutoDj').classList.toggle('active', tab === 'autodj');
  document.getElementById('tabEmbed').classList.toggle('active', tab === 'embed');
  document.getElementById('tabAnalytics').classList.toggle('active', tab === 'analytics');
  document.getElementById('tabSettings').classList.toggle('active', tab === 'settings');
  document.getElementById('tabContentLive').classList.toggle('active', tab === 'live');
  document.getElementById('tabContentAutoDj').classList.toggle('active', tab === 'autodj');
  document.getElementById('tabContentEmbed').classList.toggle('active', tab === 'embed');
  document.getElementById('tabContentAnalytics').classList.toggle('active', tab === 'analytics');
  document.getElementById('tabContentSettings').classList.toggle('active', tab === 'settings');
  if (tab === 'embed') updateEmbedPreview();
  updateMainButton();
}

// ===================== LIBRARY MANAGEMENT =====================

function initLibraryDrop() {
  const list = document.getElementById('libraryList');

  // Prevent default browser behavior for drag/drop on the whole window
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  list.addEventListener('dragover', (e) => {
    // Only handle file drops, not internal track drags
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      e.stopPropagation();
      list.classList.add('file-drop-active');
    }
  });

  list.addEventListener('dragleave', (e) => {
    if (!list.contains(e.relatedTarget)) {
      list.classList.remove('file-drop-active');
    }
  });

  list.addEventListener('drop', async (e) => {
    list.classList.remove('file-drop-active');

    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();

    const files = Array.from(e.dataTransfer.files);
    const audioExts = ['.mp3', '.m4a', '.ogg', '.flac', '.wav', '.aac', '.opus'];

    for (const file of files) {
      const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
      if (!audioExts.includes(ext)) continue;
      if (library.find(t => t.path === file.path)) continue;

      try {
        const meta = await window.slRadio.getTrackMetadata(file.path);
        library.push({
          path: file.path,
          title: meta.title || file.name.replace(/\.[^.]+$/, ''),
          artist: meta.artist || 'Unknown',
          duration: meta.duration || 0
        });
      } catch (err) {
        library.push({
          path: file.path,
          title: file.name.replace(/\.[^.]+$/, ''),
          artist: 'Unknown',
          duration: 0
        });
      }
    }

    renderLibrary();
    savePersistedData();
  });
}

async function addTracksToLibrary() {
  const result = await window.slRadio.selectAudioFiles();
  if (result.canceled) return;

  for (const file of result.files) {
    // Avoid duplicates by path
    if (!library.find(t => t.path === file.path)) {
      library.push(file);
    }
  }

  renderLibrary();
  savePersistedData();
}

function removeFromLibrary(index) {
  library.splice(index, 1);
  renderLibrary();
  savePersistedData();
}

function renderLibrary() {
  const list = document.getElementById('libraryList');
  updateLibraryCount();
  if (library.length === 0) {
    list.innerHTML = '<div class="track-list-empty">Drop audio files here or click "Add Tracks"</div>';
    return;
  }

  list.innerHTML = library.map((track, i) => `
    <div class="track-item" draggable="true" ondragstart="onDragStart(event, ${i})" data-index="${i}">
      <div class="track-info">
        <div class="track-title">${escapeHtml(track.title)}</div>
        <div class="track-meta">${escapeHtml(track.artist)} &middot; ${formatDuration(track.duration)}</div>
      </div>
      <button class="track-action-btn" onclick="addTrackToPlaylist(${i})" title="Add to playlist">+</button>
      <button class="track-remove" onclick="removeFromLibrary(${i})" title="Remove">&times;</button>
    </div>
  `).join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function addTrackToPlaylist(libraryIndex) {
  if (selectedPlaylistIndex < 0 || !playlists[selectedPlaylistIndex]) {
    alert('Select a playlist first.');
    return;
  }
  if (library[libraryIndex]) {
    playlists[selectedPlaylistIndex].tracks.push({ ...library[libraryIndex] });
    renderPlaylistTracks();
    updateSchedulePlaylistDropdown();
    updateQuickPlayDropdown();
    updateProgramPlaylistSelect();
    savePersistedData();
    showToast('Added to ' + playlists[selectedPlaylistIndex].name);
  }
}

function addAllToPlaylist() {
  if (selectedPlaylistIndex < 0 || !playlists[selectedPlaylistIndex]) {
    alert('Select a playlist first.');
    return;
  }
  for (const track of library) {
    playlists[selectedPlaylistIndex].tracks.push({ ...track });
  }
  renderPlaylistTracks();
  updateSchedulePlaylistDropdown();
  updateQuickPlayDropdown();
  updateProgramPlaylistSelect();
  savePersistedData();
  showToast(`Added ${library.length} tracks to ${playlists[selectedPlaylistIndex].name}`);
}

// ===================== DRAG & DROP =====================

function onDragStart(event, libraryIndex) {
  draggedTrackIndex = libraryIndex;
  event.dataTransfer.setData('text/plain', libraryIndex.toString());
  event.dataTransfer.effectAllowed = 'copy';
}

function setupPlaylistDrop() {
  const playlistList = document.getElementById('playlistTrackList');
  playlistList.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    playlistList.classList.add('drag-over');
  });
  playlistList.addEventListener('dragleave', () => {
    playlistList.classList.remove('drag-over');
  });
  playlistList.addEventListener('drop', (e) => {
    e.preventDefault();
    playlistList.classList.remove('drag-over');
    const libraryIndex = parseInt(e.dataTransfer.getData('text/plain'));
    if (selectedPlaylistIndex >= 0 && library[libraryIndex]) {
      playlists[selectedPlaylistIndex].tracks.push({ ...library[libraryIndex] });
      renderPlaylistTracks();
      updateSchedulePlaylistDropdown();
      updateQuickPlayDropdown();
      updateProgramPlaylistSelect();
      savePersistedData();
    }
  });
}

// ===================== PLAYLIST MANAGEMENT =====================

function createPlaylist() {
  const nameInput = document.getElementById('newPlaylistName');
  const name = nameInput.value.trim();
  if (!name) return;
  if (playlists.find(p => p.name === name)) {
    alert('A playlist with that name already exists.');
    return;
  }
  playlists.push({ name, tracks: [] });
  nameInput.value = '';
  selectedPlaylistIndex = playlists.length - 1;
  renderPlaylistTabs();
  renderPlaylistTracks();
  updateSchedulePlaylistDropdown();
  updateQuickPlayDropdown();
  updateProgramPlaylistSelect();
  updateDayPartDropdowns();
  savePersistedData();
}

function selectPlaylist(index) {
  selectedPlaylistIndex = index;
  renderPlaylistTabs();
  renderPlaylistTracks();
}

function deletePlaylist(index) {
  playlists.splice(index, 1);
  if (selectedPlaylistIndex >= playlists.length) {
    selectedPlaylistIndex = playlists.length - 1;
  }
  renderPlaylistTabs();
  renderPlaylistTracks();
  updateSchedulePlaylistDropdown();
  updateQuickPlayDropdown();
  updateProgramPlaylistSelect();
  updateDayPartDropdowns();
  savePersistedData();
}

function renderPlaylistTabs() {
  const tabs = document.getElementById('playlistTabs');
  if (playlists.length === 0) {
    tabs.innerHTML = '';
    return;
  }
  tabs.innerHTML = playlists.map((pl, i) => `
    <div class="playlist-tab ${i === selectedPlaylistIndex ? 'active' : ''}" onclick="selectPlaylist(${i})">
      <span>${escapeHtml(pl.name)}</span>
      <span class="playlist-count">${pl.tracks.length}</span>
      <button class="playlist-delete" onclick="event.stopPropagation(); deletePlaylist(${i})" title="Delete playlist">&times;</button>
    </div>
  `).join('');
}

function moveTrackInPlaylist(trackIndex, direction) {
  if (selectedPlaylistIndex < 0) return;
  const tracks = playlists[selectedPlaylistIndex].tracks;
  const newIndex = trackIndex + direction;
  if (newIndex < 0 || newIndex >= tracks.length) return;
  [tracks[trackIndex], tracks[newIndex]] = [tracks[newIndex], tracks[trackIndex]];
  renderPlaylistTracks();
  savePersistedData();
}

function removeTrackFromPlaylist(trackIndex) {
  if (selectedPlaylistIndex < 0) return;
  playlists[selectedPlaylistIndex].tracks.splice(trackIndex, 1);
  renderPlaylistTracks();
  savePersistedData();
}

function renderPlaylistTracks() {
  const list = document.getElementById('playlistTrackList');
  updatePlaylistStats();
  if (selectedPlaylistIndex < 0 || !playlists[selectedPlaylistIndex]) {
    list.innerHTML = '<div class="track-list-empty">Create a playlist, then drag tracks from the library.</div>';
    return;
  }

  const tracks = playlists[selectedPlaylistIndex].tracks;
  if (tracks.length === 0) {
    list.innerHTML = '<div class="track-list-empty">Drag tracks from the library into this playlist.</div>';
    return;
  }

  list.innerHTML = tracks.map((track, i) => `
    <div class="track-item playlist-track">
      <div class="track-order">${i + 1}</div>
      <div class="track-info">
        <div class="track-title">${escapeHtml(track.title)}</div>
        <div class="track-meta">${escapeHtml(track.artist)} &middot; ${formatDuration(track.duration)}</div>
      </div>
      <div class="track-actions">
        <button class="track-action-btn" onclick="moveTrackInPlaylist(${i}, -1)" title="Move up" ${i === 0 ? 'disabled' : ''}>&#9650;</button>
        <button class="track-action-btn" onclick="moveTrackInPlaylist(${i}, 1)" title="Move down" ${i === tracks.length - 1 ? 'disabled' : ''}>&#9660;</button>
        <button class="track-remove" onclick="removeTrackFromPlaylist(${i})" title="Remove">&times;</button>
      </div>
    </div>
  `).join('');
}

// ===================== SCHEDULE MANAGEMENT =====================

function updateSchedulePlaylistDropdown() {
  const select = document.getElementById('schedPlaylist');
  select.innerHTML = playlists.map(pl => `<option value="${escapeHtml(pl.name)}">${escapeHtml(pl.name)}</option>`).join('');
}

function addSchedule() {
  const playlist = document.getElementById('schedPlaylist').value;
  const day = document.getElementById('schedDay').value;
  const startTime = document.getElementById('schedStart').value;
  const endTime = document.getElementById('schedEnd').value;

  if (!playlist) {
    alert('Please select a playlist first.');
    return;
  }
  if (!startTime || !endTime || startTime >= endTime) {
    alert('Please set valid start and end times (start must be before end).');
    return;
  }

  const priority = document.getElementById('schedPriority')?.value || 'normal';

  schedules.push({
    id: Date.now().toString(),
    playlist,
    day,
    startTime,
    endTime,
    priority,
    enabled: true
  });

  renderSchedules();
  savePersistedData();
}

function toggleSchedule(index) {
  schedules[index].enabled = !schedules[index].enabled;
  renderSchedules();
  savePersistedData();
}

function deleteSchedule(index) {
  schedules.splice(index, 1);
  renderSchedules();
  savePersistedData();
}

function renderSchedules() {
  const list = document.getElementById('scheduleList');
  if (schedules.length === 0) {
    list.innerHTML = '';
    return;
  }

  list.innerHTML = schedules.map((sched, i) => {
    const priorityBadge = sched.priority === 'high' ? '<span style="color:var(--red);font-size:8px;font-weight:700;margin-left:4px;">HIGH</span>' :
      sched.priority === 'fallback' ? '<span style="color:var(--text-muted);font-size:8px;font-weight:700;margin-left:4px;">FALLBACK</span>' : '';
    return `
    <div class="schedule-item ${sched.enabled ? '' : 'disabled'}">
      <div class="schedule-info">
        <div class="schedule-playlist">${escapeHtml(sched.playlist)}${priorityBadge}</div>
        <div class="schedule-time">${sched.day} &middot; ${sched.startTime} - ${sched.endTime}</div>
      </div>
      <div class="schedule-actions">
        <label class="schedule-toggle">
          <input type="checkbox" ${sched.enabled ? 'checked' : ''} onchange="toggleSchedule(${i})">
          <span class="toggle-slider"></span>
        </label>
        <button class="track-remove" onclick="deleteSchedule(${i})" title="Delete">&times;</button>
      </div>
    </div>`;
  }).join('');
}

// ===================== AUTO-DJ CONTROLS =====================

async function toggleAutoDj() {
  if (autoDjRunning) {
    await stopAutoDj();
  } else {
    await startAutoDj();
  }
}

async function startAutoDj() {
  if (selectedPlaylistIndex < 0 || !playlists[selectedPlaylistIndex]) {
    alert('Please select a playlist first.');
    return;
  }

  const tracks = playlists[selectedPlaylistIndex].tracks;
  if (tracks.length === 0) {
    alert('The selected playlist is empty. Add tracks first.');
    return;
  }

  const codec = document.getElementById('codec').value;
  const bitrate = parseInt(document.getElementById('bitrate').value);
  const port = parseInt(document.getElementById('port').value);
  const mount = document.getElementById('mount').value;
  const stationName = document.getElementById('stationName')?.value || 'TonesinTime';
  const shuffle = document.getElementById('shuffleToggle').checked;

  const result = await window.slRadio.startAutoDj({
    tracks,
    codec,
    bitrate,
    sampleRate: 44100,
    port,
    mount,
    stationName,
    shuffle,
    playlistName: playlists[selectedPlaylistIndex].name
  });

  if (!result.success) {
    alert('Failed to start program: ' + result.error);
    return;
  }

  autoDjRunning = true;
  isLive = true;

  // Setup audio context for PCM analysis visualization
  setupAutoDjAudioAnalysis();

  // Update UI
  document.getElementById('statusDot').classList.add('live');
  document.getElementById('statusText').textContent = 'PROGRAM';
  updateMainButton();
  document.getElementById('autoDjNowPlaying').style.display = 'block';

  // Show stream URL
  const streamUrl = `http://${localIp}:${port}${mount}`;
  document.getElementById('djLocalUrl').textContent = streamUrl;
  document.getElementById('djUrlSection').style.display = 'block';

  // Show share card based on web sharing setting
  showShareCard();

  setAutoDjConfigDisabled(true);
  startUptime();

  startAutoDjMeters();
}

async function stopAutoDj() {
  autoDjRunning = false;
  isLive = false;
  serverRunning = false;
  stopUptime();

  await window.slRadio.stopAutoDj();

  // Clean up audio analysis
  cleanupAutoDjAudioAnalysis();

  document.getElementById('statusDot').classList.remove('live');
  document.getElementById('statusText').textContent = 'Offline';
  updateMainButton();
  document.getElementById('autoDjNowPlaying').style.display = 'none';
  document.getElementById('djUrlSection').style.display = 'none';
  clearTunnelUI();
  document.getElementById('listenerCount').textContent = '0 listeners';
  document.getElementById('meterL').style.width = '0%';
  document.getElementById('meterR').style.width = '0%';
  document.getElementById('peakL').style.display = 'none';
  document.getElementById('peakR').style.display = 'none';
  peakLValue = 0;
  peakRValue = 0;
  setAutoDjConfigDisabled(false);

  // Reset transport button and deck badge
  const playBtn = document.getElementById('programPlayBtn');
  if (playBtn) {
    playBtn.innerHTML = '&#9654;';
    playBtn.classList.remove('playing');
  }
  const badge = document.getElementById('deckModeBadge');
  if (badge) { badge.textContent = 'STOPPED'; badge.classList.remove('on-air'); }
  document.getElementById('npTitle').textContent = 'No Track Loaded';
  document.getElementById('npArtist').textContent = 'Select a playlist and press play';
  updateGoLiveButton();
  updateMainButton();
}

function setAutoDjConfigDisabled(disabled) {
  ['codec', 'bitrate', 'port', 'mount', 'shuffleToggle'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  });
}

// ===================== AUTO-DJ AUDIO ANALYSIS =====================

// Process incoming PCM data from the main process for visualization
let autoDjPcmSampleBuffer = new Float32Array(2048);
let autoDjPcmWritePos = 0;
let autoDjSpectrumData = new Float32Array(1024);

function processAutoDjPcm(data) {
  // data is an array of bytes representing s16le stereo PCM
  const int16View = new Int16Array(new Uint8Array(data).buffer);

  // Mix stereo to mono and convert to float for simple analysis
  for (let i = 0; i < int16View.length; i += 2) {
    const left = int16View[i] / 32768;
    const right = (i + 1 < int16View.length) ? int16View[i + 1] / 32768 : left;
    autoDjPcmSampleBuffer[autoDjPcmWritePos] = (left + right) / 2;
    autoDjPcmWritePos = (autoDjPcmWritePos + 1) % autoDjPcmSampleBuffer.length;
  }

  // Calculate RMS for L and R channels
  let sumL = 0, sumR = 0, countL = 0, countR = 0;
  for (let i = 0; i < int16View.length; i += 2) {
    const l = int16View[i] / 32768;
    sumL += l * l;
    countL++;
    if (i + 1 < int16View.length) {
      const r = int16View[i + 1] / 32768;
      sumR += r * r;
      countR++;
    }
  }

  if (countL > 0) {
    autoDjRmsL = Math.sqrt(sumL / countL);
    autoDjRmsR = countR > 0 ? Math.sqrt(sumR / countR) : autoDjRmsL;
  }
}

let autoDjRmsL = 0;
let autoDjRmsR = 0;

function setupAutoDjAudioAnalysis() {
  autoDjPcmSampleBuffer = new Float32Array(2048);
  autoDjPcmWritePos = 0;
  autoDjRmsL = 0;
  autoDjRmsR = 0;
}

function cleanupAutoDjAudioAnalysis() {
  if (autoDjMeterAnimFrame) {
    cancelAnimationFrame(autoDjMeterAnimFrame);
    autoDjMeterAnimFrame = null;
  }
  autoDjRmsL = 0;
  autoDjRmsR = 0;
}

function startAutoDjMeters() {
  let peakLHoldTimer = null;
  let peakRHoldTimer = null;
  let peakLDecaying = false;
  let peakRDecaying = false;

  function updateAutoDjMeters() {
    if (!autoDjRunning) return;

    const rmsL = autoDjRmsL;
    const rmsR = autoDjRmsR;

    // Smooth decay
    autoDjRmsL *= 0.92;
    autoDjRmsR *= 0.92;

    const dbL = Math.max(0, Math.min(100, (20 * Math.log10(Math.max(rmsL, 0.00001)) + 60) * 100 / 60));
    const dbR = Math.max(0, Math.min(100, (20 * Math.log10(Math.max(rmsR, 0.00001)) + 60) * 100 / 60));

    const meterL = document.getElementById('meterL');
    const meterR = document.getElementById('meterR');
    meterL.style.width = dbL + '%';
    meterR.style.width = dbR + '%';
    meterL.className = 'meter-fill' + (dbL > 85 ? ' hot' : '');
    meterR.className = 'meter-fill' + (dbR > 85 ? ' hot' : '');

    // Peak hold L
    if (dbL > peakLValue) {
      peakLValue = dbL;
      peakLDecaying = false;
      clearTimeout(peakLHoldTimer);
      peakLHoldTimer = setTimeout(() => { peakLDecaying = true; }, PEAK_HOLD_MS);
    }
    if (peakLDecaying) peakLValue = Math.max(0, peakLValue - PEAK_DECAY_RATE);

    // Peak hold R
    if (dbR > peakRValue) {
      peakRValue = dbR;
      peakRDecaying = false;
      clearTimeout(peakRHoldTimer);
      peakRHoldTimer = setTimeout(() => { peakRDecaying = true; }, PEAK_HOLD_MS);
    }
    if (peakRDecaying) peakRValue = Math.max(0, peakRValue - PEAK_DECAY_RATE);

    const peakLEl = document.getElementById('peakL');
    const peakREl = document.getElementById('peakR');
    peakLEl.style.left = peakLValue + '%';
    peakREl.style.left = peakRValue + '%';
    peakLEl.style.display = peakLValue > 1 ? 'block' : 'none';
    peakREl.style.display = peakRValue > 1 ? 'block' : 'none';
    peakLEl.className = 'peak-hold' + (peakLValue > 85 ? ' peak-hot' : '');
    peakREl.className = 'peak-hold' + (peakRValue > 85 ? ' peak-hot' : '');

    autoDjMeterAnimFrame = requestAnimationFrame(updateAutoDjMeters);
  }

  updateAutoDjMeters();
}


// ===================== PERSISTENCE =====================

async function savePersistedData() {
  await window.slRadio.saveData({
    library,
    playlists,
    schedules,
    cardLayouts,
    soundboardPads,
    stationBreaks,
    dayParts,
    automationRules,
    settings: appSettings
  });
}

async function loadPersistedData() {
  const result = await window.slRadio.loadData();
  if (result.success && result.data) {
    library = result.data.library || [];
    playlists = result.data.playlists || [];
    schedules = result.data.schedules || [];
    cardLayouts = result.data.cardLayouts || {};
    soundboardPads = result.data.soundboardPads || [];
    stationBreaks = result.data.stationBreaks || [];
    if (result.data.dayParts) dayParts = { ...dayParts, ...result.data.dayParts };
    if (result.data.automationRules) automationRules = { ...automationRules, ...result.data.automationRules };
    if (result.data.settings) {
      appSettings = { ...appSettings, ...result.data.settings };
    }
  }

  // Apply loaded settings to UI
  applySettingsToUI();

  // Apply theme
  applyTheme(appSettings.theme);

  // Sync settings to main process
  window.slRadio.updateSettings(appSettings);

  renderLibrary();
  renderPlaylistTabs();
  renderPlaylistTracks();
  updateSchedulePlaylistDropdown();
  updateQuickPlayDropdown();
  updateProgramPlaylistSelect();
  renderSchedules();
  renderSoundBoard();
  renderStationBreaks();
  updateDayPartDropdowns();
  restoreDayParts();
  restoreAutomationRules();
  updateLibraryCount();
  updatePlaylistStats();
  startProgramClock();
  setupPlaylistDrop();
  initLibraryDrop();
  initCardDragDrop();

  // Restore relay session
  // Relay is automatic — no restore needed
}

// ===================== ORIGINAL FUNCTIONS =====================

async function loadAudioDevices() {
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true });
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(d => d.kind === 'audioinput');
    const select = document.getElementById('audioDevice');
    select.innerHTML = '';
    audioInputs.forEach(device => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `Audio Input ${select.options.length + 1}`;
      select.appendChild(option);
    });
  } catch (err) {
    console.error('Failed to enumerate audio devices:', err);
  }
}

async function toggleStream() {
  if (isLive) await stopStream();
  else await startStream();
}

function startUptime() {
  streamStartTime = Date.now();
  const uptimeEl = document.getElementById('uptime');
  uptimeInterval = setInterval(() => {
    const elapsed = Date.now() - streamStartTime;
    const hrs = Math.floor(elapsed / 3600000);
    const mins = Math.floor((elapsed % 3600000) / 60000);
    const secs = Math.floor((elapsed % 60000) / 1000);
    uptimeEl.textContent =
      String(hrs).padStart(2, '0') + ':' +
      String(mins).padStart(2, '0') + ':' +
      String(secs).padStart(2, '0');
  }, 1000);
}

function stopUptime() {
  if (uptimeInterval) { clearInterval(uptimeInterval); uptimeInterval = null; }
  document.getElementById('uptime').textContent = '';
  streamStartTime = null;
}

async function startStream() {
  const port = parseInt(document.getElementById('port').value);
  const mount = document.getElementById('mount').value;
  const bitrate = parseInt(document.getElementById('bitrate').value);
  const codec = document.getElementById('codec').value;
  const stationName = document.getElementById('stationName').value;
  const deviceId = document.getElementById('audioDevice').value;

  // Create AudioContext first to get the real sample rate
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  const realSampleRate = audioContext.sampleRate;

  // Start server + encoder (server will skip if already running)
  try {
    const result = await window.slRadio.startServer({
      port, mount, stationName, codec, bitrate, sampleRate: realSampleRate
    });
    if (result && !result.success) {
      alert('Failed to start server: ' + result.error);
      return;
    }
  } catch(e) {
    alert('Failed to start server: ' + e.message);
    return;
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: 2,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });
  } catch (err) {
    alert('Failed to capture audio: ' + err.message);
    await window.slRadio.stopServer();
    return;
  }

  if (!audioContext) audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(mediaStream);

  // Gain node
  gainNode = audioContext.createGain();
  gainNode.gain.value = parseInt(document.getElementById('gainSlider').value) / 100;
  source.connect(gainNode);

  // Analysers for L/R meters
  const splitter = audioContext.createChannelSplitter(2);
  analyserL = audioContext.createAnalyser();
  analyserR = audioContext.createAnalyser();
  analyserL.fftSize = 256;
  analyserR.fftSize = 256;

  gainNode.connect(splitter);
  splitter.connect(analyserL, 0);
  splitter.connect(analyserR, 1);

  const dataL = new Float32Array(analyserL.fftSize);
  const dataR = new Float32Array(analyserR.fftSize);

  let peakLHoldTimer = null;
  let peakRHoldTimer = null;
  let peakLDecaying = false;
  let peakRDecaying = false;

  function updateMeters() {
    if (!isLive) return;
    analyserL.getFloatTimeDomainData(dataL);
    analyserR.getFloatTimeDomainData(dataR);

    const rmsL = Math.sqrt(dataL.reduce((s, v) => s + v * v, 0) / dataL.length);
    const rmsR = Math.sqrt(dataR.reduce((s, v) => s + v * v, 0) / dataR.length);

    const dbL = Math.max(0, Math.min(100, (20 * Math.log10(rmsL) + 60) * 100 / 60));
    const dbR = Math.max(0, Math.min(100, (20 * Math.log10(rmsR) + 60) * 100 / 60));

    const meterL = document.getElementById('meterL');
    const meterR = document.getElementById('meterR');
    meterL.style.width = dbL + '%';
    meterR.style.width = dbR + '%';
    meterL.className = 'meter-fill' + (dbL > 85 ? ' hot' : '');
    meterR.className = 'meter-fill' + (dbR > 85 ? ' hot' : '');

    // Peak hold L
    if (dbL > peakLValue) {
      peakLValue = dbL;
      peakLDecaying = false;
      clearTimeout(peakLHoldTimer);
      peakLHoldTimer = setTimeout(() => { peakLDecaying = true; }, PEAK_HOLD_MS);
    }
    if (peakLDecaying) peakLValue = Math.max(0, peakLValue - PEAK_DECAY_RATE);

    // Peak hold R
    if (dbR > peakRValue) {
      peakRValue = dbR;
      peakRDecaying = false;
      clearTimeout(peakRHoldTimer);
      peakRHoldTimer = setTimeout(() => { peakRDecaying = true; }, PEAK_HOLD_MS);
    }
    if (peakRDecaying) peakRValue = Math.max(0, peakRValue - PEAK_DECAY_RATE);

    const peakLEl = document.getElementById('peakL');
    const peakREl = document.getElementById('peakR');
    peakLEl.style.left = peakLValue + '%';
    peakREl.style.left = peakRValue + '%';
    peakLEl.style.display = peakLValue > 1 ? 'block' : 'none';
    peakREl.style.display = peakRValue > 1 ? 'block' : 'none';
    peakLEl.className = 'peak-hold' + (peakLValue > 85 ? ' peak-hot' : '');
    peakREl.className = 'peak-hold' + (peakRValue > 85 ? ' peak-hot' : '');

    requestAnimationFrame(updateMeters);
  }

  // Script processor for encoding
  const bufferSize = 8192;
  scriptProcessor = audioContext.createScriptProcessor(bufferSize, 2, 2);

  scriptProcessor.onaudioprocess = (e) => {
    if (!isLive) return;
    const leftF32 = e.inputBuffer.getChannelData(0);
    const rightF32 = e.inputBuffer.getChannelData(1);

    const interleaved = new Int16Array(leftF32.length * 2);
    for (let i = 0; i < leftF32.length; i++) {
      interleaved[i * 2] = Math.max(-32768, Math.min(32767, Math.round(leftF32[i] * 32767)));
      interleaved[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(rightF32[i] * 32767)));
    }

    window.slRadio.sendPcmData(Array.from(new Uint8Array(interleaved.buffer)));
  };

  gainNode.connect(scriptProcessor);
  scriptProcessor.connect(audioContext.destination);

  isLive = true;
  serverRunning = true;
  updateMeters();
  startUptime();

  document.getElementById('statusDot').classList.add('live');
  document.getElementById('statusText').textContent = 'LIVE';
  updateMainButton();
  updateGoLiveButton();

  const streamUrl = `http://${localIp}:${port}${mount}`;
  const publicUrl = `http://${publicIp || 'YOUR_PUBLIC_IP'}:${port}${mount}`;
  const mimeType = CODEC_TYPES[codec];

  document.getElementById('localUrl').textContent = streamUrl;
  document.getElementById('publicUrl').textContent = publicUrl;
  document.getElementById('embedCode').textContent =
    `<audio src="${streamUrl}" type="${mimeType}" controls autoplay>\n</audio>`;
  document.getElementById('urlSection').style.display = 'block';

  // Show share card
  if (appSettings.webSharing) {
    const shareSection = document.getElementById('shareSection');
    if (shareSection) {
      shareSection.style.display = 'block';
      document.getElementById('shareStatus').textContent = 'Connecting tunnel...';
      document.getElementById('shareStatus').style.display = 'block';
      document.getElementById('shareLinksArea').style.display = 'none';
      document.getElementById('tunnelDot').className = 'tunnel-status-dot tunnel-connecting';
    }
  } else {
    // No tunnel — show direct URLs
    const shareSection = document.getElementById('shareSection');
    if (shareSection) {
      shareSection.style.display = 'block';
      document.getElementById('shareStatus').textContent = 'Streaming';
      document.getElementById('shareStatus').style.display = 'block';
      document.getElementById('shareEmbedUrl').textContent = publicUrl;
      document.getElementById('shareDirectUrl').textContent = publicUrl;
      delete document.getElementById('shareEmbedUrl').dataset.original;
      delete document.getElementById('shareDirectUrl').dataset.original;
      document.getElementById('shareLinksArea').style.display = 'block';
      document.getElementById('tunnelDot').className = 'tunnel-status-dot tunnel-active';
    }
  }

  syncEmbedStreamUrl();
  setConfigDisabled(true);
}

async function stopStream() {
  // Stop live audio and server completely
  isLive = false;
  serverRunning = false;
  stopUptime();
  window.slRadio.streamStopped();

  if (scriptProcessor) { scriptProcessor.disconnect(); scriptProcessor = null; }
  if (gainNode) { gainNode.disconnect(); gainNode = null; }
  if (audioContext) { await audioContext.close(); audioContext = null; }
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  analyserL = null;
  analyserR = null;

  await window.slRadio.stopServer();

  document.getElementById('statusDot').classList.remove('live');
  document.getElementById('statusText').textContent = 'Offline';
  updateMainButton();
  updateGoLiveButton();
  document.getElementById('listenerCount').textContent = '0 listeners';
  document.getElementById('meterL').style.width = '0%';
  document.getElementById('meterR').style.width = '0%';
  document.getElementById('peakL').style.display = 'none';
  document.getElementById('peakR').style.display = 'none';
  document.getElementById('urlSection').style.display = 'none';
  document.getElementById('reconnectStatus').style.display = 'none';
  clearTunnelUI();
  peakLValue = 0;
  peakRValue = 0;

  // Reset limiter state
  limiterEnabled = false;
  const limEl = document.getElementById('limiterEnabled');
  if (limEl) limEl.checked = false;
  if (limiterGrAnimFrame) { cancelAnimationFrame(limiterGrAnimFrame); limiterGrAnimFrame = null; }
  limiterNode = null;
  limiterOutputGain = null;
  const grMeter = document.getElementById('limiterGrMeter');
  if (grMeter) grMeter.style.width = '0%';
  const grVal = document.getElementById('limiterGrValue');
  if (grVal) grVal.textContent = '0 dB';

  // Reset FX state
  fxEnabled = false;
  const fxEl = document.getElementById('fxEnabled');
  if (fxEl) fxEl.checked = false;
  lowFilter = null;
  midFilter = null;
  highFilter = null;

  // Reset health display
  const hBitrate = document.getElementById('healthBitrate');
  if (hBitrate) hBitrate.textContent = '0 kbps';
  const hData = document.getElementById('healthDataSent');
  if (hData) hData.textContent = '0 B';
  const hBuf = document.getElementById('healthBuffer');
  if (hBuf) { hBuf.textContent = 'OK'; hBuf.style.color = ''; }
  const hDrop = document.getElementById('healthDropped');
  if (hDrop) hDrop.textContent = '0';
  const hCanvas = document.getElementById('healthSparkline');
  if (hCanvas) hCanvas.getContext('2d').clearRect(0, 0, hCanvas.width, hCanvas.height);

  // Reset recording UI
  recordingActive = false;
  const recStatus = document.getElementById('recordingStatus');
  if (recStatus) recStatus.style.display = 'none';
  const recBtn = document.getElementById('recordBtn');
  if (recBtn) { recBtn.innerHTML = '<span class="rec-dot"></span> Record'; recBtn.classList.remove('recording-active'); }

  setConfigDisabled(false);
}

function setConfigDisabled(disabled) {
  ['audioDevice', 'port', 'mount', 'bitrate', 'codec'].forEach(id => {
    document.getElementById(id).disabled = disabled;
  });
}

let serverRunning = false;

// Main start/stop button — server only
async function handleMainStart() {
  if (serverRunning) {
    // Stop everything
    if (autoDjRunning) await stopAutoDj();
    else if (isLive) {
      // Stop live audio without stopping server again (stopStream calls stopServer)
      isLive = false;
      stopUptime();
      window.slRadio.streamStopped();
      if (scriptProcessor) { scriptProcessor.disconnect(); scriptProcessor = null; }
      if (gainNode) { gainNode.disconnect(); gainNode = null; }
      if (audioContext) { await audioContext.close(); audioContext = null; }
      if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
      analyserL = null;
      analyserR = null;
    }
    await window.slRadio.stopServer();
    serverRunning = false;
    isLive = false;
    autoDjRunning = false;
    stopUptime();
    document.getElementById('statusDot').classList.remove('live');
    document.getElementById('statusText').textContent = 'Offline';
    document.getElementById('meterL').style.width = '0%';
    document.getElementById('meterR').style.width = '0%';
    document.getElementById('peakL').style.display = 'none';
    document.getElementById('peakR').style.display = 'none';
    document.getElementById('urlSection').style.display = 'none';
    document.getElementById('djUrlSection').style.display = 'none';
    document.getElementById('listenerCount').textContent = '0 listeners';
    clearTunnelUI();
    updateMainButton();
    updateGoLiveButton();
    updateQuickPlayButton();
    setConfigDisabled(false);
    showToast('Server stopped');
  } else {
    // Start server only — no audio
    const port = parseInt(document.getElementById('port').value);
    const mount = document.getElementById('mount').value;
    const codec = document.getElementById('codec').value;
    const stationName = document.getElementById('stationName')?.value || 'TonesinTime';

    const result = await window.slRadio.startServerOnly({ port, mount, codec, stationName });
    if (!result.success) {
      alert('Failed to start server: ' + result.error);
      return;
    }

    serverRunning = true;
    startUptime();
    document.getElementById('statusDot').classList.add('live');
    document.getElementById('statusText').textContent = 'READY';

    const streamUrl = `http://${localIp}:${port}${mount}`;
    const pubUrl = `http://${publicIp || 'YOUR_PUBLIC_IP'}:${port}${mount}`;
    document.getElementById('localUrl').textContent = streamUrl;
    document.getElementById('publicUrl').textContent = pubUrl;
    document.getElementById('urlSection').style.display = 'block';

    showShareCard();
    syncEmbedStreamUrl();
    updateMainButton();
    updateQuickPlayButton();
    showToast('Server ready');
  }
}

// Quick Play — play/stop playlist on running server
async function toggleQuickPlay() {
  if (autoDjRunning) {
    await stopAutoDj();
    document.getElementById('statusText').textContent = serverRunning ? 'READY' : 'Offline';
    updateQuickPlayButton();
    return;
  }

  if (!serverRunning) {
    alert('Start the server first.');
    return;
  }

  const select = document.getElementById('quickPlaySelect');
  const idx = parseInt(select.value);
  if (isNaN(idx) || !playlists[idx]) {
    alert('Select a playlist first.');
    return;
  }
  if (playlists[idx].tracks.length === 0) {
    alert('That playlist is empty. Add tracks in the Program tab.');
    return;
  }

  const codec = document.getElementById('codec').value;
  const bitrate = parseInt(document.getElementById('bitrate').value);
  const port = parseInt(document.getElementById('port').value);
  const mount = document.getElementById('mount').value;
  const stationName = document.getElementById('stationName')?.value || 'TonesinTime';
  const shuffle = document.getElementById('quickPlayShuffle').checked;

  const result = await window.slRadio.startAutoDj({
    tracks: playlists[idx].tracks,
    codec, bitrate, sampleRate: 44100, port, mount, stationName, shuffle,
    playlistName: playlists[idx].name
  });

  if (!result.success) {
    alert('Failed to play: ' + result.error);
    return;
  }

  autoDjRunning = true;
  isLive = true;
  setupAutoDjAudioAnalysis();
  startAutoDjMeters();

  document.getElementById('statusText').textContent = 'PLAYING';
  updateQuickPlayButton();
  showToast('Playing: ' + playlists[idx].name);
}

// Go Live — start/stop external audio source on running server
async function toggleGoLive() {
  if (isLive && !autoDjRunning) {
    // Stop live audio but keep server running
    isLive = false;
    stopUptime();
    window.slRadio.streamStopped();

    if (scriptProcessor) { scriptProcessor.disconnect(); scriptProcessor = null; }
    if (gainNode) { gainNode.disconnect(); gainNode = null; }
    if (audioContext) { await audioContext.close(); audioContext = null; }
    if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
    analyserL = null;
    analyserR = null;

    document.getElementById('statusDot').classList.remove('live');
    document.getElementById('statusText').textContent = serverRunning ? 'READY' : 'Offline';
    document.getElementById('meterL').style.width = '0%';
    document.getElementById('meterR').style.width = '0%';
    document.getElementById('peakL').style.display = 'none';
    document.getElementById('peakR').style.display = 'none';
    peakLValue = 0;
    peakRValue = 0;
    setConfigDisabled(false);
    updateGoLiveButton();
    updateMainButton();
    return;
  }

  if (!serverRunning) {
    alert('Start the server first.');
    return;
  }

  // Stop playlist if running
  if (autoDjRunning) {
    await stopAutoDj();
    updateQuickPlayButton();
  }

  // Start live audio capture
  await startStream();
  document.getElementById('statusText').textContent = 'LIVE';
  updateGoLiveButton();
}

function updateGoLiveButton() {
  const btn = document.getElementById('goLiveBtn');
  if (!btn) return;
  if (isLive && !autoDjRunning) {
    btn.textContent = 'Stop Live';
    btn.className = 'btn btn-stop btn-bar';
  } else {
    btn.textContent = 'Go Live';
    btn.className = 'btn btn-start btn-bar';
  }
}

function updateQuickPlayButton() {
  const btn = document.getElementById('quickPlayBtn');
  if (!btn) return;
  if (autoDjRunning) {
    btn.textContent = 'Stop';
    btn.style.background = 'var(--red)';
    btn.style.color = '#fff';
    btn.style.borderColor = 'var(--red)';
  } else {
    btn.textContent = 'Play';
    btn.style.background = '';
    btn.style.color = '';
    btn.style.borderColor = '';
  }
}

function updateMainButton() {
  const btn = document.getElementById('mainStartBtn');
  if (serverRunning) {
    btn.textContent = 'Stop Server';
    btn.className = 'btn btn-stop btn-bar';
  } else {
    btn.textContent = 'Start Server';
    btn.className = 'btn btn-start btn-bar';
  }
}

function copyUrl(el) {
  // Always read the current text, never copy "Copied!"
  const text = el._realText || el.innerText.trim();
  if (!text || text === 'Copied!') return;

  // Save the real text
  el._realText = text;

  // Copy to clipboard
  navigator.clipboard.writeText(text).then(() => {
    el.textContent = 'Copied!';
    clearTimeout(el._copyTimer);
    el._copyTimer = setTimeout(() => {
      el.textContent = el._realText;
    }, 1500);
  }).catch(() => {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    el.textContent = 'Copied!';
    clearTimeout(el._copyTimer);
    el._copyTimer = setTimeout(() => {
      el.textContent = el._realText;
    }, 1500);
  });
}

// ===================== GO LIVE COUNTDOWN =====================
let countdownInterval = null;
let countdownRemaining = 0;

function startCountdown(seconds) {
  // Cancel existing
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }

  const display = document.getElementById('countdownDisplay');
  const numberEl = document.getElementById('countdownNumber');
  const cancelBtn = document.getElementById('countdownCancelBtn');

  if (seconds <= 0) {
    display.style.display = 'none';
    cancelBtn.style.display = 'none';
    countdownRemaining = 0;
    window.slRadio.updateMetadata({ countdown: 0, nextEvent: '' });
    return;
  }

  countdownRemaining = seconds;
  display.style.display = 'block';
  cancelBtn.style.display = '';
  numberEl.textContent = seconds;

  // Send countdown to server for embed/website
  const eventName = document.getElementById('nextEventName').value || '';
  window.slRadio.updateMetadata({ countdown: countdownRemaining, nextEvent: eventName });

  countdownInterval = setInterval(() => {
    countdownRemaining--;
    numberEl.textContent = countdownRemaining;
    window.slRadio.updateMetadata({ countdown: countdownRemaining, nextEvent: eventName });

    if (countdownRemaining <= 0) {
      clearInterval(countdownInterval);
      countdownInterval = null;
      display.style.display = 'none';
      cancelBtn.style.display = 'none';

      // Auto-start streaming
      showToast('Going live!');
      handleMainStart();
    }
  }, 1000);

  showToast(`Going live in ${seconds} seconds`);
}

function updateQuickPlayDropdown() {
  const select = document.getElementById('quickPlaySelect');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">-- Select playlist --</option>';
  playlists.forEach((p, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `${p.name} (${p.tracks.length} tracks)`;
    select.appendChild(opt);
  });
  select.value = current;
}

async function quickPlayPlaylist() {
  const select = document.getElementById('quickPlaySelect');
  const idx = parseInt(select.value);
  if (isNaN(idx) || !playlists[idx]) {
    alert('Select a playlist first.');
    return;
  }
  if (playlists[idx].tracks.length === 0) {
    alert('That playlist is empty. Add tracks in the Program tab.');
    return;
  }

  // Use live tab encoding settings
  const codec = document.getElementById('codec').value;
  const bitrate = parseInt(document.getElementById('bitrate').value);
  const port = parseInt(document.getElementById('port').value);
  const mount = document.getElementById('mount').value;
  const stationName = document.getElementById('stationName')?.value || 'TonesinTime';
  const shuffle = document.getElementById('quickPlayShuffle').checked;

  const result = await window.slRadio.startAutoDj({
    tracks: playlists[idx].tracks,
    codec, bitrate, sampleRate: 44100, port, mount, stationName, shuffle,
    playlistName: playlists[idx].name
  });

  if (!result.success) {
    alert('Failed to start: ' + result.error);
    return;
  }

  autoDjRunning = true;
  isLive = true;
  setupAutoDjAudioAnalysis();
  startAutoDjMeters();

  document.getElementById('statusDot').classList.add('live');
  document.getElementById('statusText').textContent = 'PROGRAM';
  updateMainButton();
  startUptime();
  showToast('Playing: ' + playlists[idx].name);

  const streamUrl = `http://${localIp}:${port}${mount}`;
  document.getElementById('localUrl').textContent = streamUrl;
  document.getElementById('publicUrl').textContent = `http://${publicIp || 'YOUR_PUBLIC_IP'}:${port}${mount}`;
  document.getElementById('urlSection').style.display = 'block';

  // Show share card based on web sharing setting
  showShareCard();

  syncEmbedStreamUrl();
}

function updateNextEvent() {
  const eventName = document.getElementById('nextEventName').value || '';
  window.slRadio.updateMetadata({ nextEvent: eventName });
}

// ===================== CARD DRAG & DROP =====================

let draggedCard = null;
let cardLayouts = {};

function initCardDragDrop() {
  document.querySelectorAll('.draggable-card').forEach(card => {
    // Only start drag from the handle
    const handle = card.querySelector('.drag-handle');
    if (handle) {
      handle.addEventListener('mousedown', () => {
        card.setAttribute('draggable', 'true');
      });
      document.addEventListener('mouseup', () => {
        card.setAttribute('draggable', 'false');
      }, { once: false });
    }

    // Disable draggable by default — only enable from handle
    card.setAttribute('draggable', 'false');

    card.addEventListener('dragstart', (e) => {
      draggedCard = card;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', card.dataset.cardId);
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      draggedCard = null;
      clearDropIndicators();
    });

    card.addEventListener('dragover', (e) => {
      if (!draggedCard || draggedCard === card) return;
      // Only allow drops within same tab
      if (getCardTab(draggedCard) !== getCardTab(card)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clearDropIndicators();

      const rect = card.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY < midY) {
        card.classList.add('drag-over-card');
        card.style.borderTopColor = '#e5a50a';
      } else {
        card.classList.add('drag-over-card');
        card.style.borderBottomColor = '#e5a50a';
      }
    });

    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over-card');
      card.style.borderTopColor = '';
      card.style.borderBottomColor = '';
    });

    card.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!draggedCard || draggedCard === card) return;
      if (getCardTab(draggedCard) !== getCardTab(card)) return;

      const rect = card.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const parent = card.parentNode;

      if (e.clientY < midY) {
        parent.insertBefore(draggedCard, card);
      } else {
        parent.insertBefore(draggedCard, card.nextSibling);
      }

      clearDropIndicators();
      saveCardLayout();
    });
  });

  // Allow dropping on empty zones
  document.querySelectorAll('[data-drop-zone]').forEach(zone => {
    zone.addEventListener('dragover', (e) => {
      if (!draggedCard) return;
      if (getCardTab(draggedCard) !== getZoneTab(zone)) return;
      e.preventDefault();
      zone.classList.add('drop-zone-active');
    });

    zone.addEventListener('dragleave', () => {
      zone.classList.remove('drop-zone-active');
    });

    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!draggedCard) return;
      if (getCardTab(draggedCard) !== getZoneTab(zone)) return;
      zone.appendChild(draggedCard);
      zone.classList.remove('drop-zone-active');
      clearDropIndicators();
      saveCardLayout();
    });
  });

  loadCardLayout();
}

function getCardTab(card) {
  const tabContent = card.closest('.tab-content');
  if (!tabContent) return '';
  return tabContent.id;
}

function getZoneTab(zone) {
  const tabContent = zone.closest('.tab-content');
  if (!tabContent) return '';
  return tabContent.id;
}

function clearDropIndicators() {
  document.querySelectorAll('.drag-over-card').forEach(el => {
    el.classList.remove('drag-over-card');
    el.style.borderTopColor = '';
    el.style.borderBottomColor = '';
  });
  document.querySelectorAll('.drop-zone-active').forEach(el => {
    el.classList.remove('drop-zone-active');
  });
}

function saveCardLayout() {
  const layout = {};
  document.querySelectorAll('[data-drop-zone]').forEach(zone => {
    const zoneId = zone.dataset.dropZone;
    const cardIds = [];
    zone.querySelectorAll('.draggable-card').forEach(card => {
      cardIds.push(card.dataset.cardId);
    });
    layout[zoneId] = cardIds;
  });

  cardLayouts = layout;
  // Save with other persisted data
  savePersistedData();
}

function loadCardLayout() {
  if (!cardLayouts || Object.keys(cardLayouts).length === 0) return;

  Object.entries(cardLayouts).forEach(([zoneId, cardIds]) => {
    const zone = document.querySelector(`[data-drop-zone="${zoneId}"]`);
    if (!zone) return;

    cardIds.forEach(cardId => {
      const card = document.querySelector(`[data-card-id="${cardId}"]`);
      if (card) {
        zone.appendChild(card);
      }
    });
  });
}

// ===================== EMBED DESIGNER =====================

function generateEmbedHtml() {
  const theme = document.getElementById('embedTheme').value;
  const accent = document.getElementById('embedAccent').value;
  const radius = document.getElementById('embedRadius').value;
  const width = document.getElementById('embedWidth').value;
  const title = document.getElementById('embedTitle').value || 'TonesinTime';
  const subtitle = document.getElementById('embedSubtitle').value || '';
  const showVolume = document.getElementById('embedShowVolume').checked;
  const showNowPlaying = document.getElementById('embedShowNowPlaying').checked;
  const showBranding = document.getElementById('embedShowBranding').checked;
  const streamUrl = document.getElementById('embedStreamUrl').value || 'http://localhost:8000/stream';

  // Update labels
  document.getElementById('embedRadiusVal').textContent = radius + 'px';
  document.getElementById('embedWidthVal').textContent = width + 'px';

  const themes = {
    dark: { bg: 'rgba(20,20,30,0.95)', text: '#f0f0f5', sub: 'rgba(240,240,245,0.5)', border: 'rgba(255,255,255,0.1)', sliderBg: 'rgba(255,255,255,0.15)' },
    light: { bg: 'rgba(255,255,255,0.95)', text: '#1a1a1e', sub: 'rgba(0,0,0,0.5)', border: 'rgba(0,0,0,0.1)', sliderBg: 'rgba(0,0,0,0.1)' },
    glass: { bg: 'rgba(30,30,40,0.6)', text: '#f0f0f5', sub: 'rgba(240,240,245,0.4)', border: 'rgba(255,255,255,0.12)', sliderBg: 'rgba(255,255,255,0.12)' },
    minimal: { bg: 'transparent', text: '#f0f0f5', sub: 'rgba(240,240,245,0.4)', border: 'rgba(255,255,255,0.06)', sliderBg: 'rgba(255,255,255,0.1)' }
  };
  const t = themes[theme];
  const backdrop = theme === 'glass' ? 'backdrop-filter:blur(40px);-webkit-backdrop-filter:blur(40px);' : '';

  const statusUrl = streamUrl.replace(/\/stream\/?$/, '/status');

  let html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:transparent}
.p{background:${t.bg};border:1px solid ${t.border};border-radius:${radius}px;padding:16px;max-width:${width}px;${backdrop}box-shadow:0 4px 24px rgba(0,0,0,0.3)}
.hdr{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.hdr-text{flex:1;min-width:0}
.tl{font-size:15px;font-weight:600;color:${t.text}}
.st{font-size:11px;color:${t.sub}}
.badge{font-size:9px;font-weight:700;letter-spacing:0.08em;padding:2px 8px;border-radius:99px;flex-shrink:0}
.badge-live{background:rgba(255,68,68,0.15);color:#ff4444;display:none}
.badge-offline{background:rgba(128,128,128,0.15);color:${t.sub}}
.badge-countdown{background:rgba(247,201,72,0.15);color:#f7c948;display:none}
.live-dot{display:inline-block;width:5px;height:5px;border-radius:50%;background:#ff4444;margin-right:3px;animation:lp 1.5s ease-in-out infinite}
@keyframes lp{0%,100%{opacity:1}50%{opacity:0.3}}
${showNowPlaying ? `.np{font-size:12px;color:${t.sub};margin-bottom:10px;min-height:16px;transition:color 0.2s}` : ''}
.ctrl{display:flex;align-items:center;gap:12px}
.pb{width:40px;height:40px;border-radius:50%;border:none;background:${accent};color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:opacity 0.2s}
.pb:hover{opacity:0.85}
.pb svg{width:18px;height:18px}
${showVolume ? `.vw{flex:1;display:flex;align-items:center;gap:8px}
.vw svg{width:14px;height:14px;color:${t.sub};flex-shrink:0}
input[type=range]{-webkit-appearance:none;width:100%;height:4px;border-radius:2px;background:${t.sliderBg};outline:none}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:${accent};cursor:pointer}` : ''}
${showBranding ? `.br{margin-top:10px;text-align:right;font-size:9px}
.br a{color:${t.sub};text-decoration:none}` : ''}
</style></head><body>
<div class="p">
<div class="hdr">
<div class="hdr-text"><div class="tl">${title}</div>${subtitle ? `<div class="st">${subtitle}</div>` : ''}</div>
<span class="badge badge-live" id="bl"><span class="live-dot"></span>LIVE</span>
<span class="badge badge-countdown" id="bc"></span>
<span class="badge badge-offline" id="bo">OFFLINE</span>
</div>
${showNowPlaying ? '<div class="np" id="np">Checking status...</div>' : ''}
<div class="ctrl">
<button class="pb" id="pb" onclick="t()"><svg id="pi" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,3 20,12 6,21"/></svg><svg id="si" viewBox="0 0 24 24" fill="currentColor" style="display:none"><rect x="5" y="3" width="4" height="18"/><rect x="15" y="3" width="4" height="18"/></svg></button>
${showVolume ? `<div class="vw"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19" fill="currentColor"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg><input type="range" min="0" max="100" value="80" oninput="v(this.value)"></div>` : ''}
</div>
${showBranding ? '<div class="br"><a href="https://tonesintime.io" target="_blank">Powered by TonesinTime</a></div>' : ''}
</div>
<script>
const a=new Audio();a.volume=0.8;let p=false;
const u='${streamUrl}';
const su='${statusUrl}';
function t(){
  if(p){a.pause();a.src='';p=false;document.getElementById('pi').style.display='';document.getElementById('si').style.display='none';${showNowPlaying ? "document.getElementById('np').textContent='Click to listen';" : ''}}
  else{${showNowPlaying ? "document.getElementById('np').textContent='Connecting...';" : ''}a.src=u;a.oncanplay=()=>{p=true;document.getElementById('pi').style.display='none';document.getElementById('si').style.display='';${showNowPlaying ? "document.getElementById('np').textContent='Now Playing';document.getElementById('np').style.color='#33d17a';" : ''}};a.onerror=()=>{p=false;document.getElementById('pi').style.display='';document.getElementById('si').style.display='none';${showNowPlaying ? "document.getElementById('np').textContent='Not currently streaming';document.getElementById('np').style.color='#e84393';" : ''}a.src='';};a.play().catch(()=>{${showNowPlaying ? "document.getElementById('np').textContent='Not currently streaming';document.getElementById('np').style.color='#e84393';" : ''}});}}
${showVolume ? 'function v(x){a.volume=x/100}' : ''}
function ck(){fetch(su).then(r=>r.json()).then(d=>{
  const bl=document.getElementById('bl'),bo=document.getElementById('bo'),bc=document.getElementById('bc');
  ${showNowPlaying ? "const np=document.getElementById('np');" : ''}
  if(d.live){bl.style.display='';bo.style.display='none';bc.style.display='none';${showNowPlaying ? "if(!p){np.textContent=d.song||'Click to listen';np.style.color='';}" : ''}}
  else if(d.countdown>0){bl.style.display='none';bo.style.display='none';bc.style.display='';bc.textContent='LIVE IN '+d.countdown+'s';${showNowPlaying ? "np.textContent=d.nextEvent||'Starting soon...';np.style.color='#f7c948';" : ''}}
  else if(d.nextEvent){bl.style.display='none';bo.style.display='';bc.style.display='';bc.textContent='Next: '+d.nextEvent;${showNowPlaying ? "if(!p){np.textContent='Not currently streaming';np.style.color='';}" : ''}}
  else{bl.style.display='none';bo.style.display='';bc.style.display='none';${showNowPlaying ? "if(!p){np.textContent='Not currently streaming';np.style.color='';}" : ''}}
}).catch(()=>{document.getElementById('bl').style.display='none';document.getElementById('bo').style.display='';document.getElementById('bc').style.display='none';${showNowPlaying ? "if(!p)document.getElementById('np').textContent='Not currently streaming';" : ''}})}
ck();setInterval(ck,5000);
</script></body></html>`;

  return html;
}

function updateEmbedPreview() {
  const html = generateEmbedHtml();
  const frame = document.getElementById('embedPreviewFrame');
  frame.srcdoc = html;

  // Update embed code output
  const streamUrl = document.getElementById('embedStreamUrl').value || 'http://localhost:8000/stream';
  const width = document.getElementById('embedWidth').value;

  // For the copy code, we generate a self-contained HTML that can be pasted as an iframe or inline
  const encodedHtml = html.replace(/"/g, '&quot;');
  const embedCode = `<iframe srcdoc="${encodedHtml}" style="border:none;width:${width}px;height:180px;" sandbox="allow-scripts"></iframe>`;

  document.getElementById('embedDesignerCode').textContent = embedCode;
}

// Auto-fill stream URL when broadcasting starts
function syncEmbedStreamUrl() {
  const embedUrlInput = document.getElementById('embedStreamUrl');
  if (!embedUrlInput.value || embedUrlInput.value.includes('localhost') || embedUrlInput.value.includes('YOUR_PUBLIC_IP')) {
    const port = document.getElementById('port').value || '9000';
    const mount = document.getElementById('mount').value || '/stream';
    const ip = publicIp || localIp;
    embedUrlInput.value = `http://${ip}:${port}${mount}`;
    updateEmbedPreview();
  }
}

// ===================== RECORDING =====================

async function toggleRecording() {
  if (recordingActive) {
    const result = await window.slRadio.stopRecording();
    if (!result.success) {
      console.error('Failed to stop recording:', result.error);
    }
  } else {
    if (!isLive) {
      alert('Start streaming before recording.');
      return;
    }
    const result = await window.slRadio.startRecording();
    if (!result.success) {
      alert('Failed to start recording: ' + result.error);
    }
  }
}

function formatRecordingDuration(totalSeconds) {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

// ===================== STREAM HEALTH SPARKLINE =====================

function drawHealthSparkline(data) {
  const canvas = document.getElementById('healthSparkline');
  if (!canvas) return;
  // Resize canvas to match container
  canvas.width = canvas.offsetWidth * 2;
  canvas.height = canvas.offsetHeight * 2;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);

  if (!data || data.length === 0) return;

  const max = Math.max(...data, 1);
  const barWidth = w / data.length;

  for (let i = 0; i < data.length; i++) {
    const barHeight = (data[i] / max) * (h - 2);
    const x = i * barWidth;
    const y = h - barHeight;

    // Color based on value relative to max
    const ratio = data[i] / max;
    if (ratio > 0.8) {
      ctx.fillStyle = '#33d17a';
    } else if (ratio > 0.4) {
      ctx.fillStyle = '#e5a50a';
    } else if (data[i] > 0) {
      ctx.fillStyle = '#e01b24';
    } else {
      ctx.fillStyle = '#3d3846';
    }

    ctx.fillRect(x, y, Math.max(barWidth - 1, 1), barHeight);
  }
}

// ===================== ANALYTICS GAUGES =====================

function drawGauge(canvasId, value, max, color) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h - 10;
  const radius = Math.min(cx, cy) - 10;
  const startAngle = Math.PI;
  const endAngle = 2 * Math.PI;
  const pct = Math.min(value / max, 1);
  const valueAngle = startAngle + (endAngle - startAngle) * pct;

  // Background arc
  ctx.beginPath();
  ctx.arc(cx, cy, radius, startAngle, endAngle);
  ctx.lineWidth = 12;
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--border-primary').trim() || '#3d3846';
  ctx.lineCap = 'round';
  ctx.stroke();

  // Value arc
  if (pct > 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius, startAngle, valueAngle);
    ctx.lineWidth = 12;
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.stroke();
  }
}

function updateAnalyticsDashboard(healthData) {
  if (!healthData) return;

  // KPIs
  const bitrateEl = document.getElementById('kpiBitrate');
  if (bitrateEl) bitrateEl.textContent = healthData.bitrateKbps || 0;

  const dataSentEl = document.getElementById('kpiDataSent');
  if (dataSentEl) {
    const bytes = healthData.totalBytesSent || 0;
    if (bytes > 1073741824) dataSentEl.textContent = (bytes / 1073741824).toFixed(1) + ' GB';
    else if (bytes > 1048576) dataSentEl.textContent = (bytes / 1048576).toFixed(1) + ' MB';
    else if (bytes > 1024) dataSentEl.textContent = (bytes / 1024).toFixed(0) + ' KB';
    else dataSentEl.textContent = bytes + ' B';
  }

  const droppedEl = document.getElementById('kpiDropped');
  if (droppedEl) droppedEl.textContent = (healthData.droppedConnections || 0) + ' dropped';

  const codecEl = document.getElementById('kpiCodec');
  if (codecEl) {
    const codec = document.getElementById('codec')?.value?.toUpperCase() || 'MP3';
    const bitrate = document.getElementById('bitrate')?.value || '256';
    codecEl.textContent = codec + ' ' + bitrate + 'k';
  }

  const statusEl = document.getElementById('kpiServerStatus');
  if (statusEl) statusEl.textContent = serverRunning ? 'Online' : 'Offline';

  const uptimeEl = document.getElementById('kpiUptime');
  if (uptimeEl) uptimeEl.textContent = document.getElementById('uptime')?.textContent || '--';

  // Gauges
  const targetBitrate = parseInt(document.getElementById('bitrate')?.value || '256');
  drawGauge('gaugeBitrate', healthData.bitrateKbps || 0, targetBitrate * 1.2, '#33d17a');
  document.getElementById('gaugeBitrateVal').textContent = (healthData.bitrateKbps || 0) + ' kbps';

  const bufferOk = healthData.bufferOk ? 100 : 0;
  drawGauge('gaugeBuffer', bufferOk, 100, bufferOk ? '#33d17a' : '#e01b24');
  document.getElementById('gaugeBufferVal').textContent = bufferOk ? 'Healthy' : 'Error';

  // Quality = bitrate accuracy + no drops
  const bitrateAccuracy = Math.min((healthData.bitrateKbps || 0) / targetBitrate, 1) * 100;
  const dropPenalty = Math.min((healthData.droppedConnections || 0) * 5, 50);
  const quality = Math.max(0, Math.round(bitrateAccuracy - dropPenalty));
  const qualityColor = quality > 80 ? '#33d17a' : quality > 50 ? '#f6d32d' : '#e01b24';
  drawGauge('gaugeQuality', quality, 100, qualityColor);
  document.getElementById('gaugeQualityVal').textContent = quality + '%';
}

function updateListenerKPI(data) {
  const el = document.getElementById('kpiListeners');
  if (el) el.textContent = data.current || 0;
  const peakEl = document.getElementById('kpiListenersPeak');
  if (peakEl) peakEl.textContent = 'Peak: ' + (data.peak || 0);
}

// ===================== AUDIO LIMITER =====================

function toggleLimiter() {
  limiterEnabled = document.getElementById('limiterEnabled').checked;
  if (limiterEnabled) {
    insertLimiter();
  } else {
    removeLimiter();
  }
}

function insertLimiter() {
  if (!audioContext || !gainNode) return;

  // Create compressor node configured as a brick-wall limiter
  limiterNode = audioContext.createDynamicsCompressor();
  limiterNode.threshold.value = parseFloat(document.getElementById('limiterThreshold').value);
  limiterNode.ratio.value = 20; // brick wall
  limiterNode.knee.value = 0;
  limiterNode.attack.value = 0.003;
  limiterNode.release.value = 0.05;

  // Output gain (ceiling)
  limiterOutputGain = audioContext.createGain();
  const ceilingDb = parseFloat(document.getElementById('limiterCeiling').value);
  limiterOutputGain.gain.value = Math.pow(10, ceilingDb / 20);

  // Rewire: gainNode -> limiter -> outputGain -> (splitter + scriptProcessor)
  // First disconnect gainNode from its current destinations
  gainNode.disconnect();

  gainNode.connect(limiterNode);
  limiterNode.connect(limiterOutputGain);

  // Reconnect to splitter and scriptProcessor
  const splitter = audioContext.createChannelSplitter(2);
  analyserL = audioContext.createAnalyser();
  analyserR = audioContext.createAnalyser();
  analyserL.fftSize = 256;
  analyserR.fftSize = 256;

  limiterOutputGain.connect(splitter);
  splitter.connect(analyserL, 0);
  splitter.connect(analyserR, 1);

  if (scriptProcessor) {
    limiterOutputGain.connect(scriptProcessor);
  }

  // Start gain reduction meter
  startGrMeter();
}

function removeLimiter() {
  if (!audioContext || !gainNode) return;
  if (limiterGrAnimFrame) {
    cancelAnimationFrame(limiterGrAnimFrame);
    limiterGrAnimFrame = null;
  }

  // Disconnect limiter chain
  gainNode.disconnect();
  if (limiterNode) {
    limiterNode.disconnect();
    limiterNode = null;
  }
  if (limiterOutputGain) {
    limiterOutputGain.disconnect();
    limiterOutputGain = null;
  }

  // Reconnect directly: gainNode -> splitter + scriptProcessor
  const splitter = audioContext.createChannelSplitter(2);
  analyserL = audioContext.createAnalyser();
  analyserR = audioContext.createAnalyser();
  analyserL.fftSize = 256;
  analyserR.fftSize = 256;

  gainNode.connect(splitter);
  splitter.connect(analyserL, 0);
  splitter.connect(analyserR, 1);

  if (scriptProcessor) {
    gainNode.connect(scriptProcessor);
  }

  // Reset GR meter
  document.getElementById('limiterGrMeter').style.width = '0%';
  document.getElementById('limiterGrValue').textContent = '0 dB';
}

function updateLimiter() {
  const threshold = parseFloat(document.getElementById('limiterThreshold').value);
  const ceiling = parseFloat(document.getElementById('limiterCeiling').value);

  document.getElementById('limiterThresholdVal').textContent = threshold + ' dB';
  document.getElementById('limiterCeilingVal').textContent = ceiling + ' dB';

  if (limiterNode) {
    limiterNode.threshold.value = threshold;
  }
  if (limiterOutputGain) {
    limiterOutputGain.gain.value = Math.pow(10, ceiling / 20);
  }
}

function startGrMeter() {
  function updateGr() {
    if (!limiterEnabled || !limiterNode) return;
    const reduction = limiterNode.reduction; // negative dB value
    const grDb = Math.abs(reduction);
    const grPct = Math.min(100, (grDb / 30) * 100); // 30dB range

    document.getElementById('limiterGrMeter').style.width = grPct + '%';
    document.getElementById('limiterGrValue').textContent = '-' + grDb.toFixed(1) + ' dB';

    limiterGrAnimFrame = requestAnimationFrame(updateGr);
  }
  updateGr();
}

async function updateWebsite() {
  const btn = document.getElementById('updateWebsiteBtn');
  const directEl = document.getElementById('shareDirectUrl');
  const embedEl = document.getElementById('shareEmbedUrl');
  const streamUrl = (currentTunnelUrl ? currentTunnelUrl + (document.getElementById('mount')?.value || '/stream') : '')
    || directEl?.textContent?.trim()
    || '';

  if (!streamUrl || streamUrl === 'Copied!') {
    showToast('No stream URL available');
    return;
  }

  btn.textContent = 'Deploying...';
  btn.disabled = true;

  const result = await window.slRadio.updateWebsite({ streamUrl });

  if (result.success) {
    showToast('tonesintime.io updated!');
    btn.textContent = 'Updated!';
  } else {
    showToast('Failed: ' + result.error);
    btn.textContent = 'Failed';
  }

  setTimeout(() => {
    btn.textContent = 'Update tonesintime.io';
    btn.disabled = false;
  }, 3000);
}

function showShareCard() {
  const shareSection = document.getElementById('shareSection');
  if (!shareSection) return;

  const permanentUrl = 'https://stream.tonesintime.io/stream';
  const port = document.getElementById('port')?.value || '9000';
  const mount = document.getElementById('mount')?.value || '/stream';
  const directUrl = `http://${publicIp || localIp}:${port}${mount}`;

  shareSection.style.display = 'block';
  document.getElementById('shareStatus').textContent = 'Streaming';
  document.getElementById('shareStatus').style.display = 'block';
  document.getElementById('shareEmbedUrl').textContent = permanentUrl;
  document.getElementById('shareEmbedUrl')._realText = permanentUrl;
  document.getElementById('shareDirectUrl').textContent = directUrl;
  document.getElementById('shareDirectUrl')._realText = directUrl;
  document.getElementById('shareLinksArea').style.display = 'block';
  document.getElementById('tunnelDot').className = 'tunnel-status-dot tunnel-active';
}

// ===================== CLOUDFLARE TUNNEL UI =====================

function updateTunnelUI(url) {
  const shareSection = document.getElementById('shareSection');
  const shareStatus = document.getElementById('shareStatus');
  const linksArea = document.getElementById('shareLinksArea');
  const embedUrlEl = document.getElementById('shareEmbedUrl');
  const directUrlEl = document.getElementById('shareDirectUrl');
  const tunnelDot = document.getElementById('tunnelDot');

  if (!shareSection) return;

  if (url === 'downloading') {
    shareSection.style.display = 'block';
    shareStatus.textContent = 'Downloading tunnel (one-time)...';
    shareStatus.style.display = 'block';
    linksArea.style.display = 'none';
    tunnelDot.className = 'tunnel-status-dot tunnel-connecting';
    showToast('Setting up secure sharing...');
  } else if (url === 'connecting') {
    shareSection.style.display = 'block';
    shareStatus.textContent = 'Connecting tunnel...';
    shareStatus.style.display = 'block';
    linksArea.style.display = 'none';
    tunnelDot.className = 'tunnel-status-dot tunnel-connecting';
  } else if (url && url.startsWith('error:')) {
    shareSection.style.display = 'block';
    shareStatus.textContent = 'Tunnel failed — local only';
    shareStatus.style.display = 'block';
    const port = document.getElementById('port').value || '9000';
    const mount = document.getElementById('mount').value || '/stream';
    embedUrlEl.textContent = `http://${localIp}:${port}${mount}`;
    directUrlEl.textContent = `http://${localIp}:${port}${mount}`;
    linksArea.style.display = 'block';
    tunnelDot.className = 'tunnel-status-dot tunnel-error';
    currentTunnelUrl = '';
  } else if (url && url.startsWith('https://')) {
    currentTunnelUrl = url;
    const mount = document.getElementById('mount')?.value || '/stream';
    const directStream = url + mount;
    const embedLink = `https://tonesintime.io?stream=${encodeURIComponent(directStream)}`;

    shareSection.style.display = 'block';
    shareStatus.textContent = 'You\'re live!';
    shareStatus.style.display = 'block';
    embedUrlEl.textContent = embedLink;
    embedUrlEl._realText = embedLink;
    directUrlEl.textContent = directStream;
    directUrlEl._realText = directStream;
    linksArea.style.display = 'block';
    tunnelDot.className = 'tunnel-status-dot tunnel-active';
    showToast('You\'re live! Share links ready.');

    const embedUrlInput = document.getElementById('embedStreamUrl');
    if (embedUrlInput) {
      embedUrlInput.value = directStream;
      updateEmbedPreview();
    }
  } else {
    currentTunnelUrl = '';
    shareSection.style.display = 'none';
    tunnelDot.className = 'tunnel-status-dot';
  }
}

function clearTunnelUI() {
  currentTunnelUrl = '';
  const shareSection = document.getElementById('shareSection');
  if (shareSection) shareSection.style.display = 'none';
  const tunnelDot = document.getElementById('tunnelDot');
  if (tunnelDot) tunnelDot.className = 'tunnel-status-dot';
}

// ===================== TOAST NOTIFICATIONS =====================

function showToast(message) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-out');
    toast.addEventListener('animationend', () => toast.remove());
  }, 2000);
}

// ===================== THEME =====================

function applyTheme(theme) {
  if (theme === 'light') {
    document.body.classList.add('light-theme');
  } else {
    document.body.classList.remove('light-theme');
  }
  // Remove preload style that prevents dark mode from working
  const preloadStyle = document.getElementById('preload-theme');
  if (preloadStyle) preloadStyle.remove();
  // Cache in localStorage for instant load next time
  localStorage.setItem('theme', theme);
  const label = document.getElementById('themeLabel');
  if (label) label.textContent = theme === 'light' ? 'Light' : 'Dark';
  const toggle = document.getElementById('themeToggle');
  if (toggle) toggle.checked = theme === 'light';
}

function toggleTheme() {
  const isLight = document.getElementById('themeToggle').checked;
  appSettings.theme = isLight ? 'light' : 'dark';
  applyTheme(appSettings.theme);
  savePersistedData();
  window.slRadio.updateSettings(appSettings);
}

// ===================== SETTINGS UI =====================

function applySettingsToUI() {
  const el = (id) => document.getElementById(id);

  // General
  el('themeToggle').checked = appSettings.theme === 'light';
  el('themeLabel').textContent = appSettings.theme === 'light' ? 'Light' : 'Dark';
  el('minimizeToTrayToggle').checked = appSettings.minimizeToTray !== false;
  el('webSharingToggle').checked = appSettings.webSharing === true;

  // Notifications
  el('notificationsToggle').checked = appSettings.notificationsEnabled !== false;
  el('notifyListenerToggle').checked = appSettings.notifyListenerConnect !== false;
  el('notifyStreamToggle').checked = appSettings.notifyStreamStatus !== false;
  el('notifyRecordingToggle').checked = appSettings.notifyRecordingStatus !== false;
  if (el('notifyDeadAirToggle')) el('notifyDeadAirToggle').checked = appSettings.notifyDeadAir !== false;

  // Stream output
  if (appSettings.codec && el('codec')) el('codec').value = appSettings.codec;
  if (appSettings.bitrate && el('bitrate')) el('bitrate').value = appSettings.bitrate;
  if (appSettings.port && el('port')) el('port').value = appSettings.port;
  if (appSettings.mount && el('mount')) el('mount').value = appSettings.mount;
  if (appSettings.sampleRate && el('sampleRate')) el('sampleRate').value = appSettings.sampleRate;

  // Station info
  if (appSettings.stationName && el('stationName')) el('stationName').value = appSettings.stationName;
  if (appSettings.stationGenre && el('stationGenre')) el('stationGenre').value = appSettings.stationGenre;
  if (appSettings.stationDesc && el('stationDesc')) el('stationDesc').value = appSettings.stationDesc;
  if (appSettings.stationUrl && el('stationUrl')) el('stationUrl').value = appSettings.stationUrl;

  // Metadata
  if (appSettings.metadataFormat && el('metadataFormat')) el('metadataFormat').value = appSettings.metadataFormat;
  if (appSettings.metadataDelay != null && el('metadataDelay')) el('metadataDelay').value = appSettings.metadataDelay;
  if (el('discordWebhookEnabled')) el('discordWebhookEnabled').checked = appSettings.discordWebhookEnabled === true;
  if (appSettings.discordWebhookUrl && el('discordWebhookUrl')) el('discordWebhookUrl').value = appSettings.discordWebhookUrl;
  updateDiscordWebhookVisibility();

  // Recording
  if (appSettings.recordingFormat && el('recordingFormat')) el('recordingFormat').value = appSettings.recordingFormat;
  if (appSettings.recordingQuality && el('recordingQuality')) el('recordingQuality').value = appSettings.recordingQuality;
  if (appSettings.recordingFilename && el('recordingFilename')) el('recordingFilename').value = appSettings.recordingFilename;
  if (el('recordingSplitHour')) el('recordingSplitHour').checked = appSettings.recordingSplitHour === true;
  if (el('autoRecordOnAir')) el('autoRecordOnAir').checked = appSettings.autoRecordOnAir === true;

  // Network
  if (appSettings.bufferSize && el('bufferSize')) el('bufferSize').value = appSettings.bufferSize;
  if (appSettings.reconnectAttempts != null && el('reconnectAttempts')) el('reconnectAttempts').value = appSettings.reconnectAttempts;
  if (appSettings.reconnectDelay != null && el('reconnectDelay')) el('reconnectDelay').value = appSettings.reconnectDelay;

  // Failover
  if (el('autoRestartToggle')) el('autoRestartToggle').checked = appSettings.autoRestart !== false;
  if (el('fallbackEnabled')) el('fallbackEnabled').checked = appSettings.fallbackEnabled === true;
  if (appSettings.fallbackFile && el('fallbackFile')) el('fallbackFile').value = appSettings.fallbackFile.split('/').pop();

  // About
  populateAboutInfo();
}

function updateSettingsFromUI() {
  const el = (id) => document.getElementById(id);

  // General
  appSettings.minimizeToTray = el('minimizeToTrayToggle').checked;
  appSettings.webSharing = el('webSharingToggle').checked;

  // Notifications
  appSettings.notificationsEnabled = el('notificationsToggle').checked;
  appSettings.notifyListenerConnect = el('notifyListenerToggle').checked;
  appSettings.notifyStreamStatus = el('notifyStreamToggle').checked;
  appSettings.notifyRecordingStatus = el('notifyRecordingToggle').checked;
  appSettings.notifyDeadAir = el('notifyDeadAirToggle')?.checked ?? true;

  // Stream output
  appSettings.codec = el('codec')?.value || 'mp3';
  appSettings.bitrate = el('bitrate')?.value || '256';
  appSettings.port = el('port')?.value || '9000';
  appSettings.mount = el('mount')?.value || '/stream';
  appSettings.sampleRate = el('sampleRate')?.value || '44100';

  // Station info
  appSettings.stationName = el('stationName')?.value || 'TonesinTime';
  appSettings.stationGenre = el('stationGenre')?.value || '';
  appSettings.stationDesc = el('stationDesc')?.value || '';
  appSettings.stationUrl = el('stationUrl')?.value || '';

  // Metadata
  appSettings.metadataFormat = el('metadataFormat')?.value || '%artist% - %title%';
  appSettings.metadataDelay = parseInt(el('metadataDelay')?.value || 0);
  appSettings.discordWebhookEnabled = el('discordWebhookEnabled')?.checked || false;
  appSettings.discordWebhookUrl = el('discordWebhookUrl')?.value || '';
  updateDiscordWebhookVisibility();

  // Recording
  appSettings.recordingFormat = el('recordingFormat')?.value || 'mp3';
  appSettings.recordingQuality = el('recordingQuality')?.value || '256';
  appSettings.recordingFilename = el('recordingFilename')?.value || 'broadcast_%date%_%time%';
  appSettings.recordingSplitHour = el('recordingSplitHour')?.checked || false;
  appSettings.autoRecordOnAir = el('autoRecordOnAir')?.checked || false;

  // Network
  appSettings.bufferSize = el('bufferSize')?.value || '2048';
  appSettings.reconnectAttempts = parseInt(el('reconnectAttempts')?.value || 5);
  appSettings.reconnectDelay = parseInt(el('reconnectDelay')?.value || 3);

  // Failover
  appSettings.autoRestart = el('autoRestartToggle')?.checked ?? true;
  appSettings.fallbackEnabled = el('fallbackEnabled')?.checked || false;

  savePersistedData();
  window.slRadio.updateSettings(appSettings);
}

// ===================== PROCESSING PRESETS =====================

const PROCESSING_PRESETS = {
  none: { desc: 'No processing preset applied', comp: false, limiter: false, eq: [0,0,0] },
  'radio-loud': {
    desc: 'Aggressive compression + limiting for maximum loudness',
    comp: true, compThreshold: -20, compRatio: 8, compAttack: 3, compRelease: 100, compMakeup: 6,
    limiter: true, limThreshold: -3, limCeiling: 0,
    eq: [2, -1, 1.5]
  },
  'radio-clean': {
    desc: 'Moderate compression for clean, consistent levels',
    comp: true, compThreshold: -24, compRatio: 4, compAttack: 10, compRelease: 250, compMakeup: 3,
    limiter: true, limThreshold: -6, limCeiling: 0,
    eq: [0, 0, 0]
  },
  podcast: {
    desc: 'Optimized for voice — warm, clear, present',
    comp: true, compThreshold: -18, compRatio: 3, compAttack: 5, compRelease: 200, compMakeup: 4,
    limiter: true, limThreshold: -4, limCeiling: 0,
    eq: [-2, 2, 1]
  },
  music: {
    desc: 'Gentle compression to preserve dynamics',
    comp: true, compThreshold: -28, compRatio: 2, compAttack: 20, compRelease: 300, compMakeup: 1,
    limiter: true, limThreshold: -6, limCeiling: 0,
    eq: [0, 0, 0]
  },
  'dj-set': {
    desc: 'Heavy compression + bass boost for DJ performance',
    comp: true, compThreshold: -16, compRatio: 10, compAttack: 1, compRelease: 80, compMakeup: 8,
    limiter: true, limThreshold: -2, limCeiling: 0,
    eq: [4, -1, 2]
  }
};

function applyProcessingPreset(name) {
  const preset = PROCESSING_PRESETS[name];
  if (!preset) return;

  document.getElementById('presetDesc').textContent = preset.desc;

  // Apply compressor
  if (preset.comp) {
    document.getElementById('compressorEnabled').checked = true;
    document.getElementById('compThreshold').value = preset.compThreshold;
    document.getElementById('compRatio').value = preset.compRatio;
    document.getElementById('compAttack').value = preset.compAttack;
    document.getElementById('compRelease').value = preset.compRelease;
    document.getElementById('compMakeup').value = preset.compMakeup;
    toggleCompressor();
    updateCompressor();
  } else {
    document.getElementById('compressorEnabled').checked = false;
    toggleCompressor();
  }

  // Apply limiter
  if (preset.limiter) {
    document.getElementById('limiterEnabled').checked = true;
    document.getElementById('limiterThreshold').value = preset.limThreshold;
    document.getElementById('limiterCeiling').value = preset.limCeiling;
    toggleLimiter();
    updateLimiter();
  } else {
    document.getElementById('limiterEnabled').checked = false;
    toggleLimiter();
  }

  // Apply EQ
  if (preset.eq) {
    document.getElementById('fxEnabled').checked = true;
    toggleFx();
    document.getElementById('eqLow').value = preset.eq[0];
    document.getElementById('eqMid').value = preset.eq[1];
    document.getElementById('eqHigh').value = preset.eq[2];
    updateEq('low', preset.eq[0]);
    updateEq('mid', preset.eq[1]);
    updateEq('high', preset.eq[2]);
  }

  showToast('Preset applied: ' + name);
}

// ===================== SETTINGS IMPORT/EXPORT =====================

async function exportAllSettings() {
  const data = {
    library,
    playlists,
    schedules,
    stationBreaks,
    dayParts,
    automationRules,
    soundboardPads,
    settings: appSettings,
    exportDate: new Date().toISOString()
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tonesintime-settings-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Settings exported');
}

async function importAllSettings() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);

      if (data.library) library = data.library;
      if (data.playlists) playlists = data.playlists;
      if (data.schedules) schedules = data.schedules;
      if (data.stationBreaks) stationBreaks = data.stationBreaks;
      if (data.dayParts) dayParts = { ...dayParts, ...data.dayParts };
      if (data.automationRules) automationRules = { ...automationRules, ...data.automationRules };
      if (data.soundboardPads) soundboardPads = data.soundboardPads;
      if (data.settings) appSettings = { ...appSettings, ...data.settings };

      applySettingsToUI();
      applyTheme(appSettings.theme);
      renderLibrary();
      renderPlaylistTabs();
      renderPlaylistTracks();
      updateSchedulePlaylistDropdown();
      updateProgramPlaylistSelect();
      updateDayPartDropdowns();
      restoreDayParts();
      restoreAutomationRules();
      renderSchedules();
      renderSoundBoard();
      renderStationBreaks();
      updateLibraryCount();

      await savePersistedData();
      showToast('Settings imported successfully');
    } catch (err) {
      showToast('Import failed: ' + err.message);
    }
  };
  input.click();
}

function resetAllSettings() {
  if (!confirm('Reset all settings to defaults? This will not delete your library or playlists.')) return;

  appSettings = {
    theme: 'dark',
    minimizeToTray: true,
    notificationsEnabled: true,
    notifyListenerConnect: true,
    notifyStreamStatus: true,
    notifyRecordingStatus: true,
    relayUrl: 'https://tonesintime.io',
    relayToken: '',
    relayUsername: ''
  };

  applySettingsToUI();
  applyTheme('dark');
  savePersistedData();
  window.slRadio.updateSettings(appSettings);
  showToast('Settings reset to defaults');
}

// ===================== FALLBACK FILE =====================

async function selectFallbackFile() {
  const files = await window.slRadio.selectAudioFiles();
  if (files && files.length > 0) {
    const file = files[0];
    document.getElementById('fallbackFile').value = file.filename || file.path;
    appSettings.fallbackFile = file.path;
    updateSettingsFromUI();
    showToast('Fallback file set');
  }
}

// ===================== ABOUT INFO =====================

function populateAboutInfo() {
  document.getElementById('aboutPlatform').textContent =
    navigator.platform + ' — ' + navigator.userAgent.match(/Electron\/([\d.]+)/)?.[1] || 'Electron';

  window.slRadio.checkFfmpeg().then(has => {
    document.getElementById('aboutFfmpeg').textContent = has ? 'Installed' : 'Not found';
  });
}

// ===================== DISCORD WEBHOOK TOGGLE =====================

function updateDiscordWebhookVisibility() {
  const enabled = document.getElementById('discordWebhookEnabled')?.checked;
  const row = document.getElementById('discordWebhookRow');
  if (row) row.style.display = enabled ? 'flex' : 'none';
}

// ===================== RELAY FUNCTIONS =====================

// Relay is fully automatic — no user interaction needed

// ===================== SOUND BOARD =====================

let soundboardPads = []; // Array of { filePath, filename }
let playingSounds = new Set(); // Set of filePaths currently playing

async function addSoundToBoard() {
  if (soundboardPads.length >= 12) {
    showToast('Sound board is full (max 12 pads)');
    return;
  }

  const result = await window.slRadio.selectSoundFile();
  if (result.canceled) return;

  // Check for duplicate
  if (soundboardPads.find(p => p.filePath === result.filePath)) {
    showToast('Sound already on board');
    return;
  }

  soundboardPads.push({
    filePath: result.filePath,
    filename: result.filename
  });

  renderSoundBoard();
  savePersistedData();
  showToast('Sound added: ' + result.filename);
}

async function playSoundPad(index) {
  const pad = soundboardPads[index];
  if (!pad) return;

  if (playingSounds.has(pad.filePath)) {
    showToast('Already playing');
    return;
  }

  const result = await window.slRadio.playSound(pad.filePath);
  if (!result.success) {
    showToast('Failed: ' + result.error);
    return;
  }

  playingSounds.add(pad.filePath);
  renderSoundBoard();
}

function removeSoundPad(index) {
  soundboardPads.splice(index, 1);
  renderSoundBoard();
  savePersistedData();
}

function renderSoundBoard() {
  const grid = document.getElementById('soundboardGrid');
  const empty = document.getElementById('soundboardEmpty');

  if (soundboardPads.length === 0) {
    grid.innerHTML = '<div class="track-list-empty" id="soundboardEmpty">No sounds loaded. Click "Add Sound" to add pads.</div>';
    return;
  }

  grid.innerHTML = soundboardPads.map((pad, i) => {
    const playing = playingSounds.has(pad.filePath);
    const label = pad.filename.replace(/\.[^.]+$/, '');
    const truncated = label.length > 16 ? label.substring(0, 14) + '...' : label;
    return `<button class="soundboard-pad${playing ? ' playing' : ''}"
      onclick="playSoundPad(${i})"
      oncontextmenu="event.preventDefault(); removeSoundPad(${i})"
      title="${escapeHtml(pad.filename)} (right-click to remove)">
      <span class="pad-label">${escapeHtml(truncated)}</span>
    </button>`;
  }).join('');
}

// ===================== AUDIO FX / 3-BAND EQ =====================

let fxEnabled = false;
let lowFilter = null;
let midFilter = null;
let highFilter = null;

function toggleFx() {
  fxEnabled = document.getElementById('fxEnabled').checked;
  if (fxEnabled) {
    insertEq();
  } else {
    removeEq();
  }
}

function insertEq() {
  if (!audioContext || !gainNode) return;

  // Create filter nodes
  lowFilter = audioContext.createBiquadFilter();
  lowFilter.type = 'lowshelf';
  lowFilter.frequency.value = 80;
  lowFilter.gain.value = parseFloat(document.getElementById('eqLow').value);

  midFilter = audioContext.createBiquadFilter();
  midFilter.type = 'peaking';
  midFilter.frequency.value = 1000;
  midFilter.Q.value = 1.0;
  midFilter.gain.value = parseFloat(document.getElementById('eqMid').value);

  highFilter = audioContext.createBiquadFilter();
  highFilter.type = 'highshelf';
  highFilter.frequency.value = 8000;
  highFilter.gain.value = parseFloat(document.getElementById('eqHigh').value);

  // Rewire: gainNode -> lowFilter -> midFilter -> highFilter -> (splitter + scriptProcessor)
  gainNode.disconnect();

  // If limiter is enabled, chain: gainNode -> EQ -> limiter -> output
  if (limiterEnabled && limiterNode && limiterOutputGain) {
    gainNode.connect(lowFilter);
    lowFilter.connect(midFilter);
    midFilter.connect(highFilter);
    highFilter.connect(limiterNode);
    // limiter chain is already connected to splitter/scriptProcessor
  } else {
    gainNode.connect(lowFilter);
    lowFilter.connect(midFilter);
    midFilter.connect(highFilter);

    // Reconnect to splitter and scriptProcessor
    const splitter = audioContext.createChannelSplitter(2);
    analyserL = audioContext.createAnalyser();
    analyserR = audioContext.createAnalyser();
    analyserL.fftSize = 256;
    analyserR.fftSize = 256;

    highFilter.connect(splitter);
    splitter.connect(analyserL, 0);
    splitter.connect(analyserR, 1);

    if (scriptProcessor) {
      highFilter.connect(scriptProcessor);
    }
  }
}

function removeEq() {
  if (!audioContext || !gainNode) return;

  gainNode.disconnect();

  if (lowFilter) { lowFilter.disconnect(); lowFilter = null; }
  if (midFilter) { midFilter.disconnect(); midFilter = null; }
  if (highFilter) { highFilter.disconnect(); highFilter = null; }

  // Reconnect directly (respect limiter state)
  if (limiterEnabled && limiterNode && limiterOutputGain) {
    gainNode.connect(limiterNode);
    // limiter chain is already connected
  } else {
    const splitter = audioContext.createChannelSplitter(2);
    analyserL = audioContext.createAnalyser();
    analyserR = audioContext.createAnalyser();
    analyserL.fftSize = 256;
    analyserR.fftSize = 256;

    gainNode.connect(splitter);
    splitter.connect(analyserL, 0);
    splitter.connect(analyserR, 1);

    if (scriptProcessor) {
      gainNode.connect(scriptProcessor);
    }
  }
}

function updateEq(band, value) {
  const val = parseFloat(value);
  const label = val >= 0 ? '+' + val + ' dB' : val + ' dB';

  switch (band) {
    case 'low':
      document.getElementById('eqLowVal').textContent = label;
      if (lowFilter) lowFilter.gain.value = val;
      break;
    case 'mid':
      document.getElementById('eqMidVal').textContent = label;
      if (midFilter) midFilter.gain.value = val;
      break;
    case 'high':
      document.getElementById('eqHighVal').textContent = label;
      if (highFilter) highFilter.gain.value = val;
      break;
  }
}

// ===================== SONG RECOGNITION =====================

let songRecogRunning = false;

function toggleSongRecog() {
  const enabled = document.getElementById('songRecogEnabled').checked;
  const apiKey = document.getElementById('acoustidApiKey')?.value || appSettings.acoustidApiKey || '';
  const display = document.getElementById('songRecogDisplay');

  if (enabled) {
    if (!apiKey) {
      display.innerHTML = '<div class="song-recog-idle" style="color:var(--red);">Enter your AcoustID API key first (free at acoustid.org)</div>';
      document.getElementById('songRecogEnabled').checked = false;
      return;
    }
    songRecogRunning = true;
    // Send the selected audio device name so ffmpeg records from the right input
    const deviceSelect = document.getElementById('audioDevice');
    const deviceName = deviceSelect ? deviceSelect.options[deviceSelect.selectedIndex]?.text || '' : '';
    window.slRadio.startSongRecog({ apiKey, deviceName });
    display.innerHTML = '<div class="song-recog-listening">Listening for songs...</div>';
    display.classList.remove('has-match');
  } else {
    songRecogRunning = false;
    window.slRadio.stopSongRecog();
    display.innerHTML = '<div class="song-recog-idle">Enable to identify songs from audio input</div>';
    display.classList.remove('has-match');
  }
}

function saveAcoustidKey() {
  const key = document.getElementById('acoustidApiKey')?.value || '';
  appSettings.acoustidApiKey = key;
  savePersistedData();
}

function onSongRecognized(data) {
  const display = document.getElementById('songRecogDisplay');
  if (!display) return;

  if (data.title && data.score > 0) {
    display.classList.add('has-match');
    display.innerHTML = `
      <div class="song-recog-title">${escapeHtml(data.title)}</div>
      <div class="song-recog-artist">${escapeHtml(data.artist)}</div>
      <div class="song-recog-meta">
        <span class="song-recog-album">${data.album ? escapeHtml(data.album) : ''}</span>
        <span class="song-recog-score">${data.score}% match</span>
      </div>
    `;

    // Auto-update now playing metadata with recognized song
    const npInput = document.getElementById('nowPlaying');
    if (npInput && data.score >= 70) {
      npInput.value = `${data.artist} - ${data.title}`;
      window.slRadio.updateMetadata({ song: `${data.artist} - ${data.title}`, artist: data.artist });
    }

    // Add to program log
    addProgramLogEntry('song', data.title, data.artist);

    showToast(`Identified: ${data.artist} - ${data.title}`);
  } else {
    display.classList.remove('has-match');
    display.innerHTML = '<div class="song-recog-listening">Listening for songs...</div>';
  }
}

// ===================== SONG RECOG TEST =====================

function findMaxSample(pcmChunks) {
  let max = 0;
  for (const chunk of pcmChunks) {
    const view = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2);
    for (let i = 0; i < view.length; i++) {
      const abs = Math.abs(view[i]);
      if (abs > max) max = abs;
    }
  }
  return max;
}

async function testSongRecog() {
  const debug = document.getElementById('songRecogDebug');
  const apiKey = document.getElementById('acoustidApiKey')?.value || appSettings.acoustidApiKey || '';

  if (!apiKey) {
    debug.textContent = 'ERROR: No API key set';
    return;
  }

  // Get selected audio device name to help ffmpeg find the right input
  const deviceSelect = document.getElementById('audioDevice');
  const deviceName = deviceSelect ? deviceSelect.options[deviceSelect.selectedIndex]?.text || '' : '';

  debug.textContent = `Recording 15s via ffmpeg from "${deviceName}"...\nCaptures directly from hardware — same path as streaming.`;

  try {
    const result = await window.slRadio.testSongRecog({ deviceName, apiKey });

    if (result.error) {
      debug.textContent = `ERROR: ${result.error}`;
    } else if (result.title) {
      debug.textContent = `MATCH: ${result.artist} - ${result.title}\nConfidence: ${result.score}%  |  Album: ${result.album || 'N/A'}\nFingerprint: ${result.fpLength} chars  |  Device: ${result.device || '?'}`;
      document.getElementById('songRecogDisplay').classList.add('has-match');
      document.getElementById('songRecogDisplay').innerHTML = `
        <div class="song-recog-title">${escapeHtml(result.title)}</div>
        <div class="song-recog-artist">${escapeHtml(result.artist)}</div>
        <div class="song-recog-meta">
          <span class="song-recog-album">${result.album ? escapeHtml(result.album) : ''}</span>
          <span class="song-recog-score">${result.score}% match</span>
        </div>`;
      showToast(`Identified: ${result.artist} - ${result.title}`);
    } else {
      debug.textContent = `No match in AcoustID database.\nFingerprint: ${result.fpLength || 0} chars, duration: ${result.fpDuration || 0}s\nDevice used: ${result.device || '?'}\nAPI results: ${result.apiResults || 0}\n\nIf fingerprint < 200 chars → audio too quiet.\nSong may not be in the MusicBrainz database.`;
    }
  } catch (err) {
    debug.textContent = `ERROR: ${err.message}`;
  }
}

// ===================== MIC LIVE / TALKOVER =====================

let micLive = false;
let micTalkbackInterval = null;
let micTalkbackStart = null;
let preDuckGain = 100;

function toggleMicLive() {
  const btn = document.getElementById('micLiveBtn');
  const label = document.getElementById('micLiveLabel');
  const timer = document.getElementById('micTalkbackTimer');

  if (micLive) {
    // Turn off mic
    micLive = false;
    btn.classList.remove('mic-active');
    label.textContent = 'MIC OFF';
    timer.style.display = 'none';

    // Restore music volume
    if (gainNode) {
      const slider = document.getElementById('gainSlider');
      gainNode.gain.setTargetAtTime(preDuckGain / 100, audioContext.currentTime,
        parseInt(document.getElementById('duckSpeed').value) / 1000);
    }

    if (micTalkbackInterval) { clearInterval(micTalkbackInterval); micTalkbackInterval = null; }
  } else {
    // Turn on mic — duck music
    micLive = true;
    btn.classList.add('mic-active');
    label.textContent = 'MIC LIVE';
    timer.style.display = 'flex';
    micTalkbackStart = Date.now();

    // Duck the music
    if (gainNode) {
      const slider = document.getElementById('gainSlider');
      preDuckGain = parseInt(slider.value);
      const duckDb = parseInt(document.getElementById('duckLevel').value);
      const duckLinear = Math.pow(10, duckDb / 20) * (preDuckGain / 100);
      const duckSpeed = parseInt(document.getElementById('duckSpeed').value) / 1000;
      gainNode.gain.setTargetAtTime(duckLinear, audioContext.currentTime, duckSpeed);
    }

    // Start talkback timer
    micTalkbackInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - micTalkbackStart) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      document.getElementById('talkbackTime').textContent = `${mins}:${String(secs).padStart(2, '0')}`;
    }, 200);
  }
}

// ===================== BROADCAST COMPRESSOR =====================

let compressorNode = null;
let compressorMakeupNode = null;
let compressorEnabled = false;

function toggleCompressor() {
  compressorEnabled = document.getElementById('compressorEnabled').checked;
  if (compressorEnabled && audioContext && mediaStream) {
    setupCompressor();
  }
}

function setupCompressor() {
  if (!audioContext) return;
  if (compressorNode) return; // already set up

  compressorNode = audioContext.createDynamicsCompressor();
  compressorMakeupNode = audioContext.createGain();

  updateCompressor();
}

function updateCompressor() {
  const threshold = parseFloat(document.getElementById('compThreshold').value);
  const ratio = parseFloat(document.getElementById('compRatio').value);
  const attack = parseFloat(document.getElementById('compAttack').value) / 1000;
  const release = parseFloat(document.getElementById('compRelease').value) / 1000;
  const makeup = parseFloat(document.getElementById('compMakeup').value);

  document.getElementById('compThresholdVal').textContent = threshold + ' dB';
  document.getElementById('compRatioVal').textContent = ratio + ':1';
  document.getElementById('compAttackVal').textContent = document.getElementById('compAttack').value + ' ms';
  document.getElementById('compReleaseVal').textContent = document.getElementById('compRelease').value + ' ms';
  document.getElementById('compMakeupVal').textContent = makeup + ' dB';

  if (compressorNode) {
    compressorNode.threshold.setValueAtTime(threshold, audioContext?.currentTime || 0);
    compressorNode.ratio.setValueAtTime(ratio, audioContext?.currentTime || 0);
    compressorNode.attack.setValueAtTime(attack, audioContext?.currentTime || 0);
    compressorNode.release.setValueAtTime(release, audioContext?.currentTime || 0);
  }
  if (compressorMakeupNode) {
    compressorMakeupNode.gain.setValueAtTime(Math.pow(10, makeup / 20), audioContext?.currentTime || 0);
  }
}

// ===================== SILENCE DETECTION / DEAD AIR =====================

let silenceDetectEnabled = true;
let silenceStartTime = null;
let silenceCheckInterval = null;

function toggleSilenceDetect() {
  silenceDetectEnabled = document.getElementById('silenceDetectEnabled').checked;
  if (silenceDetectEnabled) {
    startSilenceDetection();
  } else {
    stopSilenceDetection();
    clearDeadAirAlarm();
  }
}

function startSilenceDetection() {
  if (silenceCheckInterval) return;
  silenceStartTime = null;

  silenceCheckInterval = setInterval(() => {
    if (!isLive && !autoDjRunning) {
      clearDeadAirAlarm();
      return;
    }

    // Check current audio level from VU meters
    const meterL = document.getElementById('meterL');
    const level = parseFloat(meterL?.style.width || '0');
    const thresholdDb = parseInt(document.getElementById('silenceThreshold')?.value || -50);
    // Convert threshold to approximate meter percentage
    const thresholdPct = Math.max(0, ((thresholdDb + 60) / 60) * 100);
    const triggerSecs = parseInt(document.getElementById('silenceDuration')?.value || 5);

    if (level <= thresholdPct) {
      if (!silenceStartTime) {
        silenceStartTime = Date.now();
      } else if ((Date.now() - silenceStartTime) / 1000 >= triggerSecs) {
        triggerDeadAirAlarm();
      }
    } else {
      silenceStartTime = null;
      clearDeadAirAlarm();
    }
  }, 500);
}

function stopSilenceDetection() {
  if (silenceCheckInterval) {
    clearInterval(silenceCheckInterval);
    silenceCheckInterval = null;
  }
}

function triggerDeadAirAlarm() {
  const indicator = document.getElementById('silenceIndicator');
  const status = document.getElementById('silenceStatus');
  if (indicator && !indicator.classList.contains('dead-air')) {
    indicator.classList.add('dead-air');
    status.textContent = 'DEAD AIR';
    showToast('Dead air detected!');
  }
}

function clearDeadAirAlarm() {
  const indicator = document.getElementById('silenceIndicator');
  const status = document.getElementById('silenceStatus');
  if (indicator) {
    indicator.classList.remove('dead-air');
    status.textContent = 'AUDIO OK';
  }
}

// ===================== BROADCAST DELAY / DUMP =====================

let broadcastDelayEnabled = false;
let delayBufferFillInterval = null;
let delayBufferPct = 0;

function toggleBroadcastDelay() {
  broadcastDelayEnabled = document.getElementById('delayEnabled').checked;
  const dumpBtn = document.getElementById('dumpBtn');

  if (broadcastDelayEnabled) {
    dumpBtn.disabled = false;
    delayBufferPct = 0;
    const delaySecs = parseInt(document.getElementById('delaySeconds').value);

    // Simulate buffer filling over the delay period
    delayBufferFillInterval = setInterval(() => {
      if (delayBufferPct < 100) {
        delayBufferPct += (100 / (delaySecs * 10));
        if (delayBufferPct > 100) delayBufferPct = 100;
      }
      document.getElementById('delayFill').style.width = delayBufferPct + '%';
      document.getElementById('delayBufferStatus').textContent =
        delayBufferPct >= 100 ? 'Buffer full — protected' : 'Filling buffer...';
    }, 100);

    showToast('Broadcast delay enabled — ' + delaySecs + 's buffer');
  } else {
    dumpBtn.disabled = true;
    delayBufferPct = 0;
    document.getElementById('delayFill').style.width = '0%';
    document.getElementById('delayBufferStatus').textContent = 'Buffer empty';
    if (delayBufferFillInterval) { clearInterval(delayBufferFillInterval); delayBufferFillInterval = null; }
  }
}

function dumpAudio() {
  if (!broadcastDelayEnabled) return;

  // Reset the delay buffer
  delayBufferPct = 0;
  document.getElementById('delayFill').style.width = '0%';
  document.getElementById('delayBufferStatus').textContent = 'DUMPED — Refilling...';

  showToast('Audio dumped — buffer clearing');

  // Notify main process
  window.slRadio.send?.('broadcast-dump');
}

// ===================== PROGRAM PAGE — NEW FEATURES =====================

// Program log state
let programLog = [];

// Station breaks state
let stationBreaks = [];

// Day-parts state
let dayParts = {
  morning: '',
  midday: '',
  afternoon: '',
  evening: '',
  overnight: ''
};

// Automation rules state
let automationRules = {
  mode: 'sequential',
  artistSeparation: 3,
  titleSeparation: 30,
  autoFillGaps: true,
  autoCrossfade: true,
  autoGainLevel: false,
  breakInterval: 4
};

// Program clock
let programClockInterval = null;

function startProgramClock() {
  updateProgramClock();
  if (programClockInterval) clearInterval(programClockInterval);
  programClockInterval = setInterval(updateProgramClock, 1000);
}

function updateProgramClock() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  const el = document.getElementById('clockTime');
  if (el) el.textContent = `${h}:${m}:${s}`;
  drawProgramClock(now);
}

function drawProgramClock(now) {
  const canvas = document.getElementById('programClockCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(cx, cy) - 10;

  ctx.clearRect(0, 0, w, h);

  // Get theme colors
  const isDark = !document.body.classList.contains('light-theme');
  const bgColor = isDark ? '#2a2a2a' : '#f8f8f8';
  const borderColor = isDark ? '#3d3846' : '#c8c8c8';
  const textColor = isDark ? '#deddda' : '#111111';
  const mutedColor = isDark ? '#77767b' : '#666666';
  const accentColor = '#e5a50a';
  const greenColor = '#33d17a';

  // Draw clock face
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = bgColor;
  ctx.fill();
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Draw day-part segments
  const dayPartColors = {
    morning: '#f6d32d40',
    midday: '#e5a50a40',
    afternoon: '#ff780040',
    evening: '#9141ac40',
    overnight: '#3584e440'
  };
  const dayPartHours = {
    morning: [6, 10],
    midday: [10, 15],
    afternoon: [15, 19],
    evening: [19, 24],
    overnight: [0, 6]
  };

  Object.entries(dayPartHours).forEach(([part, [start, end]]) => {
    if (dayParts[part]) {
      const startAngle = ((start / 24) * Math.PI * 2) - Math.PI / 2;
      const endAngle = ((end / 24) * Math.PI * 2) - Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r - 4, startAngle, endAngle);
      ctx.closePath();
      ctx.fillStyle = dayPartColors[part];
      ctx.fill();
    }
  });

  // Draw schedule blocks
  schedules.forEach(sched => {
    if (!sched.enabled) return;
    const [sh, sm] = sched.startTime.split(':').map(Number);
    const [eh, em] = sched.endTime.split(':').map(Number);
    const startH = sh + sm / 60;
    const endH = eh + em / 60;
    const startAngle = ((startH / 24) * Math.PI * 2) - Math.PI / 2;
    const endAngle = ((endH / 24) * Math.PI * 2) - Math.PI / 2;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r - 14, startAngle, endAngle);
    ctx.closePath();
    ctx.fillStyle = greenColor + '50';
    ctx.fill();
    ctx.strokeStyle = greenColor;
    ctx.lineWidth = 1;
    ctx.stroke();
  });

  // Hour markers
  for (let i = 0; i < 24; i++) {
    const angle = ((i / 24) * Math.PI * 2) - Math.PI / 2;
    const isMajor = i % 6 === 0;
    const innerR = r - (isMajor ? 16 : 10);
    const outerR = r - 4;
    ctx.beginPath();
    ctx.moveTo(cx + innerR * Math.cos(angle), cy + innerR * Math.sin(angle));
    ctx.lineTo(cx + outerR * Math.cos(angle), cy + outerR * Math.sin(angle));
    ctx.strokeStyle = isMajor ? textColor : mutedColor;
    ctx.lineWidth = isMajor ? 2 : 1;
    ctx.stroke();

    // Hour labels for major hours
    if (isMajor) {
      const labelR = r - 24;
      ctx.font = '10px "Ubuntu Mono", monospace';
      ctx.fillStyle = textColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i), cx + labelR * Math.cos(angle), cy + labelR * Math.sin(angle));
    }
  }

  // Current time hand (24-hour)
  const hours = now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
  const handAngle = ((hours / 24) * Math.PI * 2) - Math.PI / 2;
  const handLen = r - 30;

  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + handLen * Math.cos(handAngle), cy + handLen * Math.sin(handAngle));
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.stroke();

  // Center dot
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fillStyle = accentColor;
  ctx.fill();
}

// ===================== PROGRAM SIDEBAR TABS =====================

function switchProgramSideTab(tab) {
  const tabs = document.querySelectorAll('.program-side-tab');
  const panels = document.querySelectorAll('.program-side-panel');

  tabs.forEach(t => t.classList.remove('active'));
  panels.forEach(p => p.classList.remove('active'));

  const tabMap = {
    library: 'programSideLibrary',
    playlists: 'programSidePlaylists',
    schedule: 'programSideSchedule',
    breaks: 'programSideBreaks',
    log: 'programSideLog'
  };

  const panel = document.getElementById(tabMap[tab]);
  if (panel) panel.classList.add('active');

  // Activate the clicked tab button
  const idx = ['library', 'playlists', 'schedule', 'breaks', 'log'].indexOf(tab);
  if (idx >= 0 && tabs[idx]) tabs[idx].classList.add('active');
}

// ===================== QUEUE RENDERING =====================

function renderUpNext(currentIndex, total) {
  const list = document.getElementById('upNextList');
  if (!list) return;

  if (selectedPlaylistIndex < 0 || !playlists[selectedPlaylistIndex]) {
    list.innerHTML = '<div class="track-list-empty">Select a playlist to see the queue</div>';
    return;
  }

  const tracks = playlists[selectedPlaylistIndex].tracks;
  if (tracks.length === 0) {
    list.innerHTML = '<div class="track-list-empty">Playlist is empty</div>';
    return;
  }

  // Calculate ETAs from current position
  let etaSeconds = 0;
  const now = new Date();
  let html = '';

  for (let i = 0; i < tracks.length; i++) {
    const trackIdx = i % tracks.length;
    const track = tracks[trackIdx];
    if (!track) continue;

    const isCurrent = (i === currentIndex);

    // ETA time
    const eta = new Date(now.getTime() + etaSeconds * 1000);
    const etaStr = String(eta.getHours()).padStart(2, '0') + ':' + String(eta.getMinutes()).padStart(2, '0');

    html += `
      <div class="queue-item ${isCurrent ? 'queue-playing' : 'queue-music'}">
        <span class="queue-index">${i + 1}</span>
        <span class="queue-eta">${isCurrent ? 'NOW' : etaStr}</span>
        <span class="queue-title">${escapeHtml(track.title)}</span>
        <span class="queue-artist">${escapeHtml(track.artist)}</span>
        <span class="queue-duration">${formatDuration(track.duration)}</span>
      </div>`;

    etaSeconds += (track.duration || 0);
  }

  list.innerHTML = html;

  // Scroll to current track
  const playing = list.querySelector('.queue-playing');
  if (playing) playing.scrollIntoView({ block: 'nearest' });
}

// Render full queue when playlist is selected (not just during playback)
function renderFullQueue() {
  if (selectedPlaylistIndex < 0 || !playlists[selectedPlaylistIndex]) return;
  renderUpNext(-1, playlists[selectedPlaylistIndex].tracks.length);
}

// ===================== PROGRAM LOG =====================

function addProgramLogEntry(type, title, artist) {
  const now = new Date();
  const time = String(now.getHours()).padStart(2, '0') + ':' +
    String(now.getMinutes()).padStart(2, '0') + ':' +
    String(now.getSeconds()).padStart(2, '0');

  programLog.unshift({ time, type, title, artist: artist || '' });

  // Keep max 200 entries
  if (programLog.length > 200) programLog.length = 200;

  renderProgramLog();
}

function renderProgramLog() {
  const el = document.getElementById('programLog');
  if (!el) return;

  if (programLog.length === 0) {
    el.innerHTML = '<div class="track-list-empty">No tracks played yet</div>';
    return;
  }

  el.innerHTML = programLog.map((entry, i) => {
    const typeClass = entry.type === 'song' ? 'log-song' : entry.type === 'break' ? 'log-break' : 'log-sched';
    const typeLabel = entry.type === 'song' ? 'SONG' : entry.type === 'break' ? 'BREAK' : 'SCHED';
    return `
      <div class="log-entry ${i === 0 ? 'log-current' : ''}">
        <span class="log-time">${entry.time}</span>
        <span class="log-type ${typeClass}">${typeLabel}</span>
        <span class="log-title">${escapeHtml(entry.title)}</span>
        <span class="log-artist">${escapeHtml(entry.artist)}</span>
      </div>`;
  }).join('');
}

function clearProgramLog() {
  programLog = [];
  renderProgramLog();
}

function exportProgramLog() {
  if (programLog.length === 0) {
    showToast('No log entries to export');
    return;
  }

  let csv = 'Time,Type,Title,Artist\n';
  programLog.forEach(entry => {
    csv += `"${entry.time}","${entry.type}","${entry.title.replace(/"/g, '""')}","${entry.artist.replace(/"/g, '""')}"\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `program-log-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Log exported');
}

// ===================== LIBRARY SEARCH =====================

function filterLibrary(query) {
  const q = query.toLowerCase().trim();
  const items = document.querySelectorAll('#libraryList .track-item');
  items.forEach(item => {
    if (!q) {
      item.style.display = '';
      return;
    }
    const text = item.textContent.toLowerCase();
    item.style.display = text.includes(q) ? '' : 'none';
  });
}

// ===================== PLAYLIST STATS =====================

function updatePlaylistStats() {
  const el = document.getElementById('playlistStats');
  if (!el) return;

  if (selectedPlaylistIndex < 0 || !playlists[selectedPlaylistIndex]) {
    el.innerHTML = '';
    return;
  }

  const tracks = playlists[selectedPlaylistIndex].tracks;
  const totalDuration = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
  const hours = Math.floor(totalDuration / 3600);
  const mins = Math.floor((totalDuration % 3600) / 60);

  el.innerHTML = `${tracks.length} tracks &middot; ${hours > 0 ? hours + 'h ' : ''}${mins}m`;
}

// ===================== TRANSPORT CONTROLS =====================

function updateProgramPlaylistSelect() {
  const select = document.getElementById('programPlaylistSelect');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">-- Select playlist --</option>';
  playlists.forEach((p, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `${p.name} (${p.tracks.length} tracks)`;
    select.appendChild(opt);
  });
  // Restore selection
  if (current !== '' && playlists[parseInt(current)]) {
    select.value = current;
  } else if (selectedPlaylistIndex >= 0) {
    select.value = selectedPlaylistIndex;
  }
}

function onProgramPlaylistSelect(value) {
  const idx = parseInt(value);
  if (!isNaN(idx) && playlists[idx]) {
    selectedPlaylistIndex = idx;
    renderPlaylistTabs();
    renderPlaylistTracks();
    renderFullQueue();
  }
}

function programPlayPause() {
  if (autoDjRunning) {
    stopAutoDj();
  } else {
    // Make sure a playlist is selected from the dropdown
    const select = document.getElementById('programPlaylistSelect');
    if (select && select.value !== '') {
      const idx = parseInt(select.value);
      if (!isNaN(idx) && playlists[idx]) {
        selectedPlaylistIndex = idx;
      }
    }
    startAutoDj();
  }
}

function programStop() {
  if (autoDjRunning) {
    stopAutoDj();
  }
  const playBtn = document.getElementById('programPlayBtn');
  if (playBtn) {
    playBtn.innerHTML = '&#9654;';
    playBtn.classList.remove('playing');
  }
}

function programSkipForward() {
  if (!autoDjRunning) return;
  // Restart auto-dj which triggers next track via the main process
  window.slRadio.send?.('autodj-skip-forward');
  showToast('Skipping to next track');
}

function programSkipBack() {
  if (!autoDjRunning) return;
  window.slRadio.send?.('autodj-skip-back');
  showToast('Going to previous track');
}

// ===================== CROSSFADE CONTROL =====================

function updateCrossfade(value) {
  document.getElementById('crossfadeValue').textContent = value + 's';
  window.slRadio.send?.('update-crossfade', parseInt(value));
}

// ===================== STATION BREAKS =====================

async function addStationBreak() {
  const files = await window.slRadio.selectAudioFiles();
  if (!files || files.length === 0) return;

  for (const file of files) {
    const meta = await window.slRadio.getTrackMetadata(file.path);
    const name = meta?.title || file.filename || 'Untitled';
    const duration = meta?.duration || 0;

    // Determine type from filename/title
    let type = 'jingle';
    const lower = (name + ' ' + (file.filename || '')).toLowerCase();
    if (lower.includes('sweep')) type = 'sweeper';
    else if (lower.includes('id') || lower.includes('station id')) type = 'id';
    else if (lower.includes('promo')) type = 'promo';

    stationBreaks.push({
      id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
      name,
      path: file.path,
      type,
      duration
    });
  }

  renderStationBreaks();
  savePersistedData();
  showToast(`Added ${files.length} break(s)`);
}

function removeStationBreak(index) {
  stationBreaks.splice(index, 1);
  renderStationBreaks();
  savePersistedData();
}

function cycleBreakType(index) {
  const types = ['jingle', 'sweeper', 'id', 'promo'];
  const current = types.indexOf(stationBreaks[index].type);
  stationBreaks[index].type = types[(current + 1) % types.length];
  renderStationBreaks();
  savePersistedData();
}

function renderStationBreaks() {
  const el = document.getElementById('breakList');
  if (!el) return;

  if (stationBreaks.length === 0) {
    el.innerHTML = '<div class="track-list-empty">No station breaks. Add jingles, sweepers, or IDs.</div>';
    return;
  }

  el.innerHTML = stationBreaks.map((brk, i) => `
    <div class="break-item">
      <span class="break-type-badge ${brk.type}" onclick="cycleBreakType(${i})" title="Click to change type">${brk.type.toUpperCase()}</span>
      <span class="break-name">${escapeHtml(brk.name)}</span>
      <span class="break-duration">${formatDuration(brk.duration)}</span>
      <button class="track-remove" onclick="removeStationBreak(${i})" title="Remove">&times;</button>
    </div>
  `).join('');
}

// ===================== DAY-PARTS =====================

function updateDayPartDropdowns() {
  const ids = ['dpMorning', 'dpMidday', 'dpAfternoon', 'dpEvening', 'dpOvernight'];
  ids.forEach(id => {
    const select = document.getElementById(id);
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">-- None --</option>';
    playlists.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.name;
      select.appendChild(opt);
    });
    select.value = current;
  });
}

function saveDayParts() {
  dayParts.morning = document.getElementById('dpMorning')?.value || '';
  dayParts.midday = document.getElementById('dpMidday')?.value || '';
  dayParts.afternoon = document.getElementById('dpAfternoon')?.value || '';
  dayParts.evening = document.getElementById('dpEvening')?.value || '';
  dayParts.overnight = document.getElementById('dpOvernight')?.value || '';
  savePersistedData();
}

function restoreDayParts() {
  if (dayParts.morning) document.getElementById('dpMorning').value = dayParts.morning;
  if (dayParts.midday) document.getElementById('dpMidday').value = dayParts.midday;
  if (dayParts.afternoon) document.getElementById('dpAfternoon').value = dayParts.afternoon;
  if (dayParts.evening) document.getElementById('dpEvening').value = dayParts.evening;
  if (dayParts.overnight) document.getElementById('dpOvernight').value = dayParts.overnight;
}

// ===================== AUTOMATION RULES =====================

function updateAutomationMode() {
  const mode = document.getElementById('automationMode').value;
  automationRules.mode = mode;

  // Sync shuffle toggle
  const shuffleToggle = document.getElementById('shuffleToggle');
  if (shuffleToggle) {
    shuffleToggle.checked = mode === 'shuffle';
  }

  saveAutomationRules();
}

function saveAutomationRules() {
  automationRules.artistSeparation = parseInt(document.getElementById('artistSeparation')?.value || 3);
  automationRules.titleSeparation = parseInt(document.getElementById('titleSeparation')?.value || 30);
  automationRules.autoFillGaps = document.getElementById('autoFillGaps')?.checked ?? true;
  automationRules.autoCrossfade = document.getElementById('autoCrossfade')?.checked ?? true;
  automationRules.autoGainLevel = document.getElementById('autoGainLevel')?.checked ?? false;
  automationRules.breakInterval = parseInt(document.getElementById('breakInterval')?.value || 4);
  savePersistedData();
}

function restoreAutomationRules() {
  const el = (id) => document.getElementById(id);
  if (el('automationMode')) el('automationMode').value = automationRules.mode || 'sequential';
  if (el('artistSeparation')) el('artistSeparation').value = automationRules.artistSeparation ?? 3;
  if (el('titleSeparation')) el('titleSeparation').value = automationRules.titleSeparation ?? 30;
  if (el('autoFillGaps')) el('autoFillGaps').checked = automationRules.autoFillGaps ?? true;
  if (el('autoCrossfade')) el('autoCrossfade').checked = automationRules.autoCrossfade ?? true;
  if (el('autoGainLevel')) el('autoGainLevel').checked = automationRules.autoGainLevel ?? false;
  if (el('breakInterval')) el('breakInterval').value = automationRules.breakInterval ?? 4;
}

// ===================== LIBRARY COUNT =====================

function updateLibraryCount() {
  const el = document.getElementById('libraryCount');
  if (el) el.textContent = library.length;
}

init();


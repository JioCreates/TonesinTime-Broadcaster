const { spawn } = require('child_process');
const db = require('./db');

class AutoDJ {
  constructor() {
    // Map of streamId -> { process, currentTrackIndex, playlistId, tracks }
    this.activeStreams = new Map();
    this.checkInterval = null;
  }

  start() {
    console.log('[AutoDJ] Starting scheduler (30s check interval)');
    this.check();
    this.checkInterval = setInterval(() => this.check(), 30000);
  }

  stop() {
    console.log('[AutoDJ] Stopping scheduler');
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    // Stop all active streams
    for (const [streamId] of this.activeStreams) {
      this.stopStream(streamId);
    }
  }

  check() {
    try {
      const now = new Date();
      const dayOfWeek = now.getDay(); // 0=Sunday
      const currentTime = now.toTimeString().slice(0, 5); // "HH:MM"

      // Find all enabled schedules for right now
      const activeSchedules = db.prepare(`
        SELECT s.*, st.port, st.mount, st.source_password, st.status as stream_status,
               st.user_id as stream_owner_id
        FROM schedules s
        JOIN streams st ON st.id = s.stream_id
        WHERE s.enabled = 1
          AND s.day_of_week = ?
          AND s.start_time <= ?
          AND s.end_time > ?
          AND st.status = 'running'
      `).all(dayOfWeek, currentTime, currentTime);

      // Build set of stream IDs that should be active
      const shouldBeActive = new Set();

      for (const schedule of activeSchedules) {
        shouldBeActive.add(schedule.stream_id);

        const current = this.activeStreams.get(schedule.stream_id);

        // If not currently playing, or playlist changed, start it
        if (!current || current.playlistId !== schedule.playlist_id) {
          if (current) {
            this.stopStream(schedule.stream_id);
          }
          this.startPlaylist(schedule.stream_id, schedule.playlist_id, schedule);
        }
      }

      // Stop streams that should no longer be active
      for (const [streamId, state] of this.activeStreams) {
        if (!shouldBeActive.has(streamId) && !state.shuffleAll) {
          this.stopStream(streamId);
        }
      }
    } catch (err) {
      console.error('[AutoDJ] Check error:', err);
    }
  }

  startPlaylist(streamId, playlistId, streamInfo) {
    const tracks = db.prepare(`
      SELECT t.* FROM playlist_tracks pt
      JOIN tracks t ON t.id = pt.track_id
      WHERE pt.playlist_id = ?
      ORDER BY pt.position ASC
    `).all(playlistId);

    if (tracks.length === 0) {
      console.log(`[AutoDJ] Playlist ${playlistId} is empty, skipping`);
      return;
    }

    console.log(`[AutoDJ] Starting playlist ${playlistId} on stream ${streamId} (${tracks.length} tracks)`);

    const state = {
      playlistId,
      tracks,
      currentTrackIndex: 0,
      process: null,
      streamInfo,
      shuffleAll: false,
    };

    this.activeStreams.set(streamId, state);
    this.playNextTrack(streamId);
  }

  startShuffleAll(streamId, userId, streamInfo) {
    const tracks = db.prepare('SELECT * FROM tracks WHERE user_id = ?').all(userId);

    if (tracks.length === 0) {
      console.log(`[AutoDJ] No tracks for user ${userId}, skipping shuffle`);
      return;
    }

    // Shuffle array
    for (let i = tracks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
    }

    console.log(`[AutoDJ] Starting shuffle-all on stream ${streamId} (${tracks.length} tracks)`);

    const state = {
      playlistId: null,
      tracks,
      currentTrackIndex: 0,
      process: null,
      streamInfo,
      shuffleAll: true,
    };

    this.activeStreams.set(streamId, state);
    this.playNextTrack(streamId);
  }

  playNextTrack(streamId) {
    const state = this.activeStreams.get(streamId);
    if (!state) return;

    // Loop playlist
    if (state.currentTrackIndex >= state.tracks.length) {
      if (state.shuffleAll) {
        // Re-shuffle
        for (let i = state.tracks.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [state.tracks[i], state.tracks[j]] = [state.tracks[j], state.tracks[i]];
        }
      }
      state.currentTrackIndex = 0;
    }

    const track = state.tracks[state.currentTrackIndex];
    const { port, mount, source_password } = state.streamInfo;

    const icecastUrl = `icecast://source:${source_password}@localhost:${port}${mount}`;

    console.log(`[AutoDJ] Playing track: ${track.title || track.filename} on stream ${streamId}`);

    // Log to play history
    try {
      db.prepare('INSERT INTO play_history (stream_id, track_id) VALUES (?, ?)').run(streamId, track.id);
    } catch (err) {
      console.error('[AutoDJ] Failed to log play history:', err);
    }

    // Use ffmpeg to decode MP3 and stream to Icecast
    const ffmpeg = spawn('ffmpeg', [
      '-re',                    // Read at native frame rate
      '-i', track.file_path,    // Input file
      '-vn',                    // No video
      '-acodec', 'libmp3lame',  // Re-encode to MP3
      '-ab', '128k',            // Bitrate
      '-ar', '44100',           // Sample rate
      '-ac', '2',               // Stereo
      '-content_type', 'audio/mpeg',
      '-f', 'mp3',
      icecastUrl,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    state.process = ffmpeg;

    ffmpeg.stderr.on('data', (data) => {
      // ffmpeg outputs progress to stderr - only log errors
      const msg = data.toString();
      if (msg.includes('Error') || msg.includes('error')) {
        console.error(`[AutoDJ] ffmpeg error (stream ${streamId}):`, msg.trim());
      }
    });

    ffmpeg.on('close', (code) => {
      const currentState = this.activeStreams.get(streamId);
      if (!currentState || currentState.process !== ffmpeg) {
        return; // Stream was stopped or replaced
      }

      if (code === 0 || code === null) {
        // Track finished, play next
        state.currentTrackIndex++;
        this.playNextTrack(streamId);
      } else {
        console.error(`[AutoDJ] ffmpeg exited with code ${code} on stream ${streamId}`);
        // Wait a bit then try next track
        setTimeout(() => {
          const s = this.activeStreams.get(streamId);
          if (s && s.process === ffmpeg) {
            s.currentTrackIndex++;
            this.playNextTrack(streamId);
          }
        }, 5000);
      }
    });

    ffmpeg.on('error', (err) => {
      console.error(`[AutoDJ] ffmpeg spawn error (stream ${streamId}):`, err.message);
    });
  }

  stopStream(streamId) {
    const state = this.activeStreams.get(streamId);
    if (!state) return;

    console.log(`[AutoDJ] Stopping stream ${streamId}`);

    if (state.process) {
      try {
        state.process.kill('SIGTERM');
      } catch (err) {
        console.error('[AutoDJ] Error killing ffmpeg:', err);
      }
    }

    this.activeStreams.delete(streamId);
  }

  getStatus(streamId) {
    const state = this.activeStreams.get(streamId);
    if (!state) return { active: false };

    const currentTrack = state.tracks[state.currentTrackIndex] || null;
    return {
      active: true,
      playlistId: state.playlistId,
      shuffleAll: state.shuffleAll,
      currentTrack: currentTrack ? {
        id: currentTrack.id,
        title: currentTrack.title,
        artist: currentTrack.artist,
        filename: currentTrack.filename,
      } : null,
      trackIndex: state.currentTrackIndex,
      totalTracks: state.tracks.length,
    };
  }

  getAllStatus() {
    const statuses = {};
    for (const [streamId] of this.activeStreams) {
      statuses[streamId] = this.getStatus(streamId);
    }
    return statuses;
  }
}

module.exports = AutoDJ;

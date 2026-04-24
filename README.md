```
 _____                     _       _____ _                
|_   _|__  _ __   ___  ___(_)_ __ |_   _(_)_ __ ___   ___
  | |/ _ \| '_ \ / _ \/ __| | '_ \  | | | | '_ ` _ \ / _ \
  | | (_) | | | |  __/\__ \ | | | | | | | | | | | | |  __/
  |_|\___/|_| |_|\___||___/_|_| |_| |_| |_|_| |_| |_|\___|

  ____                      _               _
 | __ ) _ __ ___   __ _  __| | ___ __ _ ___| |_ ___ _ __
 |  _ \| '__/ _ \ / _` |/ _` |/ __/ _` / __| __/ _ \ '__|
 | |_) | | | (_) | (_| | (_| | (_| (_| \__ \ ||  __/ |
 |____/|_|  \___/ \__,_|\__,_|\___\__,_|___/\__\___|_|

 +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 |  Capture. Stream. Broadcast. From your desktop.        |
 +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

# TonesinTime Broadcaster

A standalone desktop audio broadcast server built with Electron. Capture any audio interface on your machine and stream it live to any Icecast-compatible platform — or run your own.

## Features

- **Live Audio Streaming** -- capture system/interface audio and broadcast via Icecast/Shoutcast
- **Real-time Spectrum Analyzer** -- waveform and FFT visualization
- **3-Band EQ + Audio FX** -- built-in equalizer, compressor, limiter
- **Crossfade Engine** -- smooth transitions between tracks
- **Soundboard** -- trigger samples and jingles on the fly
- **Auto-DJ / Program Mode** -- schedule playlists, let it run unattended
- **Track Management** -- drag-and-drop, song history, now-playing API
- **Recording** -- record your broadcast locally
- **Embed Designer** -- generate embeddable web player widgets
- **Stream Health Monitor** -- bitrate, buffer, listener stats
- **Dark / Light Theme** -- system-aware with manual toggle
- **Global Shortcuts** -- control playback from anywhere
- **Tray Mode** -- minimize to system tray, keep streaming
- **Cross-platform** -- macOS and Windows builds

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [FFmpeg](https://ffmpeg.org/) installed and on your PATH
- An audio interface or virtual audio device

## Quick Start

```bash
git clone https://github.com/JioCreates/TonesinTime-Broadcaster.git
cd TonesinTime-Broadcaster
npm install
npm start
```

## Building

```bash
# macOS
npm run build:mac

# Windows
npm run build:win

# Both
npm run build
```

Built apps land in `dist/`.

## Configuration

On first launch the app auto-detects your audio devices and FFmpeg installation. Configure your stream target in the **Stream** tab:

| Field         | Example                        |
|---------------|--------------------------------|
| Server URL    | `icecast.example.com`          |
| Port          | `8000`                         |
| Mount Point   | `/live`                        |
| Username      | `source`                       |
| Password      | your stream password           |

## Cloud Server (Optional)

The `cloud/` directory contains a self-hosted multi-tenant Icecast platform with:

- Express API with JWT auth
- Per-user Icecast containers via Docker
- Stripe billing integration
- Auto-DJ playlist scheduling

See [`cloud/README.md`](cloud/README.md) for setup instructions.

## Project Structure

```
.
+-- main.js            # Electron main process
+-- preload.js         # IPC bridge
+-- src/
|   +-- index.html     # App UI
|   +-- renderer.js    # Frontend logic
|   +-- styles.css     # Styling
+-- cloud/             # Optional cloud server
+-- build/             # Build assets (icons)
+-- package.json
+-- LICENSE
```

## Tech Stack

- **Electron** -- desktop shell
- **FFmpeg** -- audio encoding and streaming
- **Web Audio API** -- real-time analysis and effects
- **lamejs** -- MP3 encoding fallback

## Roadmap

These are planned enhancements open for contribution. Pick one up or propose your own.

- [ ] **Multi-stream Output** -- broadcast to multiple Icecast/Shoutcast endpoints simultaneously from a single session
- [ ] **Plugin System** -- loadable audio effect plugins (VST/AU bridge or JS-based) so users can extend the FX chain
- [ ] **Mobile Companion App** -- lightweight remote control for start/stop, track skip, and live stats from your phone
- [ ] **Scheduled Recordings** -- timer-based recording with calendar integration for unattended capture
- [ ] **Collaborative DJ Handoff** -- allow multiple DJs to queue tracks and hand off the live stream without downtime

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Whether it's a bug fix, new feature, docs improvement, or a roadmap item above -- all PRs are appreciated.

## License

MIT -- see [LICENSE](LICENSE) for details.

---

Made by [JioCreates](https://github.com/JioCreates)

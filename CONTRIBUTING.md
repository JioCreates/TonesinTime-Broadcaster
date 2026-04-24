# Contributing to TonesinTime Broadcaster

Thanks for your interest in contributing! This guide will get you up and running.

## Getting Started

1. Fork the repo
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR-USERNAME/TonesinTime-Broadcaster.git
   cd TonesinTime-Broadcaster
   npm install
   npm start
   ```
3. Create a feature branch:
   ```bash
   git checkout -b feat/your-feature-name
   ```

## Development

- `npm start` launches the Electron app in dev mode
- Main process code lives in `main.js`
- Renderer (UI) code lives in `src/`
- Cloud server code lives in `cloud/`

FFmpeg must be installed on your system. The app auto-detects it via `which ffmpeg`.

## Pull Requests

- Keep PRs focused -- one feature or fix per PR
- Branch from `main`, target `main`
- Write a clear description of what changed and why
- Test your changes on at least one platform (macOS or Windows)
- Follow the existing code style -- no linter is enforced yet, just stay consistent

## Branch Naming

| Type    | Prefix           | Example                       |
|---------|------------------|-------------------------------|
| Feature | `feat/`          | `feat/multi-stream-output`    |
| Bug fix | `fix/`           | `fix/eq-slider-reset`         |
| Docs    | `docs/`          | `docs/setup-guide`            |
| Refactor| `refactor/`      | `refactor/audio-pipeline`     |

## Reporting Bugs

Open an issue with:

- Steps to reproduce
- Expected vs actual behavior
- OS and version
- Console output if applicable (View > Toggle Developer Tools)

## Feature Requests

Open an issue tagged `enhancement`. Check the roadmap in the README first -- your idea might already be listed.

## Code of Conduct

Be respectful. This is a collaborative space. Harassment, trolling, or bad-faith engagement will not be tolerated.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

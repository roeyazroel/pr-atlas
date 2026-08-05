# PR Atlas

A local-first Electron workspace for understanding pull requests as logical changes, evidence, tests, review signals, and guided system flows.

## Run locally

Requirements: Node.js 20+, GitHub CLI authenticated to `github.com`, and at least one supported analysis runtime on `PATH`: Claude Code (`claude`), Codex CLI (`codex`), or Cursor Agent (`cursor-agent`).

```sh
npm install
npm run dev
```

The app discovers repositories and open pull requests through the active GitHub CLI account. Browsing GitHub data is read-only. Starting a real analysis shows a provider-specific confirmation before repository context is passed to that runtime's configured model service. Provider processes run with read-only/plan-mode controls, and validated walkthrough artifacts remain in the Electron application-data directory.

PR Atlas checks its public GitHub Releases feed at startup. When a newer platform installer is available, the sidebar can download it directly and atomically into the user's Downloads directory, then open the downloaded installer without sending the user through the GitHub website.

## Validate

```sh
npm test -- --run
npm run typecheck
npm run typecheck:electron
npm run build
```

The built renderer is written to `dist/`; Electron main and preload bundles are written to `dist-electron/`.

## Release and local packaging

Create a platform package locally after installing dependencies:

```sh
npm run package:mac
npm run package:win
npm run package:linux
```

Each command runs the application build (including renderer and Electron typechecks) and writes signed-agnostic Electron artifacts to `release/`. The macOS DMG, Windows NSIS installer, and Linux AppImage/deb packages are not code-signed or notarized; users may need to approve the download in their operating system's security settings.

Pushes to `main` are handled by Release Please. Conventional Commits are collected into a release PR; merging that PR updates `package.json`, `package-lock.json`, and `CHANGELOG.md`, creates the matching `v<version>` tag and GitHub release, then packages the exact tagged source on macOS, Windows, and Linux. The workflow runs the test, renderer/Electron typechecks, and application build before packaging, uploads each platform's artifacts, and attaches them to that same release.

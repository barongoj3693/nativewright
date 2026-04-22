# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-04-22

Initial public release.

### Added — human-behavior layer (the differentiator vs. raw Patchright)
- `src/human.js` — primitives for realistic input synthesis. Zero new deps; runs on Patchright's existing `page.mouse.*` and `page.keyboard.*` only.
- Cubic Bézier mouse trajectories with perpendicular control-point offsets + per-sample Gaussian jitter. Three easing curves picked per move.
- Fitts-law movement durations (log-normal around `80 + 90·log2(d/w + 1)` ms).
- Overshoot-and-correct (~20% of long moves), mid-path hesitation (~12%), aspect-aware landing distribution inside the target's bbox.
- Keystroke cadence: per-character base mean, log-normal inter-key gaps, burstiness, post-space / post-punctuation pauses, occasional long mid-sentence pauses.
- Per-key `keydown`→`keyup` dwell times sampled independently.
- Typo simulation using a QWERTY-neighbour map; auto-disabled for password/OTP/CVV/PIN/secret/token fields.
- Real `page.mouse.wheel` scroll with variable tick magnitude, log-normal inter-tick gaps, "reading" pauses, and edge-detection via `window.scrollY` stall.
- Natural wheel-scroll-to-element before interacting with off-screen targets.
- Three-regime log-normal think-time between actions.
- Triple-click + Ctrl+A + Delete field-clearing (handles React-controlled inputs and contenteditables).
- Seeded mulberry32 PRNG via `--seed=<int>` for reproducible runs.
- `--raw=true` opt-out on every interaction command for cases where robotic precision is required.
- New commands: `dblclick`, `rightclick`.
- `src/human.sanity.js` — browser-less unit tests for the math (`npm run test:sanity`).

### Added — core daemon
- HTTP-RPC daemon that owns a single Patchright `BrowserContext`.
- **Strip `--no-sandbox` from Chrome args by default** on Windows / macOS / non-root Linux. Keeps it on root Linux (CI / Docker) where it's genuinely needed. Overridable via `NATIVEWRIGHT_ALLOW_NO_SANDBOX=1`. Motivation: Patchright's defaults include `--no-sandbox`, which (a) triggers Chrome's yellow warning bar, (b) is a bot-telltale for anti-bot systems, (c) disables renderer sandbox isolation.
- One-shot CLI client + interactive readline REPL, sharing the same entry point.
- Persistent profile under a platform-native data root (Windows `%LOCALAPPDATA%`, macOS `~/Library/Application Support`, Linux `~/.local/share` / XDG).
- Cross-platform Chrome / Chromium binary discovery with an `NATIVEWRIGHT_CHROME_PATH` override.
- `NATIVEWRIGHT_CHANNEL` env override (`chrome`, `chromium`, `msedge`, `chrome-beta`).
- `NATIVEWRIGHT_HEADLESS` env flag for CI smoke tests (breaks stealth — CI only).
- Lockfile at `$NATIVEWRIGHT_HOME/daemon.json` with PID + ephemeral port + recorded `scriptPath`.
- Stale-lockfile reaper on `start` (verifies PID aliveness + HTTP ping).
- Structured daemon log at `$NATIVEWRIGHT_HOME/logs/daemon.log` with per-command timing.
- In-page console hook that survives Patchright's `Runtime.enable` suppression; re-injected after every navigation.
- Auto-saved downloads via `page.on('download')` → `artifactsDir`.
- ANSI-stripped error messages for clean JSON output.
- Full command surface: pages, navigation, interaction, waiting, inspection, frames, dialogs, artifacts, diagnostics, viewport.
- Claude Code skills: `nativewright`, `nativewright-login-bootstrap`.
- GitHub Actions CI matrix: Windows, macOS, Ubuntu × Node 20.
- Integration smoke test (`npm test`): launch → goto example.com → text h1 → stop.
- JSDoc type annotations across all `src/*` modules.

[1.0.0]: https://github.com/lipski-lite/nativewright/releases/tag/v1.0.0

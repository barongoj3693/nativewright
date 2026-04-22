# Contributing to NativeWright

Thanks for your interest in improving NativeWright. A few ground rules before you open a PR.

## Scope

NativeWright is deliberately small: a daemon wrapper around Patchright with a CLI. Additions should serve that mission, not expand it. Good:

- New daemon commands that map cleanly onto existing Patchright APIs.
- Platform compatibility fixes.
- Better error messages and agent ergonomics.
- Tests.

Out of scope for this repo:

- Site-specific skills or flows (Gemini, GitHub, Stripe, etc.) — these belong in their own packages that depend on `nativewright`.
- New browser-automation libraries — Patchright is the dependency; forks belong elsewhere.
- Auto-login helpers that bypass stealth — goes against the project's design.

## Development setup

```bash
git clone https://github.com/lipski-lite/nativewright.git
cd nativewright
npm install
npx patchright install chromium
npm test
```

## Test requirements

All PRs must:

1. Keep the existing smoke test green on Windows, macOS, and Ubuntu (CI enforces).
2. Add a test for new commands / branches. We use Node's built-in `node:test` runner — no external framework.
3. Run cleanly under `NATIVEWRIGHT_HEADLESS=1 NATIVEWRIGHT_CHANNEL=chromium` (the CI configuration) AND under the default headed mode locally.

## Code style

- CommonJS (no ESM) to match Patchright's idiom and avoid toolchain noise.
- JSDoc type annotations for all exported functions.
- No external runtime dependencies beyond `patchright`. Node built-ins only.
- Small functions, small files. If a file is approaching 500 lines, split it.

## Commit and PR hygiene

- One concern per PR. Bundle only obviously related changes.
- Describe the problem you hit and how you fixed it, not just what changed.
- Reference the issue number if applicable.
- Update `CHANGELOG.md` under `## [Unreleased]` if your change is user-visible.

## Reporting bugs

Open an issue with:

- OS + Node version (`node --version`).
- Patchright version (`npm ls patchright`).
- Chrome / Chromium version if relevant.
- The exact command sequence that reproduces the problem.
- The tail of `$NATIVEWRIGHT_HOME/logs/daemon.log` around the failure.

## License

By contributing, you agree that your contributions will be licensed under Apache-2.0 (see `LICENSE`).

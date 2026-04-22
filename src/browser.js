#!/usr/bin/env node
'use strict';

/**
 * Entry point. Dispatches argv to the daemon or the CLI client.
 *
 * Modes:
 *   start                 launch persistent Chrome + HTTP RPC server (long-lived)
 *   stop                  tell the daemon to exit and clean up the lockfile
 *   status [--verbose]    print daemon state
 *   wait-ready [--timeout=N]  block until the daemon is listening
 *   repl                  interactive readline loop connected to the daemon
 *   <cmd> [args]          send a single command to the daemon and print JSON
 *
 * All commands exit non-zero on failure so Bash callers can detect
 * errors without parsing output.
 *
 * @module browser
 */

const path = require('path');
const SCRIPT_PATH = path.resolve(__filename);

async function main() {
  const [, , mode, ...rest] = process.argv;
  if (!mode || mode === 'help' || mode === '--help' || mode === '-h') {
    printHelp();
    return;
  }

  if (mode === 'start') {
    const { runDaemon } = require('./daemon');
    await runDaemon({ scriptPath: SCRIPT_PATH });
    return; // runDaemon never resolves (server stays up until shutdown)
  }

  const cli = require('./cli');

  if (mode === 'stop')       return cli.runStop();
  if (mode === 'status')     return cli.runStatus(parseFlags(rest));
  if (mode === 'wait-ready') return cli.runWaitReady(parseFlags(rest));
  if (mode === 'repl')       return cli.runRepl();

  // Everything else is treated as a one-shot command for the daemon.
  return cli.runOneShot(mode, rest);
}

/**
 * Parse `--flag` / `--key=value` tokens into an object.
 * @param {string[]} tokens
 * @returns {Object}
 */
function parseFlags(tokens) {
  const out = {};
  for (const t of tokens) {
    if (t.startsWith('--')) {
      const body = t.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) out[body.slice(0, eq)] = body.slice(eq + 1);
      else out[body] = true;
    }
  }
  return out;
}

function printHelp() {
  process.stdout.write(`
NativeWright — agent-drivable Patchright browser daemon

USAGE
  nativewright start                          launch persistent Chrome + RPC server
  nativewright stop                           shut down cleanly
  nativewright status [--verbose]             is it running?
  nativewright wait-ready [--timeout=N]       block until server listening
  nativewright repl                           interactive REPL
  nativewright <cmd> [args…] [--flag=val]     one-shot command

COMMON ONE-SHOT COMMANDS
  new                              open a new page
  goto <url>                       navigate (with human-behavior post-load idle)
  text [selector]                  inner text of element (or page body)
  click <selector>                 human mouse path + jitter + timing
  dblclick <selector>              double-click
  rightclick <selector>            right-click (context menu)
  fill <selector> <value>          human field-clear + typing with real cadence
  type <selector> <text>           human keystroke cadence with per-key dwell
  press <key>                      e.g. Enter, Control+A, ArrowDown
  hover <selector>                 human mouse path to element
  scroll <dir|px>                  real wheel ticks with edge-detection
  shot [name]                      screenshot → artifacts/
  save-artifact [name]             screenshot + html + metadata bundle
  state                            dump session snapshot
  help                             list all commands

HUMAN-BEHAVIOR LAYER
  All interaction commands use realistic human-like timing and trajectories
  by default. Add --raw=true for robotic Playwright behavior (faster, but
  trivially detectable by anti-bot systems).
    click .submit --raw=true
    fill "#user" alice --raw=true
  Pass --seed=<n> for reproducible randomness across runs.

ENVIRONMENT
  NATIVEWRIGHT_HOME             override per-user data root
  NATIVEWRIGHT_USER_DATA_DIR    override persistent profile path
  NATIVEWRIGHT_CHROME_PATH      override browser executable path
  NATIVEWRIGHT_ARTIFACTS_DIR    override screenshot output directory
  NATIVEWRIGHT_CHANNEL          'chrome' (default) | 'chromium' | 'msedge' | 'chrome-beta'
  NATIVEWRIGHT_HEADLESS         set to 1 to run without a visible window (CI only — breaks stealth)
  NATIVEWRIGHT_NO_EXEC_PATH     set to 1 to skip the local Chrome probe (lets Patchright resolve)
  NATIVEWRIGHT_ALLOW_NO_SANDBOX set to 1 to keep --no-sandbox (needed on root Linux / Docker; default: stripped)

See docs: https://github.com/lipski-lite/nativewright

`);
}

main().catch((e) => {
  process.stderr.write(`${e && e.message ? e.message : String(e)}\n`);
  process.exit(1);
});

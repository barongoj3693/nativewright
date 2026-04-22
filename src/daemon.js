'use strict';

/**
 * The long-running browser daemon. Owns a single Patchright
 * `BrowserContext`, maintains a registry of pages, wires per-page
 * event buffers, and exposes a tiny JSON-over-HTTP command surface
 * on `127.0.0.1:<ephemeral port>`.
 *
 * The daemon is intentionally single-process, single-context. Spawn
 * multiple daemons only if you also use distinct `NATIVEWRIGHT_HOME`
 * roots to avoid lockfile collisions.
 *
 * @module daemon
 */

const http = require('http');
const { chromium } = require('patchright');

const cfg = require('./config');
const { commands } = require('./commands');

// In-page hook that survives Patchright's stealth-driven suppression of
// `Runtime.enable` / `Console.enable`. Re-injected after every navigation.
const CONSOLE_INIT_SOURCE = `
  (() => {
    if (window.__nativewright_console__) return 'already';
    const buf = [];
    const push = (type, args) => {
      let text;
      try {
        text = Array.from(args).map((a) => {
          if (a instanceof Error) return a.stack || a.message;
          if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
          return String(a);
        }).join(' ');
      } catch (e) { text = '[unserializable]'; }
      buf.push({ at: new Date().toISOString(), type, text });
      if (buf.length > 500) buf.shift();
    };
    window.__nativewright_console__ = buf;
    for (const t of ['log','warn','error','info','debug']) {
      const orig = console[t].bind(console);
      console[t] = function () { push(t, arguments); return orig.apply(console, arguments); };
    }
    window.addEventListener('error', (e) => push('pageerror', [e.message || (e.error && e.error.message) || String(e)]));
    window.addEventListener('unhandledrejection', (e) => push('unhandledrejection', [e.reason && (e.reason.stack || e.reason.message) || String(e.reason)]));
    return 'installed';
  })();
`;

/**
 * @typedef {Object} PageRecord
 * @property {import('patchright').Page} page
 * @property {Array<{at:string,type:string,text:string}>} console
 * @property {Array<Object>} network
 * @property {Array<Object>} downloads
 */

/**
 * @typedef {Object} CommandLogEntry
 * @property {string} at   ISO timestamp
 * @property {string} cmd
 * @property {Object} args
 * @property {boolean} ok
 * @property {number} durMs
 * @property {string} [error]
 */

/**
 * In-memory session state shared across the HTTP handlers.
 * Not exported directly — constructed by {@link runDaemon}.
 * @returns {Object} session object with bound helpers
 */
function createSession() {
  /** @type {PageRecord[]} */
  const pages = [];
  let activeIndex = -1;
  let currentFrameRef = null;      // { type: 'name'|'index', value }
  let dialogPolicy = { action: 'dismiss', promptText: undefined };
  let _context = null;
  let _consoleInit = null;
  /** @type {CommandLogEntry[]} */
  const commandLog = [];
  const startedAt = new Date().toISOString();

  function adoptPage(page) {
    if (pages.some((r) => r.page === page)) return pages.findIndex((r) => r.page === page);
    const rec = { page, console: [], network: [], downloads: [] };
    pages.push(rec);
    wirePage(rec);
    ensureConsoleHook(page).catch(() => {});
    if (activeIndex < 0) activeIndex = pages.length - 1;
    return pages.length - 1;
  }

  async function ensureConsoleHook(page) {
    if (!_consoleInit) return;
    try { await page.evaluate(_consoleInit); } catch { /* page may not be ready */ }
  }

  function wirePage(rec) {
    const { page } = rec;
    // NOTE: page.on('console') and page.on('pageerror') do NOT fire under
    // Patchright (stealth suppresses CDP Runtime/Console domains). Console
    // messages are captured via the in-page hook re-injected after every
    // navigation — see ensureConsoleHook. Dialog / download / request /
    // response still work because they use different CDP domains.
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) ensureConsoleHook(page).catch(() => {});
    });
    page.on('dialog', async (dialog) => {
      try {
        if (dialogPolicy.action === 'accept') await dialog.accept(dialogPolicy.promptText || undefined);
        else await dialog.dismiss();
      } catch (e) { cfg.appendLog(`dialog handler error: ${e.message}`); }
    });
    page.on('download', async (dl) => {
      const entry = {
        at: new Date().toISOString(),
        url: dl.url(),
        suggested: dl.suggestedFilename(),
        path: null,
        error: null,
      };
      rec.downloads.push(entry);
      while (rec.downloads.length > 50) rec.downloads.shift();
      try {
        const path = require('path');
        const dir = cfg.artifactsDir();
        cfg.ensureDir(dir);
        const safe = (dl.suggestedFilename() || 'download').replace(/[^a-zA-Z0-9_.-]/g, '_');
        const target = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${safe}`);
        await dl.saveAs(target);
        entry.path = target;
        cfg.appendLog(`download saved ${target}`);
      } catch (e) {
        entry.error = e.message;
        cfg.appendLog(`download failed: ${e.message}`);
      }
    });
    page.on('request', (req) => {
      rec.network.push({
        at: new Date().toISOString(), dir: 'req',
        method: req.method(), url: req.url(), resourceType: req.resourceType(),
      });
      while (rec.network.length > 100) rec.network.shift();
    });
    page.on('response', (res) => {
      rec.network.push({
        at: new Date().toISOString(), dir: 'res',
        status: res.status(), url: res.url(),
      });
      while (rec.network.length > 100) rec.network.shift();
    });
    page.on('close', () => {
      const i = pages.indexOf(rec);
      if (i < 0) return;
      pages.splice(i, 1);
      if (activeIndex === i) activeIndex = pages.length ? 0 : -1;
      else if (activeIndex > i) activeIndex -= 1;
      if (activeIndex < 0) currentFrameRef = null;
    });
  }

  async function newPage() {
    if (!_context) throw new Error('context not ready');
    const page = await _context.newPage();
    adoptPage(page);
    activeIndex = pages.length - 1;
    return page;
  }

  function pageIndex(page)      { return pages.findIndex((r) => r.page === page); }
  function activePage()         { return activeIndex >= 0 ? pages[activeIndex].page : null; }
  function activeRec()          { return activeIndex >= 0 ? pages[activeIndex] : null; }
  function activeIdx()          { return activeIndex; }

  function setActivePage(i) {
    if (!Number.isInteger(i) || i < 0 || i >= pages.length) {
      throw new Error(`no page at index ${i} (have ${pages.length})`);
    }
    activeIndex = i;
    currentFrameRef = null;
  }

  function listPages() {
    return pages.map((r, i) => ({
      index: i, active: i === activeIndex, url: r.page.url(),
    }));
  }

  async function closeActivePage() {
    const rec = activeRec();
    if (!rec) throw new Error('no active page');
    await rec.page.close();
    return { closed: true };
  }

  function activeFrame() {
    const page = activePage();
    if (!page || !currentFrameRef) return null;
    if (currentFrameRef.type === 'name') {
      return page.frame({ name: currentFrameRef.value }) || null;
    }
    if (currentFrameRef.type === 'index') {
      const frames = page.frames();
      return frames[currentFrameRef.value] || null;
    }
    return null;
  }
  function setFrameByName(name)  { currentFrameRef = { type: 'name',  value: name  }; }
  function setFrameByIndex(idx)  { currentFrameRef = { type: 'index', value: idx   }; }
  function clearFrame()          { currentFrameRef = null; }

  function setDialogPolicy(p)    { dialogPolicy = { action: p.action, promptText: p.promptText }; }

  function consoleBuffer(n) {
    const rec = activeRec(); if (!rec) return [];
    return rec.console.slice(-n);
  }
  function appendConsole(entries) {
    const rec = activeRec(); if (!rec) return;
    for (const e of entries) rec.console.push(e);
    while (rec.console.length > 200) rec.console.shift();
  }
  function networkBuffer(n) {
    const rec = activeRec(); if (!rec) return [];
    return rec.network.slice(-n);
  }
  function downloadsBuffer(n) {
    const rec = activeRec(); if (!rec) return [];
    return rec.downloads.slice(-n);
  }

  function snapshot() {
    return {
      startedAt,
      activeIndex,
      pageCount: pages.length,
      pages: pages.map((r, i) => ({ index: i, url: r.page.url() })),
      frame: currentFrameRef,
      dialogPolicy,
      userDataDir: cfg.userDataDir(),
      artifactsDir: cfg.artifactsDir(),
      commandLog: commandLog.slice(-20),
    };
  }

  function logCommand(entry) {
    commandLog.push(entry);
    while (commandLog.length > 20) commandLog.shift();
  }

  return {
    context() { return _context; },
    setContext(c) { _context = c; },
    setConsoleInit(src) { _consoleInit = src; },
    ensureConsoleHook,
    adoptPage,
    newPage, pageIndex, activePage, activeIndex: activeIdx,
    setActivePage, listPages, closeActivePage,
    activeFrame, setFrameByName, setFrameByIndex, clearFrame,
    setDialogPolicy,
    consoleBuffer, appendConsole, networkBuffer, downloadsBuffer,
    snapshot, logCommand,
    pages: () => pages,
  };
}

// ---------- HTTP helpers --------------------------------------------------

/**
 * Strip ANSI escape sequences (Playwright error messages are decorated
 * with them; clients get cleaner JSON without).
 * @param {string} s
 * @returns {string}
 */
function stripAnsi(s) {
  return typeof s === 'string'
    ? s.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
    : s;
}

function jsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      if (!s) return resolve({});
      try { resolve(JSON.parse(s)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function send(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
  });
  res.end(body);
}

/**
 * Serialize command execution so the daemon never has two commands
 * touching the page state at the same moment.
 * @returns {(fn: () => Promise<any>) => Promise<any>}
 */
function makeQueue() {
  let chain = Promise.resolve();
  return function enqueue(fn) {
    const next = chain.then(() => fn(), () => fn());
    chain = next.catch(() => {});
    return next;
  };
}

// ---------- daemon entry --------------------------------------------------

/**
 * Boot the daemon. Never returns until the process is asked to shut down
 * via `POST /shutdown` or an OS signal.
 *
 * @param {{scriptPath: string}} opts
 * @returns {Promise<never>}
 */
async function runDaemon({ scriptPath }) {
  cfg.ensureDir(cfg.ROOT_DIR);
  cfg.ensureDir(cfg.LOG_DIR);
  cfg.ensureDir(cfg.userDataDir());

  // Preflight: reap stale lockfiles from crashed daemons.
  const existing = await cfg.readLockfile();
  if (existing) {
    const alive = await cfg.verifyLockfile(existing);
    if (alive) {
      process.stderr.write(
        `daemon already running: pid=${existing.pid} port=${existing.port}\n` +
        `use \`node "${scriptPath}" stop\` first.\n`
      );
      process.exit(0);
    }
    cfg.appendLog(`reaping stale lockfile pid=${existing.pid} port=${existing.port}`);
    await cfg.deleteLockfile();
  }

  const session = createSession();
  session.setConsoleInit(CONSOLE_INIT_SOURCE);

  // ---- launch browser ----------------------------------------------------
  cfg.appendLog(`daemon starting; userDataDir=${cfg.userDataDir()}`);
  const headless = envFlag('NATIVEWRIGHT_HEADLESS');
  const channel  = process.env.NATIVEWRIGHT_CHANNEL || 'chrome';

  /** @type {import('patchright').LaunchOptions} */
  const launchOpts = {
    channel,
    headless,
    viewport: null,
    acceptDownloads: true,
  };

  // Strip --no-sandbox from Patchright's default args unless we're in an
  // environment that genuinely needs it (root Linux / Docker, where the
  // kernel-level sandbox is unavailable and Chrome won't start without this
  // flag). Default-off matters because:
  //   1. Chrome shows a yellow warning bar in every window when it's set.
  //   2. It's a bot-telltale fingerprinted by anti-bot systems.
  //   3. It disables the renderer sandbox (security regression).
  const isRootLinux = process.platform === 'linux'
    && typeof process.getuid === 'function' && process.getuid() === 0;
  const keepNoSandbox = isRootLinux || envFlag('NATIVEWRIGHT_ALLOW_NO_SANDBOX');
  if (!keepNoSandbox) {
    launchOpts.ignoreDefaultArgs = ['--no-sandbox'];
  }

  // Only pass an explicit executablePath when the user didn't ask us to
  // skip discovery (useful on CI where we want to let Patchright resolve
  // the bundled chromium).
  if (!envFlag('NATIVEWRIGHT_NO_EXEC_PATH')) {
    const exe = cfg.chromeExecutable();
    if (exe) launchOpts.executablePath = exe;
  }

  let context;
  try {
    context = await chromium.launchPersistentContext(cfg.userDataDir(), launchOpts);
  } catch (e) {
    cfg.appendLog(`launchPersistentContext failed: ${e.message}`);
    process.stderr.write(`failed to launch browser: ${e.message}\n`);
    process.exit(2);
  }
  session.setContext(context);

  for (const page of context.pages()) session.adoptPage(page);
  context.on('page', (page) => session.adoptPage(page));

  // ---- http server -------------------------------------------------------

  const enqueue = makeQueue();

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/ping') return send(res, 200, { ok: true, pong: true });
      if (req.method === 'POST' && req.url === '/shutdown') {
        send(res, 200, { ok: true });
        setTimeout(() => shutdown(0), 20);
        return;
      }
      if (req.method === 'POST' && req.url === '/cmd') {
        const body = await jsonBody(req);
        const cmd = body && body.cmd;
        const args = (body && body.args) || {};
        const handler = commands[cmd];
        if (!handler) return send(res, 400, { ok: false, error: `unknown command: ${cmd}` });
        const startedMs = Date.now();
        try {
          const result = await enqueue(() => handler(session, args));
          const durMs = Date.now() - startedMs;
          session.logCommand({ at: new Date().toISOString(), cmd, args, ok: true, durMs });
          cfg.appendLog(`${cmd} ok ${durMs}ms`);
          return send(res, 200, { ok: true, result });
        } catch (e) {
          const durMs = Date.now() - startedMs;
          const cleanMsg = stripAnsi(e.message || String(e));
          session.logCommand({ at: new Date().toISOString(), cmd, args, ok: false, durMs, error: cleanMsg });
          cfg.appendLog(`${cmd} ERR ${durMs}ms ${cleanMsg}`);
          return send(res, 200, { ok: false, error: cleanMsg, stack: stripAnsi(e.stack || '') });
        }
      }
      return send(res, 404, { ok: false, error: `no route for ${req.method} ${req.url}` });
    } catch (e) {
      return send(res, 500, { ok: false, error: e.message, stack: e.stack });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;

  await cfg.writeLockfile({
    pid: process.pid,
    port,
    userDataDir: cfg.userDataDir(),
    startedAt: new Date().toISOString(),
    scriptPath,
    node: process.version,
  });
  await cfg.writeInstallFile(scriptPath);
  cfg.appendLog(`daemon listening pid=${process.pid} port=${port} channel=${channel} headless=${headless}`);
  process.stdout.write(
    `nativewright daemon ready pid=${process.pid} port=${port} ` +
    `userDataDir="${cfg.userDataDir()}"\n`
  );

  // ---- shutdown hooks ----------------------------------------------------

  let shuttingDown = false;
  async function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    cfg.appendLog(`shutdown code=${code}`);
    try { server.close(); } catch {}
    try { await context.close(); } catch (e) { cfg.appendLog(`context close error: ${e.message}`); }
    try { await cfg.deleteLockfile(); } catch {}
    process.exit(code);
  }

  process.on('SIGINT',  () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  if (process.platform === 'win32') process.on('SIGBREAK', () => shutdown(0));
  process.on('uncaughtException',  (e) => { cfg.appendLog(`uncaught: ${e.stack || e.message}`); });
  process.on('unhandledRejection', (e) => { cfg.appendLog(`unhandled: ${e && (e.stack || e.message) || e}`); });
  context.on('close', () => {
    cfg.appendLog('context closed by browser — shutting down');
    shutdown(0);
  });
}

/**
 * Parse a boolean-ish env var (`"1"`, `"true"`, `"yes"` → true).
 * @param {string} name
 * @returns {boolean}
 */
function envFlag(name) {
  const v = process.env[name];
  if (v == null) return false;
  return /^(1|true|yes|on)$/i.test(v);
}

module.exports = { runDaemon };

'use strict';

// Human-behavior primitives used by the daemon to make every mouse / keyboard
// action look like a real person. Applied by default to click/type/hover/fill/
// scroll/press — callers opt out with raw:true when they truly need robotic
// precision (e.g. invisible elements, programmatic fills).
//
// Design:
//  - All randomness flows through a single PRNG (Math.random by default; a
//    seeded mulberry32 if a seed is provided). This means nothing in here
//    reaches for `Math.random` directly — pass `rng()` everywhere.
//  - All timing distributions are log-normal, not uniform. Real human
//    key-press intervals and think-times are heavy-tailed.
//  - Mouse paths are cubic Bézier with perpendicular control-point offsets
//    plus per-sample Gaussian jitter. Time along the path follows an
//    ease-in-out curve (slow start, fast middle, slow arrival).
//  - Never moves to the dead center of a bbox. Lands somewhere inside with
//    a truncated Gaussian around the center.

// --------------------------------------------------------------------------
// RNG
// --------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  if (seed == null) return Math.random;
  const n = Number(seed);
  if (!Number.isFinite(n)) return Math.random;
  return mulberry32(Math.trunc(n));
}

// Standard Normal via Box–Muller (rejecting the 0-case).
function gaussian(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Log-normal sample with a clamp to avoid absurd tails on UI actions.
function logNormal(rng, meanMs, sigma = 0.35, minMs = 10, maxMs = 5000) {
  const mu = Math.log(meanMs);
  const x = Math.exp(mu + sigma * gaussian(rng));
  return Math.max(minMs, Math.min(maxMs, x));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, Math.round(ms))));
}

// --------------------------------------------------------------------------
// Geometry
// --------------------------------------------------------------------------

function dist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// Cubic Bézier point at t ∈ [0,1].
function bezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const uu = u * u, uuu = uu * u;
  const tt = t * t, ttt = tt * t;
  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
  };
}

// Build control points perpendicular to the direct line from→to, offset
// proportional to distance with Gaussian noise. This gives the mouse a
// natural curve instead of a straight line.
function buildControlPoints(from, to, rng) {
  const d = dist(from, to);
  if (d < 1) return { p1: from, p2: to };

  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;

  const dx = to.x - from.x, dy = to.y - from.y;
  // unit perpendicular vector
  const nx = -dy / d, ny = dx / d;

  // two control points at ~1/3 and ~2/3 of the line, pushed off-axis
  const offsetA = (gaussian(rng) * 0.15 + (rng() - 0.5) * 0.25) * d;
  const offsetB = (gaussian(rng) * 0.15 + (rng() - 0.5) * 0.25) * d;

  const p1 = {
    x: from.x + dx / 3 + nx * offsetA + (rng() - 0.5) * 6,
    y: from.y + dy / 3 + ny * offsetA + (rng() - 0.5) * 6,
  };
  const p2 = {
    x: from.x + (2 * dx) / 3 + nx * offsetB + (rng() - 0.5) * 6,
    y: from.y + (2 * dy) / 3 + ny * offsetB + (rng() - 0.5) * 6,
  };
  return { p1, p2 };
}

// Family of easing functions. Real human pointing uses different speed
// profiles depending on confidence and distance: ease-in-out for deliberate
// moves, asymmetric ease-out for short flicks, near-linear for "dragged"
// mouse paths. We pick one per call so a detector can't fingerprint a
// single velocity profile.
function easeInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function easeOut(t) { return 1 - Math.pow(1 - t, 2.5); }
function easeLinearish(t) {
  // near-linear with a mild S bend — sampled closer to a constant-velocity move
  return 0.85 * t + 0.15 * (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
}
function pickEasing(rng) {
  const r = rng();
  if (r < 0.55) return easeInOut;
  if (r < 0.85) return easeOut;
  return easeLinearish;
}

// Sample the Bézier path into N steps with a randomly-chosen easing plus
// jitter. Occasionally inserts a mid-path "hesitation" where the mouse
// briefly slows and wobbles — real users do this when the target is
// non-obvious or the cursor is on the wrong line.
function samplePath(from, to, rng, opts = {}) {
  const d = dist(from, to);
  const steps = Math.max(8, Math.min(80, Math.round(d / 14 + 6)));
  const { p1, p2 } = buildControlPoints(from, to, rng);
  const easing = opts.easing || pickEasing(rng);

  // 12% chance of a mid-path hesitation (only for moves > 80px)
  const hesitate = d > 80 && rng() < 0.12
    ? { atT: 0.35 + rng() * 0.3, extraSamples: 3 + Math.floor(rng() * 4) }
    : null;

  const path = [];
  for (let i = 1; i <= steps; i++) {
    const tLinear = i / steps;
    const t = easing(tLinear);
    const pt = bezier(from, p1, p2, to, t);
    const jitter = 1.2 * (1 - tLinear) + 0.2;
    pt.x += gaussian(rng) * jitter;
    pt.y += gaussian(rng) * jitter;
    pt.pauseMs = 0;
    path.push(pt);

    if (hesitate && tLinear >= hesitate.atT && !hesitate.done) {
      hesitate.done = true;
      // append a few near-stationary jitter samples before resuming
      for (let j = 0; j < hesitate.extraSamples; j++) {
        const last = path[path.length - 1];
        path.push({
          x: last.x + gaussian(rng) * 1.5,
          y: last.y + gaussian(rng) * 1.5,
          pauseMs: 40 + rng() * 90,
        });
      }
    }
  }
  path[path.length - 1] = { x: to.x, y: to.y, pauseMs: 0 };
  return { path, steps };
}

// Fitts-like total duration for a move of distance `d` to a target of
// effective width `w`. Real human pointing is ~150ms for easy targets and
// grows log-linearly with d/w. Tuned to feel natural at 1080p.
function moveDurationMs(d, w, rng) {
  const a = 80, b = 90;
  const width = Math.max(8, w || 20);
  const idx = Math.log2(d / width + 1);
  const mean = a + b * idx;
  return logNormal(rng, mean, 0.22, 40, 1400);
}

// --------------------------------------------------------------------------
// Mouse primitives — operate on a Playwright Page
// --------------------------------------------------------------------------

// Track the mouse's logical position because Playwright's mouse object is
// stateless between moves. The first move of a daemon lifetime starts from
// a random on-screen point (not 0,0, which is bot-telltale).
const MOUSE_POS = new WeakMap();

function getPos(page, rng) {
  let p = MOUSE_POS.get(page);
  if (p) return p;
  const vp = page.viewportSize() || { width: 1280, height: 800 };
  p = {
    x: Math.round(vp.width * (0.2 + 0.6 * rng())),
    y: Math.round(vp.height * (0.2 + 0.6 * rng())),
  };
  MOUSE_POS.set(page, p);
  return p;
}

function setPos(page, p) {
  MOUSE_POS.set(page, { x: p.x, y: p.y });
}

// Move the mouse along a natural path to (x,y). `targetW` is the effective
// size of the target (used for Fitts timing); pass the bbox width when
// moving toward an element.
async function moveTo(page, x, y, opts = {}) {
  const rng = opts.rng || Math.random;
  const from = getPos(page, rng);
  const to = { x, y };
  const d = dist(from, to);

  // Even when already at (or near) target, emit a small idle jitter so
  // repeat-clicks don't produce an empty-move signature. Cheap and cheap
  // to skip in raw mode (callers don't call moveTo there).
  if (d < 2) {
    const j = 1 + rng() * 3;
    const ang = rng() * Math.PI * 2;
    const jitterTo = { x: from.x + Math.cos(ang) * j, y: from.y + Math.sin(ang) * j };
    await page.mouse.move(jitterTo.x, jitterTo.y, { steps: 1 });
    await sleep(20 + rng() * 40);
    await page.mouse.move(to.x, to.y, { steps: 1 });
    setPos(page, to);
    return;
  }

  const durationMs = moveDurationMs(d, opts.targetW || 20, rng);

  // Optional overshoot: for longer moves, ~20% chance to overshoot the
  // target slightly then correct back. Never overshoot tiny targets.
  const doOvershoot = d > 120 && opts.targetW > 12 && rng() < 0.2;
  let primaryTarget = to;
  let overshootPoint = null;
  if (doOvershoot) {
    const overshootMag = 6 + rng() * 18;
    const dx = (to.x - from.x) / d, dy = (to.y - from.y) / d;
    overshootPoint = {
      x: to.x + dx * overshootMag + (rng() - 0.5) * 4,
      y: to.y + dy * overshootMag + (rng() - 0.5) * 4,
    };
    primaryTarget = overshootPoint;
  }

  const { path, steps } = samplePath(from, primaryTarget, rng);
  const perStep = durationMs / steps;

  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    await page.mouse.move(p.x, p.y, { steps: 1 });
    const jitter = 1 + (rng() - 0.5) * 0.5;
    // hesitation samples carry their own extra pause; others use perStep
    await sleep((p.pauseMs || 0) + perStep * jitter);
  }

  if (overshootPoint) {
    setPos(page, overshootPoint);
    const { path: corr } = samplePath(overshootPoint, to, rng, { easing: easeOut });
    const corrDur = logNormal(rng, 90, 0.25, 60, 220);
    const corrStep = corrDur / corr.length;
    for (const p of corr) {
      await page.mouse.move(p.x, p.y, { steps: 1 });
      await sleep((p.pauseMs || 0) + corrStep);
    }
  }
  setPos(page, to);
}

async function clickAt(page, x, y, opts = {}) {
  const rng = opts.rng || Math.random;
  await moveTo(page, x, y, opts);
  // tiny settle pause before button press — humans don't click the instant
  // the cursor stops
  await sleep(logNormal(rng, 55, 0.3, 20, 180));
  await page.mouse.down({ button: opts.button || 'left' });
  // dwell time mousedown→mouseup
  await sleep(logNormal(rng, 70, 0.3, 30, 180));
  await page.mouse.up({ button: opts.button || 'left' });
}

// Pick a point inside the bbox. For roughly-square targets we use a
// Gaussian around the center. For wide elements (buttons, nav links with
// text), we widen the X distribution so clicks land across the element
// proportionally — approximating where the visible label text is rather
// than always dead-center.
function pointInBox(box, rng) {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Aspect-aware σ: for wide elements use closer-to-uniform along the long
  // axis (σ scales up). For ~square elements stay Gaussian.
  const aspect = box.width / Math.max(1, box.height);
  const sigmaXFrac = Math.min(0.45, 0.2 + Math.max(0, Math.log2(aspect)) * 0.08);
  const sigmaYFrac = 0.22;

  const sx = box.width * sigmaXFrac;
  const sy = box.height * sigmaYFrac;
  let x = cx + gaussian(rng) * sx;
  let y = cy + gaussian(rng) * sy;
  // keep a small margin from the edges (bigger margin on tall elements)
  const mx = Math.min(6, Math.max(2, box.width * 0.04));
  const my = Math.min(6, Math.max(2, box.height * 0.1));
  x = Math.min(box.x + box.width - mx, Math.max(box.x + mx, x));
  y = Math.min(box.y + box.height - my, Math.max(box.y + my, y));
  return { x, y };
}

// --------------------------------------------------------------------------
// High-level operations on a Locator
// --------------------------------------------------------------------------

async function resolveBox(locator, timeoutMs, opts = {}) {
  const page = opts.page;
  const rng  = opts.rng || Math.random;
  await locator.waitFor({ state: 'visible', timeout: timeoutMs });

  // If we have a page handle and the element is off-screen, scroll via real
  // wheel events toward it. Fall back to scrollIntoViewIfNeeded after the
  // wheel pass closes most of the distance.
  if (page) {
    try {
      let box = await locator.boundingBox({ timeout: timeoutMs });
      if (box) {
        const vp = page.viewportSize() || { width: 1280, height: 800 };
        const topMargin = 80;        // leave the sticky header area alone
        const bottomMargin = vp.height - 80;
        let tries = 0;
        while (tries++ < 6) {
          box = await locator.boundingBox({ timeout: timeoutMs });
          if (!box) break;
          const elTop = box.y;
          const elBot = box.y + box.height;
          if (elTop >= topMargin && elBot <= bottomMargin) break;
          // decide how much to wheel
          let wheelDelta;
          if (elTop < topMargin)      wheelDelta = Math.round(elTop - (topMargin + 40) - rng() * 50);
          else                        wheelDelta = Math.round(elBot - (bottomMargin - 40) + rng() * 50);
          await humanScroll(page, wheelDelta, { rng });
        }
      }
    } catch { /* fall through to scrollIntoViewIfNeeded */ }
  }

  await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs });
  const box = await locator.boundingBox({ timeout: timeoutMs });
  if (!box) throw new Error('element has no bounding box (detached or 0-size)');
  return box;
}

async function humanClick(page, locator, opts = {}) {
  const rng = opts.rng || Math.random;
  const timeout = opts.timeout || 30000;
  const button = opts.button || 'left';
  const clickCount = opts.clickCount || 1;
  const t0 = Date.now();
  const box = await resolveBox(locator, timeout, { page, rng });
  const target = pointInBox(box, rng);
  const tMoveStart = Date.now();
  await moveTo(page, target.x, target.y, {
    rng, targetW: Math.min(box.width, box.height),
  });
  await sleep(logNormal(rng, 55, 0.3, 20, 180));
  for (let i = 0; i < clickCount; i++) {
    await page.mouse.down({ button });
    await sleep(logNormal(rng, 70, 0.3, 30, 180));
    await page.mouse.up({ button });
    if (i + 1 < clickCount) {
      await sleep(logNormal(rng, 110, 0.25, 60, 220));
    }
  }
  return {
    landedAt: { x: Math.round(target.x), y: Math.round(target.y) },
    targetBox: {
      x: Math.round(box.x), y: Math.round(box.y),
      width: Math.round(box.width), height: Math.round(box.height),
    },
    moveMs: Date.now() - tMoveStart,
    totalMs: Date.now() - t0,
  };
}

async function humanHover(page, locator, opts = {}) {
  const rng = opts.rng || Math.random;
  const timeout = opts.timeout || 30000;
  const box = await resolveBox(locator, timeout, { page, rng });
  const target = pointInBox(box, rng);
  await moveTo(page, target.x, target.y, {
    rng,
    targetW: Math.min(box.width, box.height),
  });
}

// --------------------------------------------------------------------------
// Keyboard
// --------------------------------------------------------------------------

// Map a character to a reasonable per-keystroke base mean (ms). Letters are
// fast, digits and symbols slightly slower, shifted chars slower still.
function charBaseMs(ch) {
  if (ch === ' ') return 140;                     // spaces a bit slower
  if (/[.,!?;:]/.test(ch)) return 170;            // punctuation slower
  if (/[0-9]/.test(ch)) return 130;
  if (/[A-Z]/.test(ch)) return 150;               // Shift hold
  if (/[a-z]/.test(ch)) return 95;
  return 140;                                      // symbols and other
}

// Adjacent-key typo map for QWERTY — what a real finger might hit instead
// of the intended key. Only lowercase; uppercase maps inherited via Shift
// at typing time.
const NEIGHBOR_KEY = {
  q: 'wa', w: 'qeas', e: 'wrsd', r: 'etdf', t: 'rygf',
  y: 'tuhg', u: 'yijh', i: 'uojk', o: 'ipkl', p: 'ol',
  a: 'qwsz', s: 'awedxz', d: 'serfcx', f: 'drtgvc', g: 'ftyhbv',
  h: 'gyujnb', j: 'huiknm', k: 'jiolm', l: 'kop', z: 'asx',
  x: 'zsdc', c: 'xdfv', v: 'cfgb', b: 'vghn', n: 'bhjm', m: 'njk',
  ' ': 'bnvcxm',
};

function pickTypo(ch, rng) {
  const lower = ch.toLowerCase();
  const nbrs = NEIGHBOR_KEY[lower];
  if (!nbrs) return null;
  const wrong = nbrs[Math.floor(rng() * nbrs.length)];
  return ch === ch.toUpperCase() && ch !== lower ? wrong.toUpperCase() : wrong;
}

// Type a string one char at a time with realistic inter-key gaps, per-key
// dwell, burstiness, and optional typo-then-correct patterns. `opts.typos`:
//   'off'  — never insert typos (use for passwords, credentials)
//   'on'   — ~0.8% per char
//   'auto' — default; detects password fields and disables typos for them
async function humanType(page, text, opts = {}) {
  const rng = opts.rng || Math.random;
  const typosMode = opts.typos || 'auto';
  let typosEnabled = typosMode === 'on';
  if (typosMode === 'auto') {
    // cheap heuristic: check the currently-focused element's type. If it
    // looks like a password/code/OTP field, disable typos.
    try {
      const looksSensitive = await page.evaluate(() => {
        const a = document.activeElement;
        if (!a) return false;
        const t = (a.getAttribute && a.getAttribute('type') || '').toLowerCase();
        const n = (a.getAttribute && a.getAttribute('name') || '').toLowerCase();
        const id = (a.id || '').toLowerCase();
        const ac = (a.getAttribute && a.getAttribute('autocomplete') || '').toLowerCase();
        return t === 'password' || /pass|pwd|otp|code|cvv|pin|secret|token/.test(n + ' ' + id + ' ' + ac);
      });
      typosEnabled = !looksSensitive;
    } catch { typosEnabled = false; }
  }

  let prev = '';
  let burst = 1.0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const base = charBaseMs(ch);

    if (/[a-z]/.test(ch)) burst = Math.max(0.65, burst * (rng() < 0.3 ? 0.9 : 1.0));
    else burst = Math.min(1.15, burst + 0.05);

    let delay = logNormal(rng, base * burst, 0.35, 30, 500);
    if (prev === ' ' && ch !== ' ') delay += logNormal(rng, 80, 0.4, 20, 300);
    if (/[.,;:!?]/.test(prev)) delay += logNormal(rng, 120, 0.4, 30, 450);
    if (i > 1 && rng() < 0.015) delay += logNormal(rng, 650, 0.5, 200, 2200);

    await sleep(delay);

    // typo insertion: press wrong neighbor, small pause noticing, Backspace, then correct
    const wrong = typosEnabled && i > 0 && rng() < 0.008 ? pickTypo(ch, rng) : null;
    if (wrong) {
      const holdW = logNormal(rng, 55, 0.3, 20, 130);
      await page.keyboard.press(wrong, { delay: Math.round(holdW) });
      await sleep(logNormal(rng, 220, 0.4, 90, 700));   // "noticing" pause
      const holdB = logNormal(rng, 45, 0.3, 20, 110);
      await page.keyboard.press('Backspace', { delay: Math.round(holdB) });
      await sleep(logNormal(rng, 140, 0.3, 60, 400));
    }

    const holdMs = logNormal(rng, 55, 0.3, 20, 130);
    await page.keyboard.press(ch, { delay: Math.round(holdMs) });
    prev = ch;
  }
}

// --------------------------------------------------------------------------
// Scroll
// --------------------------------------------------------------------------

// Roll the wheel in a series of discrete ticks with variable delta and gaps.
// Net scroll total ≈ totalPx, sign indicates direction. Stops early when the
// page can no longer scroll (avoids infinite wheeling on short pages).
async function humanScroll(page, totalPx, opts = {}) {
  const rng = opts.rng || Math.random;
  const sign = totalPx >= 0 ? 1 : -1;
  const remaining = { v: Math.abs(totalPx) };
  const maxTicks = 400; // hard safety ceiling

  let lastY = await page.evaluate(() => window.scrollY).catch(() => null);
  let stuckTicks = 0;

  for (let i = 0; i < maxTicks && remaining.v > 0; i++) {
    let tick = Math.round(60 + rng() * 120);
    if (rng() < 0.08) tick = Math.round(180 + rng() * 160);
    tick = Math.min(tick, remaining.v);
    await page.mouse.wheel(0, sign * tick);
    remaining.v -= tick;

    // inter-tick gap: log-normal around 70ms, occasional longer "reading" pause
    let gap = logNormal(rng, 75, 0.4, 25, 250);
    if (rng() < 0.05) gap += logNormal(rng, 500, 0.5, 200, 1500);
    await sleep(gap);

    // Detect "stuck at edge": if window.scrollY didn't change after 2
    // consecutive ticks, stop. Falls back silently if scrollY read fails
    // (e.g. cross-origin, or page navigating).
    try {
      const y = await page.evaluate(() => window.scrollY);
      if (lastY != null && Math.abs(y - lastY) < 1) {
        stuckTicks += 1;
        if (stuckTicks >= 2) break;
      } else {
        stuckTicks = 0;
      }
      lastY = y;
    } catch { /* keep going */ }
  }
}

// --------------------------------------------------------------------------
// Think-time (between discrete agent actions)
// --------------------------------------------------------------------------

// Think-time is deliberately heterogeneous: most actions have a short
// hand-off pause, some have a medium reading pause, occasional longer pauses
// simulate context-switch. Mixing three regimes prevents a detector from
// fitting a single log-normal to action spacing.
function thinkMs(opts = {}) {
  const rng = opts.rng || Math.random;
  const scale = opts.mean ? opts.mean / 450 : 1;
  const r = rng();
  if (r < 0.15) return 0;                                     // 15% skip
  if (r < 0.75) return logNormal(rng, 320 * scale, 0.35, 80, 900);   // short
  if (r < 0.95) return logNormal(rng, 750 * scale, 0.4, 300, 1800);  // medium
  return logNormal(rng, 1800 * scale, 0.45, 700, 4500);              // longer
}

async function think(opts = {}) {
  const ms = thinkMs(opts);
  if (ms > 0) await sleep(ms);
}

// "clear this text field the way a human would" — triple-click selects the
// whole line/paragraph in Chrome for inputs and most contenteditables, which
// is what users do when replacing a value. Falls back to Ctrl+A for edge
// cases where triple-click's selection didn't cover everything.
async function humanClearField(page, locator, opts = {}) {
  const rng = opts.rng || Math.random;
  const timeout = opts.timeout || 30000;
  const box = await resolveBox(locator, timeout, { page, rng });
  const target = pointInBox(box, rng);
  await moveTo(page, target.x, target.y, {
    rng, targetW: Math.min(box.width, box.height),
  });
  await sleep(logNormal(rng, 50, 0.3, 20, 150));
  // triple-click to select all
  await page.mouse.down(); await sleep(logNormal(rng, 40, 0.25, 15, 100));
  await page.mouse.up();   await sleep(logNormal(rng, 70, 0.25, 30, 150));
  await page.mouse.down(); await sleep(logNormal(rng, 40, 0.25, 15, 100));
  await page.mouse.up();   await sleep(logNormal(rng, 70, 0.25, 30, 150));
  await page.mouse.down(); await sleep(logNormal(rng, 40, 0.25, 15, 100));
  await page.mouse.up();
  await sleep(logNormal(rng, 80, 0.3, 30, 180));
  // belt-and-braces: Ctrl+A covers cases where triple-click didn't cover all
  // (multi-line textarea, some React-controlled fields)
  await page.keyboard.press('Control+A', { delay: Math.round(logNormal(rng, 50, 0.2, 25, 100)) });
  await sleep(logNormal(rng, 70, 0.3, 25, 180));
  await page.keyboard.press('Delete', { delay: Math.round(logNormal(rng, 55, 0.25, 25, 120)) });
}

// --------------------------------------------------------------------------

module.exports = {
  makeRng,
  gaussian, logNormal, sleep,
  bezier, buildControlPoints, samplePath, easeInOut, easeOut, easeLinearish,
  moveDurationMs,
  getPos, setPos, moveTo, clickAt,
  pointInBox, resolveBox,
  humanClick, humanHover, humanType, humanScroll, humanClearField,
  think, thinkMs, charBaseMs,
};

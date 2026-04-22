'use strict';

// Minimal sanity checks for src/human.js. Run: `node src/human.sanity.js`.
// Verifies the math matches human-realistic distributions. No browser needed.

const h = require('./human');

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('ok  ', msg);
}

function stats(arr) {
  const n = arr.length;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const v = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const sd = Math.sqrt(v);
  const sorted = [...arr].sort((a, b) => a - b);
  return {
    n, mean, sd,
    min: sorted[0], max: sorted[n - 1],
    p50: sorted[Math.floor(n * 0.5)],
    p95: sorted[Math.floor(n * 0.95)],
    p99: sorted[Math.floor(n * 0.99)],
  };
}

// ---- 1) RNG reproducibility --------------------------------------------
{
  const a = h.makeRng(12345);
  const b = h.makeRng(12345);
  const vA = []; const vB = [];
  for (let i = 0; i < 100; i++) { vA.push(a()); vB.push(b()); }
  assert(vA.every((x, i) => x === vB[i]), 'seeded RNG is reproducible');

  const c = h.makeRng(12346);
  const vC = []; for (let i = 0; i < 100; i++) vC.push(c());
  assert(vA.some((x, i) => x !== vC[i]), 'different seed → different sequence');
}

// ---- 2) Gaussian distribution ------------------------------------------
{
  const rng = h.makeRng(1);
  const xs = [];
  for (let i = 0; i < 20000; i++) xs.push(h.gaussian(rng));
  const s = stats(xs);
  assert(Math.abs(s.mean) < 0.05, `gaussian mean ≈ 0 (got ${s.mean.toFixed(3)})`);
  assert(Math.abs(s.sd - 1) < 0.05, `gaussian sd ≈ 1 (got ${s.sd.toFixed(3)})`);
}

// ---- 3) Log-normal timing ---------------------------------------------
{
  const rng = h.makeRng(2);
  const xs = [];
  for (let i = 0; i < 20000; i++) xs.push(h.logNormal(rng, 110, 0.35, 10, 2000));
  const s = stats(xs);
  // median of log-normal = exp(mu) = meanMs; mean is slightly higher
  assert(s.p50 > 90 && s.p50 < 135, `log-normal median near 110 (got ${s.p50.toFixed(0)})`);
  assert(s.p95 > 170 && s.p95 < 230, `log-normal p95 realistic (got ${s.p95.toFixed(0)})`);
  assert(s.min >= 10, 'log-normal respects min clamp');
  assert(s.max <= 2000, 'log-normal respects max clamp');
}

// ---- 4) Path generation -----------------------------------------------
{
  const rng = h.makeRng(3);
  const from = { x: 100, y: 100 };
  const to = { x: 700, y: 400 };
  const { path, steps } = h.samplePath(from, to, rng);
  assert(steps >= 8, 'path has ≥ 8 steps');
  // hesitation samples may append a few extra points
  assert(path.length >= steps, 'path length ≥ step count (hesitation may append)');
  assert(path.length < steps + 10, 'hesitation does not explode path length');

  const last = path[path.length - 1];
  assert(last.x === to.x && last.y === to.y, 'final path point equals target');

  // total path length should exceed direct distance (it's curved + jittered)
  let total = 0;
  let prev = from;
  for (const p of path) { total += Math.hypot(p.x - prev.x, p.y - prev.y); prev = p; }
  const direct = Math.hypot(to.x - from.x, to.y - from.y);
  assert(total > direct, `curved path (${total.toFixed(0)}) longer than direct (${direct.toFixed(0)})`);
  assert(total < direct * 2, 'path not absurdly long');
}

// ---- 5) pointInBox never dead-center, always inside --------------------
{
  const rng = h.makeRng(4);
  const box = { x: 100, y: 100, width: 200, height: 40 };
  let centerHits = 0, inside = 0;
  const N = 5000;
  for (let i = 0; i < N; i++) {
    const p = h.pointInBox(box, rng);
    if (p.x > box.x && p.x < box.x + box.width &&
        p.y > box.y && p.y < box.y + box.height) inside += 1;
    if (Math.abs(p.x - (box.x + box.width / 2)) < 0.5 &&
        Math.abs(p.y - (box.y + box.height / 2)) < 0.5) centerHits += 1;
  }
  assert(inside === N, `all ${N} samples inside box`);
  assert(centerHits < 50, `rarely lands exactly at center (got ${centerHits}/${N})`);
}

// ---- 6) charBaseMs sanity ---------------------------------------------
{
  assert(h.charBaseMs('a') < h.charBaseMs('A'), 'uppercase slower than lowercase');
  assert(h.charBaseMs('a') < h.charBaseMs(' '), 'space slower than letter');
  assert(h.charBaseMs(',') > h.charBaseMs('a'), 'punctuation slower than letter');
}

// ---- 7) moveDurationMs grows with distance, shrinks with target size ---
{
  const rng = h.makeRng(5);
  // average over many samples to beat log-normal noise
  function avg(d, w) {
    let s = 0; const n = 500;
    for (let i = 0; i < n; i++) s += h.moveDurationMs(d, w, rng);
    return s / n;
  }
  const near = avg(50, 50);
  const far  = avg(800, 50);
  assert(far > near * 1.3, `far move takes longer than near (${near.toFixed(0)} vs ${far.toFixed(0)})`);
  const bigTarget   = avg(400, 100);
  const smallTarget = avg(400, 10);
  assert(smallTarget > bigTarget, `small target takes longer than big (${bigTarget.toFixed(0)} vs ${smallTarget.toFixed(0)})`);
}

console.log('\nALL SANITY CHECKS PASSED');

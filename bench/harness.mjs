import { performance } from 'node:perf_hooks';
import { appendFileSync } from 'node:fs';

// Keeps results observable so the engine cannot throw the work away.
let sink = 0;
export const keep = value => {
  sink = (sink + (value && value.length !== undefined ? value.length : typeof value === 'number' ? value | 0 : 1)) | 0;
  return value;
};
export const sinkValue = () => sink;

export function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/**
 * Warm up, pick an iteration count so one sample lasts >= minSampleMs, then take
 * `samples` samples and report the median (robust to the occasional GC pause or throttle blip).
 * `spread` is p90/median: near 1 is stable, well above 1 means a noisy case.
 */
export function measure(fn, { samples = 15, minSampleMs = 40, warmupMs = 200 } = {}) {
  const start = performance.now();
  let warm = 0;
  while (performance.now() - start < warmupMs || warm < 3) {
    keep(fn());
    warm++;
  }
  let iters = 1;
  for (;;) {
    const s = performance.now();
    for (let i = 0; i < iters; i++) keep(fn());
    const took = performance.now() - s;
    if (took >= minSampleMs || iters >= 1e6) break;
    iters = Math.min(1e6, Math.ceil(iters * (minSampleMs / Math.max(took, 0.0005)) * 1.15));
  }
  const times = [];
  for (let s = 0; s < samples; s++) {
    globalThis.gc?.();
    const t = performance.now();
    for (let i = 0; i < iters; i++) keep(fn());
    times.push((performance.now() - t) / iters);
  }
  times.sort((a, b) => a - b);
  return { median: times[samples >> 1], min: times[0], spread: times[Math.floor(samples * 0.9)] / times[samples >> 1], iters };
}

const RESULTS = process.env.BENCH_RESULTS;
export const fmt = ms => (ms >= 1 ? `${ms.toFixed(2)} ms` : ms >= 0.001 ? `${(ms * 1000).toFixed(1)} µs` : `${(ms * 1e6).toFixed(0)} ns`);
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

export function header(title) {
  console.log(`\n=== ${title} ===`);
  console.log(`${pad('case', 46)}${lpad('n', 8)}${lpad('wherelive', 12)}${lpad('native', 12)}${lpad('x slower', 10)}${lpad('ns/row', 9)}${lpad('noise', 7)}`);
}

/**
 * Time the library call against a hand-written native baseline, after checking they agree.
 * `agree(libResult, baseResult)` must return true, otherwise the case is reported as WRONG and not timed.
 */
export function pair(group, name, n, lib, base, { agree, alt, samples } = {}) {
  const l = lib();
  const b = base();
  if (agree && !agree(l, b)) {
    console.log(`${pad(name, 46)}${lpad(n, 8)}   RESULTS DIFFER - not timed`);
    appendResult({ group, name, n, error: 'results differ' });
    return;
  }
  const rb = measure(base, { samples });
  const rl = measure(lib, { samples });
  const ra = alt ? measure(alt.fn, { samples }) : undefined;
  const ratio = rl.median / rb.median;
  console.log(
    `${pad(name, 46)}${lpad(n, 8)}${lpad(fmt(rl.median), 12)}${lpad(fmt(rb.median), 12)}${lpad(ratio.toFixed(2) + 'x', 10)}${lpad(((rl.median * 1e6) / n).toFixed(0), 9)}${lpad(Math.max(rl.spread, rb.spread).toFixed(2), 7)}`,
  );
  if (ra) console.log(`${pad('   └ ' + alt.name, 46)}${lpad('', 8)}${lpad('', 12)}${lpad(fmt(ra.median), 12)}${lpad((rl.median / ra.median).toFixed(2) + 'x', 10)}`);
  appendResult({ group, name, n, lib: rl.median, base: rb.median, ratio, nsPerRow: (rl.median * 1e6) / n, spread: Math.max(rl.spread, rb.spread), alt: ra && { name: alt.name, ms: ra.median } });
}

/** Time one thing on its own (no baseline). */
export function solo(group, name, n, fn, { note = '', samples } = {}) {
  const r = measure(fn, { samples });
  console.log(`${pad(name, 46)}${lpad(n ?? '', 8)}${lpad(fmt(r.median), 12)}${lpad('', 12)}${lpad('', 10)}${lpad(n ? ((r.median * 1e6) / n).toFixed(0) : '', 9)}${lpad(r.spread.toFixed(2), 7)}  ${note}`);
  appendResult({ group, name, n, lib: r.median, nsPerRow: n ? (r.median * 1e6) / n : undefined, spread: r.spread });
  return r;
}

function appendResult(row) {
  if (RESULTS) appendFileSync(RESULTS, JSON.stringify(row) + '\n');
}

export const sameLength = (a, b) => a.length === b.length;
export const sameIds = (a, b) => a.length === b.length && [0, 1, 2, a.length >> 1, a.length - 1].every(i => i < 0 || a[i]?.id === b[i]?.id);

export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const sstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
// Frame-rate independent damping toward a target.
export const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

export function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash3(x, y, z) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

export function vnoise(x, y, z) {
  const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
  const fx = x - X, fy = y - Y, fz = z - Z;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  const a = lerp(hash3(X, Y, Z), hash3(X + 1, Y, Z), u);
  const b = lerp(hash3(X, Y + 1, Z), hash3(X + 1, Y + 1, Z), u);
  const c = lerp(hash3(X, Y, Z + 1), hash3(X + 1, Y, Z + 1), u);
  const d = lerp(hash3(X, Y + 1, Z + 1), hash3(X + 1, Y + 1, Z + 1), u);
  return lerp(lerp(a, b, v), lerp(c, d, v), w);
}

// Membrane potential at the axon hillock as a function of scroll phase.
// 0–2 rest (hero, soma), 2–7 five EPSPs summing toward threshold, ~6.95 the spike, then repolarization.
export const THRESHOLD = -55;
export function membrane(f) {
  let v = -70;
  for (let i = 0; i < 5; i++) {
    const c = 2.2 + i;
    v += 3 * sstep(c, c + 0.3, f) + 1.6 * Math.exp(-(((f - (c + 0.28)) / 0.1) ** 2));
  }
  v += 0.9 * sstep(6.3, 6.9, f);
  const a = f - 6.95;
  if (a > 0) {
    const rise = sstep(0, 0.07, a);
    const fall = sstep(0.09, 0.34, a);
    const rec = sstep(0.4, 1.1, a);
    v = v + (40 - v) * rise;
    v += -120 * fall;
    v += 10 * rec;
  }
  return v + 0.22 * Math.sin(f * 91.7) + 0.14 * Math.sin(f * 37.3 + 1.3);
}

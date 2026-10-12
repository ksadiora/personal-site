import '@fontsource-variable/jetbrains-mono';
import './style.css';

import * as THREE from 'three';
import { person, hello, currently, previously, also, inputs } from './content.js';
import { createStage } from './stage.js';
import { createNeuron } from './neuron.js';
import { clamp, lerp, sstep, damp } from './util.js';

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const FINE = matchMedia('(pointer: fine)').matches;
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// [text](url) becomes a link; everything else is escaped.
const md = (s) => esc(s).replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) =>
  `<a href="${url}"${/^https?:/.test(url) ? ' target="_blank" rel="noopener"' : ''}>${text}</a>`);

// ---------- content

let d = 0;
// Each block fades in a beat after the one above it.
const rv = (cls = '') => `class="rv ${cls}" style="--d:${(d++ * 0.07).toFixed(2)}s"`;
$('#page').innerHTML = `
  <div class="card" id="card">
    <h1 ${rv()}>${esc(hello)}</h1>
    ${currently.map((p) => `<p ${rv()}>${md(p)}</p>`).join('')}
    <p ${rv('sub')}>previously, i've:</p>
    <ul class="did">
      ${previously.map((p, i) => `
        <li ${rv()} data-i="${i}">
          <i class="mk" aria-hidden="true" style="--c:${inputs[i].color};--cl:${inputs[i].light}">*</i>
          <span>${md(p)}</span>
        </li>`).join('')}
    </ul>
    ${also.map((p) => `<p ${rv()}>${md(p)}</p>`).join('')}
    <nav ${rv('links')} aria-label="Links">
      ${[
        `<a href="mailto:${esc(person.email)}">email</a>`,
        `<a href="${esc(person.github)}" target="_blank" rel="noopener">github</a>`,
        `<a href="${esc(person.linkedin)}" target="_blank" rel="noopener">linkedin</a>`,
        person.resumePdf && `<a href="${esc(person.resumePdf)}" target="_blank" rel="noopener">resume</a>`,
      ].filter(Boolean).join('<span aria-hidden="true">·</span>')}
    </nav>
  </div>
`;
if (!FINE) $('#vm-hint').textContent = 'tap the cell to make it fire';

const items = [...document.querySelectorAll('.did li')];
const marks = items.map((li) => li.querySelector('.mk'));

// ---------- 3D

let stage = null, neuron = null;
try {
  stage = createStage($('#gl'));
  neuron = createNeuron({ inputs, nNodes: 6, small: stage.small, pr: stage.pr });
  stage.scene.add(neuron.root);
} catch (err) {
  console.warn('WebGL unavailable', err);
  document.body.classList.add('no-gl');
}

// ---------- the cell: inputs sum at the soma, and past threshold it fires

const REST = -70, THRESH = -55;
const ARRIVE = 0.85; // seconds for a pulse to run from a branch tip to the soma (matches neuron.js)
const REFRACT = 1.7;
const N = inputs.length;
const cell = { v: REST, d: new Array(N).fill(0), arrivals: [], tSpike: -99, spikeNow: false };
const queue = []; // scheduled inputs: { at, i, amp }
let now = 0;

function stimulate(i, amp = 1) {
  cell.d[i] = Math.max(cell.d[i], amp);
  cell.arrivals.push({ at: now + ARRIVE, dv: 5.2 * amp });
  neuron?.fire(i, amp, now);
  if (!REDUCED) {
    marks[i]?.animate(
      [{ transform: 'scale(1.9)', opacity: 1, textShadow: '0 0 14px currentColor' }, { transform: 'scale(1)', textShadow: '0 0 0 currentColor' }],
      { duration: 900, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' },
    );
  }
}

// Left alone, the cell gets a volley of inputs every few seconds, enough to fire it,
// plus the odd stray input that fades without reaching threshold.
let nextVolley = 2.6;
function schedule(t) {
  if (REDUCED || t < nextVolley) return;
  const order = [...Array(N).keys()].sort(() => Math.random() - 0.5);
  const k = Math.random() < 0.4 ? 5 : 4;
  let at = t;
  for (let j = 0; j < k; j++) { queue.push({ at, i: order[j], amp: 1 }); at += 0.2 + Math.random() * 0.14; }
  const gap = 6.5 + Math.random() * 2.5;
  queue.push({ at: t + gap * (0.45 + Math.random() * 0.15), i: Math.floor(Math.random() * N), amp: 0.7 });
  nextVolley = t + gap;
}
// Clicking the cell fires it on demand: every branch at once.
function volley(t) {
  for (let i = 0; i < N; i++) queue.push({ at: t + i * 0.07, i, amp: 1 });
  nextVolley = Math.max(nextVolley, t + 5);
}

function stepCell(t, dt) {
  for (let k = queue.length - 1; k >= 0; k--) {
    if (t >= queue[k].at) { stimulate(queue[k].i, queue[k].amp); queue.splice(k, 1); }
  }
  cell.v = REST + (cell.v - REST) * Math.exp(-dt / 2.2);
  const refractory = t - cell.tSpike < REFRACT;
  for (let k = cell.arrivals.length - 1; k >= 0; k--) {
    if (t >= cell.arrivals[k].at) {
      if (!refractory) cell.v += cell.arrivals[k].dv;
      cell.arrivals.splice(k, 1);
    }
  }
  cell.spikeNow = false;
  if (!refractory && cell.v >= THRESH) {
    cell.tSpike = t;
    cell.v = REST - 7; // afterhyperpolarization, relaxing back to rest
    cell.spikeNow = true;
  }
  for (let i = 0; i < N; i++) cell.d[i] *= Math.exp(-dt / 0.75);
}

// What the readout shows: the integrated potential, with the spike waveform drawn over it.
function vOut(t) {
  const a = t - cell.tSpike;
  if (a < 0 || a > 0.6) return cell.v;
  const v = THRESH + 95 * sstep(0, 0.05, a) - 118 * sstep(0.06, 0.3, a);
  return lerp(v, cell.v, sstep(0.3, 0.6, a));
}

// ---------- pointer: hovering a line drives its branch; clicking the cell fires it

let hoverI = -1, lastHoverFire = 0;
items.forEach((li, i) => {
  const on = () => { hoverI = i; if (now - lastHoverFire > 0.35) { stimulate(i); lastHoverFire = now; } };
  const off = () => { if (hoverI === i) hoverI = -1; };
  li.addEventListener('pointerenter', on);
  li.addEventListener('pointerleave', off);
  li.addEventListener('focusin', on);
  li.addEventListener('focusout', off);
});

const ray = new THREE.Raycaster();
let overCell = false, pickDirty = false, lastPick = 0;
const mouse = { x: innerWidth / 2, y: innerHeight / 2 };
window.addEventListener('pointermove', (e) => {
  mouse.x = e.clientX; mouse.y = e.clientY;
  pickDirty = !e.target.closest('a, button, .card');
  if (!pickDirty) overCell = false;
});
const ndc = new THREE.Vector2();
function hitsCell(x, y) {
  if (!neuron || !stage) return false;
  ray.setFromCamera(ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1), stage.camera);
  return ray.intersectObjects(neuron.targets, false).length > 0;
}
document.addEventListener('click', (e) => {
  if (e.target.closest('a, button, .card')) return;
  if (hitsCell(e.clientX, e.clientY)) volley(now);
});

// ---------- theme

const themeBtn = $('#theme');
function applyTheme(theme) {
  const light = theme === 'light';
  document.documentElement.dataset.theme = theme;
  themeBtn.setAttribute('aria-label', light ? 'Switch to dark mode' : 'Switch to light mode');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', light ? '#eef1f5' : '#030407');
  stage?.setTheme(light);
  neuron?.setTheme(light);
}
themeBtn.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  try { localStorage.setItem('ks-theme', next); } catch {}
  if (!document.startViewTransition || REDUCED) { applyTheme(next); return; }
  // Reveal the new theme as a circle growing out of the button.
  const r = themeBtn.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const vt = document.startViewTransition(() => { applyTheme(next); frame(performance.now() + 1); });
  vt.ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 750, easing: 'cubic-bezier(0.2, 0.7, 0.15, 1)', pseudoElement: '::view-transition-new(root)' },
    );
  }).catch(() => {});
});
applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

// ---------- camera: the whole cell, framed in the space the text isn't using

const V = (x, y, z) => new THREE.Vector3(x, y, z);
// Centered on the whole cell, from the dendrite tips to the next cell past the terminal.
const FRAME = { tgt: V(0.52, -0.12, 0), dir: V(0.04, 0.1, 1).normalize(), hw: 3.65, hh: 1.82 };
const camPos = V(), camTgt = FRAME.tgt.clone(), goalPos = V(), dir = V();
let vox = 0, voy = 0, rect = { l: 0, r: 0, t: 0, b: 0 }, stacked = false;

// Side by side, the page never scrolls: if the text is taller than the window, shrink its font size
// (all card spacing is in em) until it fits. Stacked layouts scroll normally.
const card = $('#card');
function fit() {
  card.style.fontSize = '';
  let ok = innerWidth >= 1080;
  if (ok) {
    const cs = getComputedStyle($('#page'));
    const avail = innerHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    let fs = parseFloat(getComputedStyle(card).fontSize);
    for (let i = 0; i < 8 && card.offsetHeight > avail && fs > 12; i++) {
      fs = Math.max(12, fs * Math.max(0.9, avail / card.offsetHeight));
      card.style.fontSize = `${fs.toFixed(2)}px`;
    }
    ok = card.offsetHeight <= avail;
  }
  document.documentElement.classList.toggle('fits', ok);
}

function measure() {
  const W = innerWidth, H = innerHeight;
  const cr = card.getBoundingClientRect();
  stacked = W < 1080;
  // Side by side: the cell takes everything right of the text. Stacked: the band above it.
  rect = stacked
    ? { l: 0, r: 0, t: 52, b: H - Math.max(H * 0.3, cr.top + window.scrollY - 6) }
    : { l: cr.right + 40, r: 36, t: 64, b: 52 };
}
window.addEventListener('resize', () => { stage?.resize(); fit(); measure(); });
new ResizeObserver(measure).observe(card);
document.fonts?.ready.then(() => { fit(); measure(); });
stage?.resize();
fit();
measure();
camPos.copy(FRAME.tgt).addScaledVector(FRAME.dir, 14);

// ---------- loop

const vmEl = $('#vm'), vmBox = $('#vm-box');
let vmText = '';
let t0 = -1, lastT = performance.now() / 1000;
requestAnimationFrame(() => document.body.classList.add('live'));

function loop(ms) {
  requestAnimationFrame(loop);
  frame(ms);
}
function frame(ms) {
  const t = ms / 1000;
  if (t <= lastT) return;
  const dt = Math.min(0.05, t - lastT);
  lastT = t;
  if (document.hidden) return;
  if (t0 < 0) t0 = t;
  now = t - t0;

  schedule(now);
  if (hoverI >= 0) {
    cell.d[hoverI] = Math.max(cell.d[hoverI], 0.8);
    if (now - lastHoverFire > 1.1) { stimulate(hoverI); lastHoverFire = now; }
  }
  stepCell(now, dt);

  const v = vOut(now);
  const txt = `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(1)} mV`;
  if (txt !== vmText) { vmEl.textContent = txt; vmText = txt; }
  vmBox.classList.toggle('firing', now - cell.tSpike < 0.5);

  if (!stage || !neuron) return;
  const { camera, size } = stage;
  const W = size.w, H = size.h;

  if (pickDirty && FINE && now - lastPick > 0.05) {
    pickDirty = false;
    lastPick = now;
    overCell = hitsCell(mouse.x, mouse.y);
  }
  document.body.classList.toggle('over-cell', overCell);

  // A slow drift around the cell so it reads as 3D, plus a little mouse parallax.
  dir.copy(FRAME.dir);
  if (!REDUCED) {
    dir.x += 0.1 * Math.sin(now * 0.07);
    dir.y += 0.05 * Math.sin(now * 0.053 + 1);
  }
  dir.normalize();
  const aw = Math.max(120, W - rect.l - rect.r), ah = Math.max(120, H - rect.t - rect.b);
  const hw = FRAME.hw * (stacked ? 1.04 : 1);
  const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const dist = (H / tanY) * Math.max(FRAME.hh / ah, hw / aw);
  goalPos.copy(FRAME.tgt).addScaledVector(dir, dist);
  if (FINE && !REDUCED) {
    goalPos.x += (mouse.x / W - 0.5) * dist * 0.05;
    goalPos.y -= (mouse.y / H - 0.5) * dist * 0.035;
  }
  camPos.lerp(goalPos, damp(REDUCED ? 40 : 3.2, dt));
  camera.position.copy(camPos);
  camera.lookAt(camTgt);
  const ox = W / 2 - (rect.l + aw / 2), oy = H / 2 - (rect.t + ah / 2);
  vox += (ox - vox) * damp(6, dt);
  voy += (oy - voy) * damp(6, dt);
  camera.setViewOffset(W, H, vox, voy, W, H);

  // Signal state for the shaders.
  const a = now - cell.tSpike;
  const AP_T = 1.15, TERM_T = 0.3;
  let apDist = -1, nodeFade = 1, axon = 0, syn = 0, after = 0;
  if (a >= 0 && a < 3.1) {
    apDist = a < AP_T ? (a / AP_T) * neuron.AL : lerp(neuron.AL, neuron.termEnd, clamp((a - AP_T) / TERM_T, 0, 1));
    nodeFade = 1 - sstep(1.9, 2.9, a);
    axon = sstep(0, 0.12, a) * (1 - sstep(1.3, 2.4, a));
    syn = sstep(AP_T + 0.15, AP_T + 0.35, a) * (1 - sstep(2.3, 3.1, a));
    after = 1 - sstep(0, 1.2, a);
  }
  const charge = clamp((cell.v - REST) / (THRESH - REST), 0, 1);
  const lv = { d: cell.d.map((x) => clamp(x, 0, 1)), soma: Math.max(charge * 0.8, after * 0.8), axon, syn };
  const grow = REDUCED ? 99 : now * 2.7;
  const show = REDUCED ? 1 : sstep(0, 0.45, now);
  neuron.update({
    t: now, dt, lv, grow, show, dim: 1, apDist, nodeFade, motion: !REDUCED,
    spike: cell.spikeNow, restMute: 0.55, cam: camera.position,
  });

  stage.render(now);
}
requestAnimationFrame(loop);

// Dev only: window.__ks for the console and headless screenshots.
if (import.meta.env.DEV || import.meta.env.VITE_SHOTS) {
  const q = new URLSearchParams(location.search);
  if (q.get('theme')) applyTheme(q.get('theme'));
  // ?fire=<seconds>: fire the cell at that time, so a screenshot can catch the action potential.
  if (q.get('fire')) { nextVolley = 99; setTimeout(() => volley(now), +q.get('fire') * 1000); }
  window.__ks = { get v() { return cell.v; }, get tSpike() { return cell.tSpike; }, get now() { return now; }, fire: () => volley(now), stimulate, stage, neuron, THREE };
}

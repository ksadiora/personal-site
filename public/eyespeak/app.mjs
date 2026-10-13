import { DwellSelector, LETTER_GROUPS, deleteCharacter, lettersForGroup } from './core.mjs';
import {
  BlinkPauseGate,
  SMOOTHING_LEVELS,
  axisError,
  fitBestGazeMapping,
  evaluateTracePass,
  fixationSpread,
  verticalSeparation,
  calibrationError,
  extractFaceMeasurement,
  fitGazeMapping,
  GazeSmoother,
  mapGaze,
  summarizeCalibrationSamples,
} from './gaze.mjs';

// Five columns and five rows, not three and three. The base map has six free
// parameters, so nine targets left it almost interpolating them: noise on any one
// dot bent the whole surface, and a single bad row was enough to flatten vertical
// travel. Twenty-five targets over-determine the same six parameters four times
// over, and five distinct levels per axis is what actually pins the curvature —
// three points on an axis can only ever describe one bend through them.
// The span reaches nearer the edges too, so the corners of the board are
// interpolated rather than extrapolated.
const calibrationColumns = [8, 29, 50, 71, 92];
const calibrationRows = [10, 30, 50, 70, 90];
// Serpentine order: each row runs back the way the last one came, so the eye walks
// the grid instead of being thrown across the full width at every row break.
// Each round offsets the grid by a fraction of a cell so a repeat measures places
// on the screen the last one never visited, rather than re-measuring the same
// twenty-five spots and learning little beyond how repeatable they are.
const calibrationRoundOffsets = [[0, 0], [10.5, 10], [-10.5, -10]];
function getCalibrationPoints(round) {
  const [shiftX, shiftY] = calibrationRoundOffsets[round % calibrationRoundOffsets.length];
  return calibrationRows.flatMap((yPercent, row) => {
    const columns = row % 2 ? [...calibrationColumns].reverse() : calibrationColumns;
    return columns.map((xPercent) => [
      Math.min(95, Math.max(5, xPercent + shiftX)),
      Math.min(95, Math.max(5, yPercent + shiftY)),
    ]);
  });
}
const calibrationPoints = getCalibrationPoints(0);

// Calibration repeats as a whole, not just its last stage. A round is the full
// twenty-five dots plus the trace passes that measure the result, and a round that
// lands above the target is followed by another one whose dots are fitted alongside
// everything already gathered — so each round is a better-supported fit measured
// again from scratch, rather than a pick between attempts.
const maxCalibrationRounds = 3;
const calibrationTargetError = 90;
const calibrationImprovementFloor = 8;
// Starting points, not measured values: shorten dwellMs if holding feels slow,
// lengthen it if tiles fire while the user is still reading the board.
const dwellMs = 900;
// How hard the gaze point is averaged. See SMOOTHING_PRESETS in gaze.mjs for what
// each level costs. Press [ and ] while tracking to move between them live, so this
// can be settled by feel rather than by guessing; the toast names the new level.
const defaultSmoothingLevel = 'low';
// The camera is asked for everything it will give. Real webcams mostly cap at 30fps
// and quietly ignore the rest of this, which is fine — it is a ceiling, not a demand.
const cameraRequest = {
  frameRate: { ideal: 60 },
  width: { ideal: 1280 },
  height: { ideal: 720 },
  facingMode: 'user',
};
const blinkPause = new BlinkPauseGate();
const dwell = new DwellSelector({ dwellMs, graceMs: 220, cooldownMs: 650 });
// The trace pass repeats until it measures well rather than running once and
// hoping. Each repeat walks a DIFFERENT path: re-running one fixed squiggle would
// let the fit memorise those same anchors, and the error would fall without the
// map getting any better anywhere else on the screen. A fresh path every pass means
// the number being checked against the target below is always measured on points
// the current map has never been fitted to.
const maxTracePasses = 3;
const traceTargetError = 90;
// Another pass costs about twenty seconds, so it has to earn them.
const traceImprovementFloor = 6;
// Lissajous figures: two sine frequencies against each other. Varying the pair
// gives genuinely different routes over the screen from one short expression, and
// each still sweeps the full width and height rather than favouring one axis.
const traceShapes = [[1, 2, 0], [2, 1, 0], [3, 2, Math.PI / 2], [2, 3, 0], [1, 1, Math.PI / 2], [3, 4, Math.PI / 3]];
const traceAnchorCount = 9;

const elements = {
  welcome: document.querySelector('#welcome'),
  communicator: document.querySelector('#communicator'),
  message: document.querySelector('#message'),
  keyboardTitle: document.querySelector('#keyboard-title'),
  tileGrid: document.querySelector('#tile-grid'),
  startEye: document.querySelector('#start-eye'),
  startMouse: document.querySelector('#start-mouse'),
  speak: document.querySelector('#speak'),
  deleteKey: document.querySelector('#delete-key'),
  cursor: document.querySelector('#gaze-cursor'),
  dwellOrb: document.querySelector('#dwell-orb'),
  calibrationOverlay: document.querySelector('#calibration-overlay'),
  calibrationTarget: document.querySelector('#calibration-target'),
  calibrationCopy: document.querySelector('#calibration-copy'),
  calibrationStep: document.querySelector('#calibration-step'),
  traceCanvas: document.querySelector('#trace-canvas'),
  traceTarget: document.querySelector('#trace-target'),
  traceGaze: document.querySelector('#trace-gaze'),
  toast: document.querySelector('#toast'),
  hud: document.querySelector('#hud'),
};

const state = {
  text: '',
  stage: 'groups',
  activeGroup: '',
  inputMode: 'setup',
  pointer: null,
  focusedTarget: null,
  epoch: 0,
  calibrating: false,
  cameraStream: null,
  cameraVideo: null,
  faceMesh: null,
  cameraLoopActive: false,
  inferenceInFlight: false,
  rawGaze: null,
  lastRawAt: 0,
  gaze: null,
  lastGazeAt: 0,
  gazeMapping: null,
  smoothingLevel: defaultSmoothingLevel,
  smoother: new GazeSmoother({ level: defaultSmoothingLevel }),
  videoAspect: 1,
  // Two rates, because they answer different questions: the camera's own delivery
  // rate, and how many of those frames the face mesh actually kept up with.
  meter: { captured: 0, processed: 0, capturedFps: 0, processedFps: 0, inferenceMs: 0, since: 0 },
  pose: null,
  calibrationAccuracy: null,
  verticalSeparation: null,
  calibrationRounds: 0,
  hud: false,
  blink: {
    baseline: null,
    closed: false,
    closedAt: 0,
    paused: false,
  },
  trace: {
    active: false,
    context: null,
    target: null,
  },
  speaking: false,
  toastTimeout: null,
};

const wait = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

function showToast(text) {
  elements.toast.textContent = text;
  elements.toast.classList.remove('hidden');
  window.clearTimeout(state.toastTimeout);
  state.toastTimeout = window.setTimeout(() => elements.toast.classList.add('hidden'), 3600);
}

function tileMarkup({ id, label, action, value = '', className = '' }) {
  return `<button class="key-tile ${className}" data-tile-id="${state.epoch}:${id}" data-action="${action}" data-value="${value}" type="button">${label}</button>`;
}

function render() {
  state.epoch += 1;
  state.focusedTarget = null;
  // DELETE sits beside Speak now rather than inside the board, so it is shown and
  // hidden per stage instead of being rebuilt with the tiles. It keeps the epoch in
  // its id for the same reason the tiles do: a re-render under a resting gaze must
  // read as a new target, not as a hold already part-way done.
  elements.deleteKey.dataset.tileId = `${state.epoch}:delete`;
  elements.deleteKey.classList.toggle('hidden', state.stage !== 'groups');
  elements.message.textContent = state.text || 'Write with your eyes';
  elements.message.classList.toggle('empty', !state.text);

  if (state.stage === 'groups') {
    elements.keyboardTitle.textContent = 'Look at a letter group and hold';
    elements.tileGrid.className = 'keyboard-grid group-grid';
    elements.tileGrid.innerHTML = LETTER_GROUPS
      .map((group) => tileMarkup({ id: `group-${group}`, label: group, action: 'group', value: group }))
      .join('');
  } else {
    const letters = lettersForGroup(state.activeGroup);
    elements.keyboardTitle.textContent = `${state.activeGroup} — hold a letter`;
    elements.tileGrid.className = 'keyboard-grid letter-grid';
    elements.tileGrid.innerHTML = [
      ...letters.map((letter) => tileMarkup({ id: `letter-${letter}`, label: letter, action: 'letter', value: letter })),
      tileMarkup({ id: 'back', label: 'BACK', action: 'back' }),
    ].join('');
  }
}

function selectTarget(target) {
  if (!target) return;
  if (target.action === 'group') {
    state.activeGroup = target.value;
    state.stage = 'letters';
  } else if (target.action === 'letter') {
    state.text += target.value;
    state.activeGroup = '';
    state.stage = 'groups';
  } else if (target.action === 'back') {
    state.activeGroup = '';
    state.stage = 'groups';
  } else if (target.action === 'delete') {
    deleteLastLetter();
    return;
  } else if (target.action === 'speak') {
    speakMessage();
    return;
  }
  render();
}

function deleteLastLetter() {
  if (!state.text) return;
  state.text = deleteCharacter(state.text);
  state.activeGroup = '';
  state.stage = 'groups';
  render();
}

function targetAt(point) {
  const tile = document.elementFromPoint(point.x, point.y)?.closest('[data-tile-id]');
  if (!tile) return null;
  return {
    id: tile.dataset.tileId,
    action: tile.dataset.action,
    value: tile.dataset.value,
  };
}

function targetWithComfortMargin(point) {
  const current = state.focusedTarget
    ? document.querySelector(`[data-tile-id="${CSS.escape(state.focusedTarget.id)}"]`)
    : null;
  if (current) {
    const bounds = current.getBoundingClientRect();
    const margin = 54;
    if (
      point.x >= bounds.left - margin
      && point.x <= bounds.right + margin
      && point.y >= bounds.top - margin
      && point.y <= bounds.bottom + margin
    ) return state.focusedTarget;
  }
  return targetAt(point);
}

function setFocusedTarget(target) {
  const oldTile = document.querySelector('[data-tile-id].gaze-focus');
  if (oldTile && oldTile.dataset.tileId !== target?.id) oldTile.classList.remove('gaze-focus');
  state.focusedTarget = target;
  if (!target) return;
  const tile = document.querySelector(`[data-tile-id="${CSS.escape(target.id)}"]`);
  tile?.classList.add('gaze-focus');
}

function updateGazeFocus(point) {
  setFocusedTarget(targetWithComfortMargin(point));
}

function clearGazeFocus() {
  setFocusedTarget(null);
}

function paintDwellOrb(target, progress) {
  const tile = target ? document.querySelector(`[data-tile-id="${CSS.escape(target.id)}"]`) : null;
  if (!tile) {
    elements.dwellOrb.classList.add('hidden');
    return;
  }
  const bounds = tile.getBoundingClientRect();
  const size = Math.min(150, Math.max(56, Math.min(bounds.width, bounds.height) * 0.62));
  elements.dwellOrb.style.width = `${size}px`;
  elements.dwellOrb.style.height = `${size}px`;
  elements.dwellOrb.style.left = `${bounds.left + bounds.width / 2}px`;
  elements.dwellOrb.style.top = `${bounds.top + bounds.height / 2}px`;
  elements.dwellOrb.style.setProperty('--progress', `${progress * 100}%`);
  elements.dwellOrb.classList.remove('hidden');
}

function setCalibrationProgress(progress) {
  elements.calibrationTarget.style.setProperty('--progress', `${Math.max(0, Math.min(1, progress)) * 100}%`);
  elements.calibrationTarget.classList.toggle('sampling', progress > 0);
}

function setSmoothingLevel(level) {
  if (!SMOOTHING_LEVELS.includes(level)) return;
  state.smoothingLevel = level;
  state.smoother = new GazeSmoother({ level });
  showToast(`Smoothing: ${level}`);
}

function stepSmoothing(direction) {
  const index = SMOOTHING_LEVELS.indexOf(state.smoothingLevel);
  setSmoothingLevel(SMOOTHING_LEVELS[Math.min(SMOOTHING_LEVELS.length - 1, Math.max(0, index + direction))]);
}

function paintHud() {
  if (!state.hud) {
    elements.hud.classList.add('hidden');
    return;
  }
  const meter = state.meter;
  const pose = state.pose;
  const degrees = (value) => (Number.isFinite(value) ? `${Math.round(Math.asin(Math.max(-1, Math.min(1, value))) * 57.3)}°` : '--');
  // Terse on purpose: this has to survive a narrow window without clipping.
  elements.hud.textContent = [
    `cam ${meter.capturedFps.toFixed(0)}`,
    `mesh ${meter.processedFps.toFixed(0)}`,
    `${meter.inferenceMs.toFixed(0)}ms`,
    state.smoothingLevel,
    `y${degrees(pose?.yaw)} p${degrees(pose?.pitch)} r${degrees(pose?.roll)}`,
    state.verticalSeparation ? `vsig ${state.verticalSeparation.ratio.toFixed(1)}${state.verticalSeparation.monotonic ? '' : '!'}` : null,
    state.gazeMapping ? `${state.gazeMapping.featureSource === 'model' ? 'eyemodel' : 'ratio'}${state.gazeMapping.aperture ? '+lid' : ''}` : null,
    Number.isFinite(state.rawGaze?.distanceMm) ? `${Math.round(state.rawGaze.distanceMm / 10)}cm` : null,
    state.calibrationAccuracy
      ? `fit ${Math.round(state.calibrationAccuracy.x)}/${Math.round(state.calibrationAccuracy.y)}px${
        Number.isFinite(state.gazeMapping?.heldOutError) ? ` held ${Math.round(state.gazeMapping.heldOutError)}` : ''
      } ${state.gazeMapping?.verticalSource ?? ''}`
      : null,
  ].filter(Boolean).join(' · ');
  elements.hud.classList.remove('hidden');
}

function frame(now) {
  if (!state.calibrating && state.inputMode !== 'setup') {
    const point = state.inputMode === 'eye'
      ? (state.gaze && now - state.lastGazeAt <= 500 ? state.gaze : null)
      : state.pointer;
    if (point) {
      updateGazeFocus(point);
      // Once a tile is focused the orb carries the feedback, so the raw point —
      // the part that jitters — gets out of the way.
      if (state.inputMode === 'eye') {
        elements.cursor.classList.toggle('hidden', Boolean(state.focusedTarget));
        elements.cursor.style.transform = `translate(${point.x}px, ${point.y}px)`;
      }
    } else {
      clearGazeFocus();
      elements.cursor.classList.add('hidden');
    }
    const held = dwell.update(state.focusedTarget?.id ?? null, now);
    paintDwellOrb(state.focusedTarget, held.progress);
    if (held.fired) selectTarget(state.focusedTarget);
  }
  paintHud();
  window.requestAnimationFrame(frame);
}

function resetBlinkDetector() {
  blinkPause.reset();
  state.blink = {
    baseline: null,
    closed: false,
    closedAt: 0,
    paused: false,
  };
}

function updateBlinkDetector(openness, now) {
  const blink = state.blink;
  if (blink.baseline === null) blink.baseline = openness;
  const closeThreshold = Math.max(0.07, blink.baseline * 0.55);
  const openThreshold = blink.baseline * 0.76;
  if (!blink.closed && openness > openThreshold) blink.baseline = blink.baseline * 0.985 + openness * 0.015;

  if (!blink.closed) {
    if (openness < closeThreshold) {
      if (!blink.closedAt) blink.closedAt = now;
      if (now - blink.closedAt >= 65) blink.closed = true;
    } else {
      blink.closedAt = 0;
    }
  } else if (openness > openThreshold) {
    blink.closed = false;
    blink.closedAt = 0;
  }
  blink.paused = blinkPause.update(openness, blink.baseline, now);
  // A lower aperture that arrived gently is the lids following the eye downward, not
  // a blink. Left alone the baseline would stay up where the eye was looking before
  // and every glance at the lower rows would read as a half-closed eye, so the
  // baseline is walked down to meet it instead.
  if (blinkPause.settledBelow(openness, blink.baseline)) {
    blink.baseline = blink.baseline * 0.94 + openness * 0.06;
  }
  return blink.closed;
}

function handleFaceResults(results) {
  const measurement = extractFaceMeasurement(results.multiFaceLandmarks?.[0], state.videoAspect);
  if (!measurement) return;
  const now = performance.now();
  state.rawGaze = measurement.raw;
  state.pose = measurement.pose;
  state.lastRawAt = now;
  updateBlinkDetector(measurement.openness, now);
  if (state.blink.closed || state.blink.paused) return;

  const mapped = mapGaze(state.gazeMapping, measurement.raw);
  if (!mapped) return;
  if (state.trace.active) drawTraceGaze(mapped);
  const bounded = {
    x: Math.max(0, Math.min(window.innerWidth, mapped.x)),
    y: Math.max(0, Math.min(window.innerHeight, mapped.y)),
  };
  const result = state.smoother.update(bounded, now);
  if (!result.accepted || !result.point) return;
  state.gaze = result.point;
  state.lastGazeAt = now;
}

function getTraceAnchors(pass) {
  const [frequencyX, frequencyY, phase] = traceShapes[pass % traceShapes.length];
  return Array.from({ length: traceAnchorCount }, (_, index) => {
    const t = (index / traceAnchorCount) * Math.PI * 2;
    return {
      x: window.innerWidth * (0.5 + 0.42 * Math.sin(frequencyX * t + phase)),
      y: window.innerHeight * (0.5 + 0.4 * Math.sin(frequencyY * t)),
    };
  });
}

function prepareTraceCanvas(anchors) {
  const ratio = window.devicePixelRatio || 1;
  const canvas = elements.traceCanvas;
  canvas.width = Math.round(window.innerWidth * ratio);
  canvas.height = Math.round(window.innerHeight * ratio);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, window.innerWidth, window.innerHeight);
  context.setLineDash([3, 12]);
  context.lineWidth = 2;
  context.strokeStyle = 'rgba(255, 255, 255, 0.40)';
  context.beginPath();
  context.moveTo(anchors[0].x, anchors[0].y);
  for (let index = 1; index < anchors.length - 1; index += 1) {
    const midpoint = {
      x: (anchors[index].x + anchors[index + 1].x) / 2,
      y: (anchors[index].y + anchors[index + 1].y) / 2,
    };
    context.quadraticCurveTo(anchors[index].x, anchors[index].y, midpoint.x, midpoint.y);
  }
  const final = anchors.at(-1);
  context.lineTo(final.x, final.y);
  context.stroke();
  context.setLineDash([]);
  state.trace.context = context;
}

function drawTraceGaze(point) {
  const context = state.trace.context;
  if (!context) return;
  context.fillStyle = 'rgba(255, 255, 255, 0.48)';
  context.beginPath();
  context.arc(point.x, point.y, 2.2, 0, Math.PI * 2);
  context.fill();
  elements.traceGaze.style.left = `${point.x}px`;
  elements.traceGaze.style.top = `${point.y}px`;
  elements.traceGaze.classList.remove('hidden');
}

function placeTraceTarget(point) {
  state.trace.target = point;
  elements.traceTarget.style.left = `${point.x}px`;
  elements.traceTarget.style.top = `${point.y}px`;
  elements.traceTarget.classList.remove('hidden');
}

function moveTraceTarget(from, to, duration = 800) {
  return new Promise((resolve) => {
    let startedAt = null;
    const animate = (now) => {
      if (startedAt === null) startedAt = now;
      const progress = Math.min(1, (now - startedAt) / duration);
      // Smooth enough to follow while avoiding a sharp change in eye velocity.
      const eased = progress * progress * (3 - 2 * progress);
      placeTraceTarget({
        x: from.x + (to.x - from.x) * eased,
        y: from.y + (to.y - from.y) * eased,
      });
      if (progress < 1) window.requestAnimationFrame(animate);
      else resolve();
    };
    window.requestAnimationFrame(animate);
  });
}

async function collectTraceAnchor(target) {
  // Same standard as the dot pass: wait for the eye to catch up and park before
  // believing anything it reports. Here it has been chasing a moving dot, so the
  // settling is if anything more pronounced.
  await wait(260);
  await waitForFixation(1500);
  const samples = [];
  const startedAt = performance.now();
  while (performance.now() - startedAt < 700) {
    const raw = freshRaw();
    if (raw) samples.push(raw);
    await wait(20);
  }
  const summary = summarizeCalibrationSamples(samples);
  return summary && summary.count >= 8 ? { raw: summary.raw, target } : null;
}

// One pass of the squiggle. Returns what the CURRENT map scored on this path's
// anchors — points it has never been fitted to — plus the samples it gathered.
async function runTracePass(pass, totalPasses) {
  const anchors = getTraceAnchors(pass);
  const samples = [];
  const errors = [];
  prepareTraceCanvas(anchors);
  placeTraceTarget(anchors[0]);
  elements.calibrationStep.textContent = `FOLLOW THE LINE — PASS ${pass + 1}/${totalPasses}`;

  for (let index = 0; index < anchors.length; index += 1) {
    if (index) await moveTraceTarget(anchors[index - 1], anchors[index]);
    elements.calibrationCopy.textContent = `Follow the moving dot. Holding at point ${index + 1} of ${anchors.length}.`;
    const sample = await collectTraceAnchor(anchors[index]);
    if (!sample) continue;
    samples.push(sample);
    const prediction = mapGaze(state.gazeMapping, sample.raw);
    if (prediction) errors.push(Math.hypot(prediction.x - sample.target.x, prediction.y - sample.target.y));
  }

  const averageError = errors.length ? errors.reduce((total, error) => total + error, 0) / errors.length : Infinity;
  return { samples, averageError };
}

async function runTraceTraining(baseSamples) {
  state.trace.active = true;
  elements.calibrationOverlay.classList.add('trace-mode');
  elements.calibrationTarget.classList.add('hidden');
  elements.traceCanvas.classList.remove('hidden');

  const accumulated = [];
  const baseError = calibrationError(state.gazeMapping, baseSamples);
  // The best map is the best *measured* one. A refit at the end of a pass has not
  // been tested on anything yet, so if the loop runs out of passes the run falls
  // back to the last map that actually scored well rather than to the newest one.
  let bestMapping = state.gazeMapping;
  let bestError = Infinity;
  let stalls = 0;
  let passesRun = 0;

  try {
    for (let pass = 0; pass < maxTracePasses; pass += 1) {
      const { samples, averageError } = await runTracePass(pass, maxTracePasses);
      passesRun = pass + 1;

      const verdict = evaluateTracePass(
        { averageError, bestError, stalls },
        { targetError: traceTargetError, improvementFloor: traceImprovementFloor },
      );
      if (averageError < bestError) bestMapping = state.gazeMapping;
      bestError = verdict.bestError;
      stalls = verdict.stalls;
      if (verdict.stop) break;
      if (samples.length < 5) continue;

      accumulated.push(...samples);
      const candidate = fitGazeMapping([...baseSamples, ...accumulated], state.gazeMapping.verticalSource);
      // A path pass can be affected by normal eye-movement latency. Only take it
      // when it preserves the reliable dot calibration and has a plausible trace.
      if (candidate && averageError < 300 && calibrationError(candidate, baseSamples) <= baseError * 1.15) {
        state.gazeMapping = candidate;
      }

      elements.calibrationStep.textContent = 'REFINING';
      elements.calibrationCopy.textContent = `${Math.round(averageError)}px off the line. Target is ${traceTargetError}px — going again.`;
      await wait(1100);
    }

    // The trace measured this map on paths it was never fitted to, which is a
    // better held-out figure than the fold scores from the dot grid, so it replaces
    // the one the ready toast reports.
    state.gazeMapping = { ...bestMapping, heldOutError: Number.isFinite(bestError) ? bestError : bestMapping.heldOutError ?? null };
    const reached = bestError <= traceTargetError;
    elements.calibrationStep.textContent = reached ? 'TRACE COMPLETE' : 'MEASURED';
    elements.calibrationCopy.textContent = Number.isFinite(bestError)
      ? `${Math.round(bestError)}px off the line after ${passesRun} ${passesRun === 1 ? 'pass' : 'passes'}.${
        reached ? '' : ` Target was ${traceTargetError}px.`}`
      : 'Trace samples were limited. Base calibration kept.';
    await wait(1400);
    return bestError;
  } finally {
    state.trace.active = false;
    elements.traceTarget.classList.add('hidden');
    elements.traceGaze.classList.add('hidden');
    elements.traceCanvas.classList.add('hidden');
    elements.calibrationOverlay.classList.remove('trace-mode');
    state.trace.context = null;
  }
}

async function waitForVideo(video) {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth && video.videoHeight) return;
  await new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('Camera did not provide a video frame.')), 8000);
    video.addEventListener('loadeddata', () => {
      if (!video.videoWidth || !video.videoHeight) return;
      window.clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function stopVisionTracker() {
  state.cameraLoopActive = false;
  state.cameraStream?.getTracks().forEach((track) => track.stop());
  state.cameraStream = null;
  state.cameraVideo?.remove();
  state.cameraVideo = null;
  if (state.faceMesh?.close) await state.faceMesh.close();
  state.faceMesh = null;
  state.inferenceInFlight = false;
}

async function startVisionTracker() {
  if (!window.FaceMesh) throw new Error('Face tracking did not load.');
  await stopVisionTracker();
  const stream = await navigator.mediaDevices.getUserMedia({ video: cameraRequest, audio: false });
  const video = document.createElement('video');
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.style.cssText = 'position:fixed;width:1px;height:1px;left:-2px;top:-2px;opacity:0;pointer-events:none;';
  video.srcObject = stream;
  document.body.append(video);
  await video.play();
  await waitForVideo(video);

  const faceMesh = new window.FaceMesh({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619/${file}`,
  });
  faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,
    minDetectionConfidence: 0.55,
    minTrackingConfidence: 0.55,
  });
  faceMesh.onResults(handleFaceResults);
  state.cameraStream = stream;
  state.cameraVideo = video;
  state.faceMesh = faceMesh;
  state.videoAspect = video.videoWidth / video.videoHeight || 1;
  state.cameraLoopActive = true;
  state.meter = { captured: 0, processed: 0, capturedFps: 0, processedFps: 0, inferenceMs: 0, since: performance.now() };
  console.info('EyeSpeak camera', stream.getVideoTracks()[0]?.getSettings?.());

  // requestVideoFrameCallback fires once per frame the camera actually delivers.
  // requestAnimationFrame fires on the display's clock instead, which is the wrong
  // clock: it re-examines frames that have not changed and misses nothing useful in
  // return. Both stop while the tab is hidden, which is correct here — there is no
  // eye control to do on a page nobody is looking at.
  const scheduleFrame = video.requestVideoFrameCallback
    ? (callback) => video.requestVideoFrameCallback(callback)
    : (callback) => window.requestAnimationFrame(callback);

  const analyzeFrame = async () => {
    if (!state.cameraLoopActive || state.faceMesh !== faceMesh || state.cameraVideo !== video) return;
    state.meter.captured += 1;
    // A frame arriving mid-inference is dropped rather than queued: the freshest
    // frame is the only one worth having, and a backlog would only add latency.
    if (!state.inferenceInFlight && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth && video.videoHeight) {
      state.inferenceInFlight = true;
      const startedAt = performance.now();
      try {
        await faceMesh.send({ image: video });
        state.meter.processed += 1;
        state.meter.inferenceMs = performance.now() - startedAt;
      } catch (error) {
        console.warn('Face analysis paused', error);
      } finally {
        state.inferenceInFlight = false;
      }
    }
    const elapsed = performance.now() - state.meter.since;
    if (elapsed >= 500) {
      state.meter.capturedFps = (state.meter.captured * 1000) / elapsed;
      state.meter.processedFps = (state.meter.processed * 1000) / elapsed;
      state.meter.captured = 0;
      state.meter.processed = 0;
      state.meter.since = performance.now();
    }
    scheduleFrame(analyzeFrame);
  };
  scheduleFrame(analyzeFrame);
}

async function waitForFace(timeoutMs = 15000) {
  const startedAt = performance.now();
  while (!state.rawGaze && performance.now() - startedAt < timeoutMs) await wait(100);
  if (!state.rawGaze) throw new Error('No face detected.');
}

function describeCameraError(error) {
  const name = error?.name ?? '';
  const message = error?.message ?? '';
  if (name === 'NotAllowedError' || /permission|denied/i.test(message)) return 'Allow camera access for localhost:4173, then reload.';
  if (name === 'NotReadableError' || /in use/i.test(message)) return 'Close the other app using your camera, then try again.';
  if (name === 'NotFoundError') return 'No camera was found. Connect or enable a webcam.';
  if (/No face/i.test(message)) return 'Center your face in even light, then try again.';
  return 'Camera could not start. Reload and try again.';
}

function enterCommunicator() {
  elements.welcome.classList.add('hidden');
  elements.communicator.classList.remove('hidden');
  render();
}

// A calibration point is only worth what its samples are worth, so nothing here is
// on a clock. Sampling waits for the eye to actually arrive and park, takes readings
// only while it stays parked, and throws the batch away and asks again if it does
// not. Sampling on a fixed timer instead is what corrupts a pass: a saccade to a new
// dot, plus the corrective one that follows it, runs well past a third of a second,
// so early readings are of an eye still in flight — and one dirty point bends the
// whole fitted surface, not just its own corner of it.
const fixationTolerance = 0.012;
const fixationWindow = 7;

function freshRaw() {
  return state.rawGaze && performance.now() - state.lastRawAt < 260 && !state.blink.closed && !state.blink.paused
    ? { ...state.rawGaze }
    : null;
}

// Resolves once the eye has held still, or gives up and lets the caller sample anyway.
async function waitForFixation(timeoutMs) {
  const startedAt = performance.now();
  const recent = [];
  while (performance.now() - startedAt < timeoutMs) {
    const raw = freshRaw();
    if (raw) {
      recent.push(raw);
      if (recent.length > fixationWindow) recent.shift();
      if (recent.length === fixationWindow && fixationSpread(recent) < fixationTolerance) return true;
    } else {
      recent.length = 0;
    }
    await wait(25);
  }
  return false;
}

async function collectCalibrationPoint(index, x, y) {
  let best = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    elements.calibrationCopy.textContent = attempt
      ? `Keep your eyes on point ${index + 1}. Taking a steadier sample.`
      : `Look at point ${index + 1} of ${calibrationPoints.length}.`;
    setCalibrationProgress(0);
    // A floor under the settle even once the eye looks parked: the corrective
    // saccade that lands the fovea on target arrives after the big movement stops.
    await wait(360);
    await waitForFixation(2600);
    await wait(220);

    const samples = [];
    const recent = [];
    const samplingMs = 1100;
    const startedAt = performance.now();
    let broke = false;
    while (performance.now() - startedAt < samplingMs) {
      const raw = freshRaw();
      if (raw) {
        samples.push(raw);
        recent.push(raw);
        if (recent.length > fixationWindow) recent.shift();
        // Drifting off mid-batch means the readings no longer describe this dot.
        if (recent.length === fixationWindow && fixationSpread(recent) > fixationTolerance * 2) {
          broke = true;
          break;
        }
      }
      setCalibrationProgress((performance.now() - startedAt) / samplingMs);
      await wait(20);
    }
    setCalibrationProgress(broke ? 0 : 1);

    const summary = summarizeCalibrationSamples(samples);
    if (!broke && summary && summary.count >= 14) {
      if (!best || summary.spread < best.spread) best = summary;
      if (summary.spread < 0.02) return { raw: summary.raw, target: { x, y } };
    } else if (summary && summary.count >= 14 && (!best || summary.spread < best.spread)) {
      best = summary;
    }
  }
  if (best) return { raw: best.raw, target: { x, y } };
  throw new Error('Calibration did not receive enough eye samples.');
}

// One round of dots. Each round walks its own offset grid, so repeats add places
// the earlier rounds never measured instead of re-measuring the same spots.
async function collectDotGrid(round, rounds) {
  const points = getCalibrationPoints(round);
  const samples = [];
  elements.calibrationTarget.classList.remove('hidden');
  for (let index = 0; index < points.length; index += 1) {
    const [xPercent, yPercent] = points[index];
    const x = (window.innerWidth * xPercent) / 100;
    const y = (window.innerHeight * yPercent) / 100;
    elements.calibrationStep.textContent = rounds > 1
      ? `ROUND ${round + 1}/${rounds} — DOT ${index + 1}/${points.length}`
      : `CALIBRATING ${index + 1}/${points.length}`;
    elements.calibrationTarget.style.left = `${x}px`;
    elements.calibrationTarget.style.top = `${y}px`;
    samples.push(await collectCalibrationPoint(index, x, y));
  }
  setCalibrationProgress(0);
  elements.calibrationTarget.classList.add('hidden');
  return samples;
}

function reportVerticalSignal(samples) {
  const separation = verticalSeparation(samples);
  const horizontal = verticalSeparation(
    samples.map((sample) => ({ ...sample, target: { ...sample.target, y: sample.target.x } })),
    (sample) => sample.raw.x,
  );
  state.verticalSeparation = separation;
  // Logged before any fitting, because this says whether fitting can help at all.
  console.info('EyeSpeak vertical signal', {
    verticalRatio: separation?.ratio,
    monotonic: separation?.monotonic,
    horizontalRatioForComparison: horizontal?.ratio,
    rows: separation?.rows,
  });
  return separation;
}

async function startCalibration() {
  state.calibrating = true;
  state.gaze = null;
  state.gazeMapping = null;
  state.smoother.reset();
  clearGazeFocus();
  elements.calibrationOverlay.classList.remove('hidden');
  elements.calibrationStep.textContent = 'CALIBRATION';
  try {
    const samples = [];
    let measured = Infinity;
    let round = 0;
    let stalled = false;

    while (round < maxCalibrationRounds) {
      if (round) {
        elements.calibrationStep.textContent = 'CALIBRATING AGAIN';
        elements.calibrationCopy.textContent = `${Math.round(measured)}px off, and the target is ${calibrationTargetError}px. Running the dots again — the new ones sit between the last set.`;
        await wait(2400);
      }

      // Every round's dots join the ones already gathered, so the fit each round is
      // supported by more of the screen than the last — a rebuild on more evidence,
      // not a rerun hoping for a luckier attempt.
      samples.push(...await collectDotGrid(round, maxCalibrationRounds));
      round += 1;
      reportVerticalSignal(samples);

      const mapping = fitBestGazeMapping(samples);
      if (!mapping) throw new Error('Calibration could not create a gaze map.');
      state.gazeMapping = mapping;
      // Every candidate's held-out score, so which method won — and by how much —
      // is on the record rather than a matter of belief.
      console.info('EyeSpeak gaze model', {
        chosen: `${mapping.featureSource}/${mapping.verticalSource}${mapping.aperture ? '/aperture' : ''}`,
        candidates: mapping.candidateScores,
      });
      state.calibrationAccuracy = axisError(mapping, samples);

      let roundError = Infinity;
      try {
        roundError = await runTraceTraining(samples);
      } catch (error) {
        console.warn('Trace training skipped', error);
        showToast('Base calibration is ready. The trace pass was skipped.');
        break;
      }

      // A round that cannot beat the last one by a visible margin will not be
      // rescued by a third: the limit is the signal, not the quantity of dots.
      stalled = Number.isFinite(measured) && roundError > measured - calibrationImprovementFloor;
      if (Number.isFinite(roundError)) measured = Math.min(measured, roundError);
      if (measured <= calibrationTargetError || stalled) break;
    }

    state.smoother.reset();
    resetBlinkDetector();
    dwell.hold(performance.now(), 1400);
    // Named per axis so a map that only tracks sideways says so out loud, instead of
    // leaving it to be discovered by failing to select anything above or below.
    const accuracy = axisError(state.gazeMapping, samples);
    state.calibrationAccuracy = accuracy;
    state.calibrationRounds = round;
    const weak = state.verticalSeparation && state.verticalSeparation.ratio < 1.5;
    const reached = measured <= calibrationTargetError;
    showToast([
      `Ready after ${round} ${round === 1 ? 'round' : 'rounds'}.`,
      `Accuracy: ${Math.round(accuracy.x)}px across, ${Math.round(accuracy.y)}px up-down${
        Number.isFinite(measured) ? `, ${Math.round(measured)}px on unseen targets` : ''}.`,
      reached ? '' : stalled ? 'Extra rounds stopped helping.' : `Target was ${calibrationTargetError}px.`,
      weak ? `Vertical signal is weak (${state.verticalSeparation.ratio.toFixed(1)}) — press d for detail.` : '',
    ].filter(Boolean).join(' '));
  } finally {
    setCalibrationProgress(0);
    state.trace.active = false;
    state.trace.context = null;
    elements.calibrationTarget.classList.add('hidden');
    elements.traceTarget.classList.add('hidden');
    elements.traceGaze.classList.add('hidden');
    elements.traceCanvas.classList.add('hidden');
    elements.calibrationOverlay.classList.remove('trace-mode');
    elements.calibrationOverlay.classList.add('hidden');
    state.calibrating = false;
  }
}

async function startEyeControl() {
  elements.startEye.disabled = true;
  elements.startMouse.disabled = true;
  state.inputMode = 'setup';
  state.pointer = null;
  state.text = '';
  state.stage = 'groups';
  state.activeGroup = '';
  state.rawGaze = null;
  state.gaze = null;
  dwell.reset();
  resetBlinkDetector();
  try {
    await startVisionTracker();
    await waitForFace();
    state.inputMode = 'eye';
    enterCommunicator();
    await startCalibration();
  } catch (error) {
    console.error(error);
    await stopVisionTracker();
    state.inputMode = 'setup';
    elements.startEye.disabled = false;
    elements.startMouse.disabled = false;
    showToast(describeCameraError(error));
  }
}

function startMouseTest() {
  state.inputMode = 'mouse';
  state.pointer = null;
  state.text = '';
  state.stage = 'groups';
  state.activeGroup = '';
  dwell.hold(performance.now(), 1400);
  enterCommunicator();
  showToast('Mouse test: rest the pointer on a tile to hold-select it, or click it.');
}

async function repairMessage(text) {
  const response = await fetch('api/repair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.text) throw new Error(body.error || 'Sentence repair is unavailable.');
  return body.text;
}

async function speakMessage() {
  const raw = state.text.trim();
  if (!raw || state.speaking) return;
  if (!('speechSynthesis' in window)) {
    showToast('Speech is not available in this browser.');
    return;
  }
  state.speaking = true;
  elements.speak.disabled = true;
  elements.speak.textContent = 'Preparing sentence…';
  try {
    const corrected = await repairMessage(raw);
    state.text = corrected;
    render();
    const utterance = new SpeechSynthesisUtterance(corrected);
    utterance.rate = 0.9;
    utterance.onend = () => {
      state.speaking = false;
      elements.speak.disabled = false;
      elements.speak.textContent = 'Speak';
    };
    utterance.onerror = () => {
      state.speaking = false;
      elements.speak.disabled = false;
      elements.speak.textContent = 'Speak';
      showToast('Speech could not start. Your corrected message is still shown.');
    };
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  } catch (error) {
    state.speaking = false;
    elements.speak.disabled = false;
    elements.speak.textContent = 'Speak';
    showToast(error.message || 'Sentence repair is unavailable.');
  }
}

function recordMousePosition(event) {
  if (state.inputMode !== 'mouse') return;
  state.pointer = { x: event.clientX, y: event.clientY };
}

elements.startEye.addEventListener('click', startEyeControl);
elements.startMouse.addEventListener('click', startMouseTest);
elements.speak.addEventListener('click', speakMessage);
document.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === '[') stepSmoothing(-1);
  else if (event.key === ']') stepSmoothing(1);
  else if (event.key.toLowerCase() === 'd') {
    state.hud = !state.hud;
    showToast(state.hud ? 'Tracking readout on' : 'Tracking readout off');
  } else return;
  event.preventDefault();
});

document.addEventListener('pointermove', recordMousePosition);
document.addEventListener('mousemove', recordMousePosition);
document.addEventListener('click', (event) => {
  if (state.inputMode !== 'mouse') return;
  const tile = event.target.closest('[data-tile-id]');
  if (!tile) return;
  selectTarget({ id: tile.dataset.tileId, action: tile.dataset.action, value: tile.dataset.value });
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  clearGazeFocus();
  dwell.reset();
});
window.addEventListener('beforeunload', () => {
  state.cameraStream?.getTracks().forEach((track) => track.stop());
});

render();
window.requestAnimationFrame(frame);

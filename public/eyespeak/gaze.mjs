// Scales the socket-relative vertical reading into roughly the same numeric range
// as the horizontal iris ratio. See extractFaceMeasurement.
const SOCKET_GAIN = 3;

export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function median(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

export function medianPoint(points) {
  if (!points.length) return null;
  return {
    x: median(points.map((point) => point.x)),
    y: median(points.map((point) => point.y)),
  };
}

function meanPoint(points) {
  const total = points.reduce((result, point) => ({ x: result.x + point.x, y: result.y + point.y }), { x: 0, y: 0 });
  return { x: total.x / points.length, y: total.y / points.length };
}

function landmarkDistance(landmarks, first, second) {
  return Math.hypot(
    landmarks[first].x - landmarks[second].x,
    landmarks[first].y - landmarks[second].y,
  );
}

function irisRatio(landmarks, irisIndices, cornerA, cornerB, top, bottom) {
  const iris = meanPoint(irisIndices.map((index) => landmarks[index]));
  const horizontal = (iris.x - landmarks[cornerA].x) / (landmarks[cornerB].x - landmarks[cornerA].x);
  const vertical = (iris.y - landmarks[top].y) / (landmarks[bottom].y - landmarks[top].y);
  return { x: horizontal, y: vertical };
}

// Vertical iris offset measured against the two eye corners instead of the lids.
// The corners are rigid bone landmarks; the lids are not, and the upper lid rides
// down with the eyeball, which is what squashed the old lid-relative ratio into
// almost no range. Measuring perpendicular to the corner-to-corner axis also means
// head roll rotates the ruler with the eye instead of leaking into the reading.
function socketVertical(landmarks, irisIndices, cornerA, cornerB) {
  const iris = meanPoint(irisIndices.map((index) => landmarks[index]));
  const a = landmarks[cornerA];
  const b = landmarks[cornerB];
  const axisX = b.x - a.x;
  const axisY = b.y - a.y;
  const width = Math.hypot(axisX, axisY);
  if (!(width > 1e-6)) return null;
  const normalX = -axisY / width;
  const normalY = axisX / width;
  const offsetX = iris.x - (a.x + b.x) / 2;
  const offsetY = iris.y - (a.y + b.y) / 2;
  return ((offsetX * normalX) + (offsetY * normalY)) / width;
}

function subtract(a, b, aspect) {
  // x, y and z arrive normalized against different dimensions, so they have to be
  // put in one metric space before any of the cross products below mean anything.
  return { x: a.x - b.x, y: (a.y - b.y) / aspect, z: (a.z ?? 0) - (b.z ?? 0) };
}

function norm(v) {
  const length = Math.hypot(v.x, v.y, v.z);
  return length > 1e-9 ? { x: v.x / length, y: v.y / length, z: v.z / length } : null;
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

// A rigid 3D frame for the skull, built from landmarks that bone holds in place:
// the two outer eye corners, the nose bridge and the chin. This is the same
// orientation signal a depth-sensor face tracker reports, recovered from the mesh
// instead — the browser is never given the TrueDepth stream.
//
// The forward vector's own components stand in for yaw and pitch rather than
// angles from atan2/asin: they are smooth and monotonic across the range a seated
// user covers, and they cannot wrap or blow up when the fit is briefly degenerate.
export function headPose(landmarks, aspect = 1) {
  if (!landmarks || landmarks.length < 468) return null;
  const right = norm(subtract(landmarks[263], landmarks[33], aspect));
  const rawUp = norm(subtract(landmarks[168], landmarks[152], aspect));
  if (!right || !rawUp) return null;
  const projection = dot(rawUp, right);
  const up = norm({
    x: rawUp.x - projection * right.x,
    y: rawUp.y - projection * right.y,
    z: rawUp.z - projection * right.z,
  });
  if (!up) return null;
  const forward = cross(right, up);
  const pose = { yaw: forward.x, pitch: forward.y, roll: right.y };
  if (!Object.values(pose).every(Number.isFinite)) return null;
  // The basis travels with the pose because the eye model below needs the axes
  // themselves, not just the three numbers summarising them.
  return { ...pose, basis: { right, up, forward } };
}

// Millimetres, from the population constant MediaPipe Iris is built on: the
// horizontal iris diameter is 11.7mm give or take half a millimetre on almost
// everyone, which is what lets a plain webcam recover real-world scale.
const IRIS_DIAMETER_MM = 11.7;
// Distance from the eyeball's centre of rotation out to the iris. The eyeball is
// about 12mm in radius and the iris sits just inside the corneal bulge.
const IRIS_ROTATION_RADIUS_MM = 10.5;

// The geometric eye model the accurate open-source trackers are built on, in the
// form that survives a webcam's landmark noise.
//
// The iris rides on a sphere around the eyeball's centre of rotation, so its
// displacement from the eye's resting centre IS the sine of the gaze angle, once
// that displacement is in millimetres. Two things make this better than the ratio
// of iris position to eye width that this file used before:
//
//   Scale comes from the iris itself. The iris is a circle of known size, and the
//   model measures it every frame, so leaning in or sitting back changes the
//   measured radius in exactly the proportion needed to cancel out. An eye-width
//   ratio has to trust the corner landmarks, which are soft tissue and far less
//   crisply located than the iris rim.
//
//   The displacement is taken along the head's own axes, so tilting or turning the
//   head does not leak into the reading. This is the landmark equivalent of the
//   normalization step appearance-based trackers apply before regression: cancel
//   the head, then estimate gaze.
//
// The result is an angle rather than a ratio, which also leaves the calibration
// polynomial far less nonlinearity to absorb.
function eyeModelAngles(landmarks, centerIndex, rimIndices, cornerA, cornerB, basis, aspect) {
  const center = landmarks[centerIndex];
  const point = (index) => ({ x: landmarks[index].x, y: landmarks[index].y / aspect });
  const irisCenter = point(centerIndex);
  const radii = rimIndices.map((index) => {
    const rim = point(index);
    return Math.hypot(rim.x - irisCenter.x, rim.y - irisCenter.y);
  });
  const radius = median(radii);
  if (!center || !(radius > 1e-6)) return null;
  const mmPerUnit = (IRIS_DIAMETER_MM / 2) / radius;

  const a = point(cornerA);
  const b = point(cornerB);
  const offsetX = irisCenter.x - (a.x + b.x) / 2;
  const offsetY = irisCenter.y - (a.y + b.y) / 2;
  // Onto the head's axes, dropping z: the in-plane landmarks are the trustworthy
  // ones, and the mesh's depth channel is far too noisy to put under an arcsine.
  const alongRight = offsetX * basis.right.x + offsetY * basis.right.y;
  // Negated so both axes read the way the screen does: positive is right and DOWN.
  // The head frame's up vector points up, while image y grows downward, and leaving
  // the two disagreeing would give a pitch that rises as the gaze falls.
  const alongUp = -(offsetX * basis.up.x + offsetY * basis.up.y);
  const scale = Math.hypot(basis.right.x, basis.right.y) || 1;
  const sinYaw = (alongRight / scale) * mmPerUnit / IRIS_ROTATION_RADIUS_MM;
  const sinPitch = (alongUp / scale) * mmPerUnit / IRIS_ROTATION_RADIUS_MM;
  const clamp = (value) => Math.asin(Math.max(-0.98, Math.min(0.98, value)));
  return Number.isFinite(sinYaw) && Number.isFinite(sinPitch)
    ? { yaw: clamp(sinYaw), pitch: clamp(sinPitch), mmPerUnit }
    : null;
}

export function extractFaceMeasurement(landmarks, aspect = 1) {
  if (!landmarks || landmarks.length < 478) return null;
  const eyeA = irisRatio(landmarks, [468, 469, 470, 471, 472], 33, 133, 159, 145);
  const eyeB = irisRatio(landmarks, [473, 474, 475, 476, 477], 362, 263, 386, 374);
  const widthA = landmarkDistance(landmarks, 33, 133);
  const widthB = landmarkDistance(landmarks, 362, 263);
  const opennessA = landmarkDistance(landmarks, 159, 145) / widthA;
  const opennessB = landmarkDistance(landmarks, 386, 374) / widthB;
  const values = [eyeA.x, eyeA.y, eyeB.x, eyeB.y, opennessA, opennessB];
  if (!values.every(Number.isFinite)) return null;

  const socketA = socketVertical(landmarks, [468, 469, 470, 471, 472], 33, 133);
  const socketB = socketVertical(landmarks, [473, 474, 475, 476, 477], 362, 263);
  const lidY = (eyeA.y + eyeB.y) / 2;
  // SOCKET_GAIN only puts the vertical channel on a comparable footing to the
  // horizontal one so the shared ridge treats them alike. Calibration absorbs the
  // exact value; it is the lid-independence above that does the real work.
  const socketY = Number.isFinite(socketA) && Number.isFinite(socketB)
    ? 0.5 + ((socketA + socketB) / 2) * SOCKET_GAIN
    : null;
  const pose = headPose(landmarks, aspect);
  const modelA = pose?.basis
    ? eyeModelAngles(landmarks, 468, [469, 470, 471, 472], 33, 133, pose.basis, aspect)
    : null;
  const modelB = pose?.basis
    ? eyeModelAngles(landmarks, 473, [474, 475, 476, 477], 362, 263, pose.basis, aspect)
    : null;
  const model = modelA && modelB
    ? {
      yaw: (modelA.yaw + modelB.yaw) / 2,
      pitch: (modelA.pitch + modelB.pitch) / 2,
      // Iris size gives real scale, so this is a genuine distance reading rather
      // than the relative one eye width provides.
      distanceMm: ((modelA.mmPerUnit + modelB.mmPerUnit) / 2) * (widthA + widthB) / 2,
    }
    : null;

  return {
    // Keep the two eyes and coarse face pose separate. Averaging the eyes alone
    // loses information when the user turns or shifts their head a little.
    raw: {
      x: (eyeA.x + eyeB.x) / 2,
      y: socketY ?? lidY,
      lidY,
      socketY,
      eyeDeltaX: eyeA.x - eyeB.x,
      eyeDeltaY: eyeA.y - eyeB.y,
      headX: (landmarks[33].x + landmarks[263].x) / 2,
      headY: (landmarks[33].y + landmarks[263].y) / 2,
      eyeScale: (widthA + widthB) / 2,
      // The lid aperture is a vertical gaze cue, not just a blink signal. The upper
      // lid rides down with the eye, which is exactly why the lid-relative iris ratio
      // failed as a RATIO — but the same movement makes the aperture itself a large,
      // direct reading of vertical gaze, far larger than the iris displacement the
      // socket measure sees. Dividing one by the other threw it away; here it is kept
      // as its own term so the fit can weigh it against the iris on its own merits.
      aperture: (opennessA + opennessB) / 2,
      yaw: pose?.yaw ?? null,
      pitch: pose?.pitch ?? null,
      roll: pose?.roll ?? null,
      // The geometric model's own answer, kept beside the ratio reading so
      // calibration can weigh the two against each other on held-out targets.
      modelX: model?.yaw ?? null,
      modelY: model?.pitch ?? null,
      distanceMm: model?.distanceMm ?? null,
    },
    openness: (opennessA + opennessB) / 2,
    pose,
    model,
  };
}

// How far a short run of raw readings strays from its own centre. Small means the
// eye is parked; large means it is still travelling, or the mesh is unsteady.
// The stop/continue decision for the repeating trace pass, kept pure so the rule
// can be tested without a camera in front of it.
export function evaluateTracePass({ averageError, bestError, stalls }, { targetError, improvementFloor, maxStalls = 2 }) {
  const improved = averageError < bestError - improvementFloor;
  const nextBest = averageError < bestError ? averageError : bestError;
  const nextStalls = improved ? 0 : stalls + 1;
  const reached = nextBest <= targetError;
  return {
    bestError: nextBest,
    stalls: nextStalls,
    reached,
    // Passes cost real time, so stop once the target is met, and stop chasing it
    // when two passes running have failed to move the number: at that point the
    // limit is the tracking itself, not how much data has been thrown at it.
    stop: reached || nextStalls >= maxStalls,
  };
}

// Is there any vertical information in the readings at all?
//
// This is the question no amount of fitting can answer, and the one that decides
// what to do next. It groups the calibration samples by the screen row they were
// taken at and asks how far apart the rows' readings sit compared with how much a
// single row wanders on its own. Above about 1.5 the rows are genuinely
// distinguishable and a poor result is a mapping or smoothing problem; near or
// below 1 the rows overlap, the eye is not telling the camera where it is looking
// vertically, and no fit can recover what was never measured.
export function verticalSeparation(samples, read = (sample) => sample.raw.y) {
  const rows = new Map();
  for (const sample of samples) {
    const key = Math.round(sample.target.y);
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(read(sample));
  }
  const ordered = [...rows.entries()].sort((a, b) => a[0] - b[0]);
  if (ordered.length < 2) return null;

  const centres = ordered.map(([, values]) => median(values));
  const noise = ordered.map(([, values]) => {
    const centre = median(values);
    return median(values.map((value) => Math.abs(value - centre))) ?? 0;
  });
  const within = median(noise) ?? 0;
  const between = Math.abs(centres.at(-1) - centres[0]) / (centres.length - 1);
  // Monotonic rows matter as much as separated ones: readings that move apart but
  // not in screen order describe something other than vertical gaze.
  const steps = centres.slice(1).map((value, index) => value - centres[index]);
  const rising = steps.filter((step) => step > 0).length;
  return {
    rows: ordered.map(([y], index) => ({ y, centre: centres[index], noise: noise[index] })),
    within,
    between,
    ratio: within > 1e-9 ? between / within : Infinity,
    monotonic: rising === steps.length || rising === 0,
  };
}

export function fixationSpread(points) {
  const centre = medianPoint(points);
  if (!centre) return Infinity;
  return median(points.map((point) => distance(point, centre))) ?? Infinity;
}

export function summarizeCalibrationSamples(samples) {
  const centerPoint = medianPoint(samples);
  if (!centerPoint) return null;
  const fields = ['eyeDeltaX', 'eyeDeltaY', 'headX', 'headY', 'eyeScale', 'yaw', 'pitch', 'roll'];
  const center = { ...centerPoint };
  for (const field of fields) {
    const values = samples.map((sample) => sample[field]).filter(Number.isFinite);
    if (values.length) center[field] = median(values);
  }
  return {
    raw: center,
    count: samples.length,
    spread: median(samples.map((sample) => distance(sample, center))) ?? Infinity,
  };
}

// Whether the aperture terms are in play is a property of a whole fit, never of one
// frame, so it travels with the mapping. A basis that silently changed width between
// fitting and live use would read coefficients against the wrong features.
export function usesAperture(samples) {
  return samples.length > 0 && samples.every((sample) => Number.isFinite(sample.raw?.aperture));
}

function featureVector(raw, aperture = false, featureSource = 'ratio') {
  // Centering and scaling keeps the inputs numerically well-conditioned.
  const pair = featurePair(featureSource, raw) ?? featurePair('ratio', raw);
  const x = pair.x;
  const y = pair.y;
  const base = [1, x, y, x * y, x * x, y * y];
  if (!aperture) return base;
  // No need to centre this one: a constant offset in a linear term is absorbed by
  // the intercept, and in the cross term by the x coefficient. The x term is there
  // because the lids sit at a different angle to the camera at the edges of the
  // screen than in the middle.
  const a = (Number.isFinite(raw.aperture) ? raw.aperture - 0.3 : 0) * 10;
  return [...base, a, a * x];
}

function poseDelta(raw, center, field) {
  return Number.isFinite(raw?.[field]) && Number.isFinite(center?.[field]) ? raw[field] - center[field] : null;
}

function headFeatureVector(raw, center) {
  // Dividing the head shift by eye width keeps it comparable whether the user
  // sits close to the camera or far back.
  const scale = center?.eyeScale > 1e-6 ? center.eyeScale : (raw.eyeScale > 1e-6 ? raw.eyeScale : 1);
  const dx = center ? (raw.headX - center.headX) / scale : 0;
  const dy = center ? (raw.headY - center.headY) / scale : 0;
  // Rotation terms, preferring the rigid 3D frame. The eyeDelta pair is the older
  // stand-in for the same thing — the two irises moving against each other — and it
  // still serves a mesh that carried no usable z, so the vector keeps one fixed
  // width either way and the ridge below stays calibrated against it.
  const yaw = poseDelta(raw, center, 'yaw');
  const pitch = poseDelta(raw, center, 'pitch');
  const roll = poseDelta(raw, center, 'roll');
  if (yaw === null || pitch === null || roll === null) {
    const dEyeX = center && Number.isFinite(raw.eyeDeltaX) ? raw.eyeDeltaX - center.eyeDeltaX : 0;
    const dEyeY = center && Number.isFinite(raw.eyeDeltaY) ? raw.eyeDeltaY - center.eyeDeltaY : 0;
    return [1, dx, dy, dEyeX, dEyeY, 0];
  }
  // Pose angles run over a far smaller numeric range than the eye-width-normalized
  // shifts, so they are lifted here rather than left for the flat ridge to crush.
  return [1, dx, dy, yaw * 4, pitch * 4, roll * 4];
}

function solveLinearSystem(matrix, values) {
  const size = values.length;
  const augmented = matrix.map((row, index) => [...row, values[index]]);
  for (let pivot = 0; pivot < size; pivot += 1) {
    let best = pivot;
    for (let row = pivot + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][pivot]) > Math.abs(augmented[best][pivot])) best = row;
    }
    if (Math.abs(augmented[best][pivot]) < 0.000001) return null;
    [augmented[pivot], augmented[best]] = [augmented[best], augmented[pivot]];
    const divisor = augmented[pivot][pivot];
    for (let column = pivot; column <= size; column += 1) augmented[pivot][column] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === pivot) continue;
      const factor = augmented[row][pivot];
      for (let column = pivot; column <= size; column += 1) {
        augmented[row][column] -= factor * augmented[pivot][column];
      }
    }
  }
  return augmented.map((row) => row[size]);
}

export function fitGazeMapping(samples, verticalSource = 'socket', aperture = usesAperture(samples), featureSource = 'ratio') {
  const size = featureVector(samples[0]?.raw ?? { x: 0.5, y: 0.5 }, aperture, featureSource).length;
  if (samples.length < size) return null;
  const read = (sample) => withVerticalSource(verticalSource, sample.raw);
  const design = Array.from({ length: size }, () => Array(size).fill(0));
  const targetX = Array(size).fill(0);
  const targetY = Array(size).fill(0);
  for (const sample of samples) {
    const row = featureVector(read(sample), aperture, featureSource);
    for (let i = 0; i < size; i += 1) {
      targetX[i] += row[i] * sample.target.x;
      targetY[i] += row[i] * sample.target.y;
      for (let j = 0; j < size; j += 1) design[i][j] += row[i] * row[j];
    }
  }
  // Ridge scaled to each feature's own spread, not a flat constant. A flat ridge is a
  // negligible nudge to the wide-ranging horizontal features and an overwhelming one to
  // the vertical features, whose raw range is far smaller because the upper lid tracks
  // the eyeball as it rotates, so the iris stays near-centred in the aperture. That
  // asymmetry crushed the vertical coefficients and gaze tracked left-right but not up-down.
  for (let i = 1; i < size; i += 1) design[i][i] += Math.max(design[i][i] * 0.002, 1e-6);
  const x = solveLinearSystem(design, targetX);
  const y = solveLinearSystem(design, targetY);
  if (!x || !y) return null;
  const base = { x, y, verticalSource, aperture, featureSource };
  return { ...base, ...fitHeadCorrection(samples, base) };
}

function spread(values) {
  return Math.max(...values) - Math.min(...values);
}

function fitHeadCorrection(samples, base) {
  const center = summarizeCalibrationSamples(samples.map((sample) => sample.raw))?.raw ?? null;
  const size = headFeatureVector(samples[0].raw, center).length;
  const skipped = { center, headCorrection: null };
  // Two samples of slack beyond an exact fit, otherwise the correction just
  // interpolates the calibration points and carries their noise into live use.
  if (!center || !(center.eyeScale > 1e-6) || samples.length < size + 2) return skipped;
  const heads = samples.map((sample) => sample.raw.headX).concat(samples.map((sample) => sample.raw.headY));
  if (!heads.every(Number.isFinite)) return skipped;
  // A pass where the head never moved has no pose signal to learn from, so
  // fitting one here would only bake in sample noise.
  const moved = Math.max(spread(heads.slice(0, samples.length)), spread(heads.slice(samples.length)));
  if (moved < center.eyeScale * 0.03) return skipped;
  const rows = samples.map((sample) => headFeatureVector(sample.raw, center));
  if (!rows.every((row) => row.every(Number.isFinite))) return skipped;

  const design = Array.from({ length: size }, () => Array(size).fill(0));
  const residualX = Array(size).fill(0);
  const residualY = Array(size).fill(0);
  for (let sample = 0; sample < samples.length; sample += 1) {
    const predicted = mapGazeBase(base, samples[sample].raw);
    if (!predicted) return skipped;
    const errorX = samples[sample].target.x - predicted.x;
    const errorY = samples[sample].target.y - predicted.y;
    const row = rows[sample];
    for (let i = 0; i < size; i += 1) {
      residualX[i] += row[i] * errorX;
      residualY[i] += row[i] * errorY;
      for (let j = 0; j < size; j += 1) design[i][j] += row[i] * row[j];
    }
  }
  // Heavy ridge: this is a five-parameter fit on roughly a dozen noisy points,
  // so it should only move the prediction for a clear, repeated pose trend.
  for (let i = 0; i < size; i += 1) design[i][i] += 4;
  const x = solveLinearSystem(design, residualX);
  const y = solveLinearSystem(design, residualY);
  return x && y ? { center, headCorrection: { x, y } } : skipped;
}

// Which vertical reading the map was fitted against has to follow it into live use,
// so the mapping carries the choice rather than the caller remembering it.
export function withVerticalSource(source, raw) {
  if (source !== 'lid') return raw;
  return Number.isFinite(raw.lidY) ? { ...raw, y: raw.lidY } : raw;
}

// The two pairs of numbers the polynomial can be fitted over. 'model' is the
// geometric eye model's gaze angles; 'ratio' is the older iris-position-within-the-
// eye reading. Which one wins is settled on held-out targets, never asserted.
export function featurePair(source, raw) {
  if (source === 'model') {
    return Number.isFinite(raw.modelX) && Number.isFinite(raw.modelY)
      // Angles in radians, lifted to sit in the same numeric range as the ratios.
      ? { x: raw.modelX * 14, y: raw.modelY * 14 }
      : null;
  }
  return { x: (raw.x - 0.5) * 10, y: (raw.y - 0.5) * 10 };
}

export function usesModel(samples) {
  return samples.length > 0 && samples.every((sample) => featurePair('model', sample.raw) !== null);
}

function mapGazeBase(mapping, raw) {
  if (!mapping) return null;
  const row = featureVector(withVerticalSource(mapping.verticalSource, raw), mapping.aperture, mapping.featureSource);
  const x = mapping.x.reduce((total, coefficient, index) => total + coefficient * row[index], 0);
  const y = mapping.y.reduce((total, coefficient, index) => total + coefficient * row[index], 0);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

export function mapGaze(mapping, raw) {
  const base = mapGazeBase(mapping, raw);
  if (!base) return null;
  if (!mapping.headCorrection || !mapping.center) return base;
  const row = headFeatureVector(raw, mapping.center);
  const x = mapping.headCorrection.x.reduce((total, coefficient, index) => total + coefficient * row[index], 0);
  const y = mapping.headCorrection.y.reduce((total, coefficient, index) => total + coefficient * row[index], 0);
  return Number.isFinite(x) && Number.isFinite(y) ? { x: base.x + x, y: base.y + y } : base;
}

// Reported per axis, because a map that tracks left-right and ignores up-down is
// the exact failure this project keeps hitting, and one combined number hides it.
export function axisError(mapping, samples) {
  if (!mapping || !samples.length) return { x: Infinity, y: Infinity };
  let totalX = 0;
  let totalY = 0;
  for (const sample of samples) {
    const predicted = mapGaze(mapping, sample.raw);
    if (!predicted) return { x: Infinity, y: Infinity };
    totalX += (predicted.x - sample.target.x) ** 2;
    totalY += (predicted.y - sample.target.y) ** 2;
  }
  return { x: Math.sqrt(totalX / samples.length), y: Math.sqrt(totalY / samples.length) };
}

// Error measured on the very samples a map was fitted to always flatters it, and
// flatters the more flexible option most. Holding each fold out in turn measures
// what the map does with a target it has not already been shown, which is the only
// kind of accuracy that describes live use.
export function crossValidatedError(samples, verticalSource, aperture = usesAperture(samples), featureSource = 'ratio', folds = 5) {
  const size = aperture ? 8 : 6;
  // Every fold has to leave enough behind to fit the basis, with slack on top.
  if (samples.length - Math.ceil(samples.length / folds) < size + 2) return Infinity;
  let total = 0;
  let counted = 0;
  for (let fold = 0; fold < folds; fold += 1) {
    const training = samples.filter((_, index) => index % folds !== fold);
    const held = samples.filter((_, index) => index % folds === fold);
    const mapping = fitGazeMapping(training, verticalSource, aperture, featureSource);
    if (!mapping) return Infinity;
    for (const sample of held) {
      const predicted = mapGaze(mapping, sample.raw);
      if (!predicted) return Infinity;
      total += distance(predicted, sample.target) ** 2;
      counted += 1;
    }
  }
  return counted ? Math.sqrt(total / counted) : Infinity;
}

// Two vertical readings are available per frame and which one is better is a
// property of the person's eyes and their camera angle, not something to settle by
// argument: fit both and keep whichever predicts held-out targets better.
export function fitBestGazeMapping(samples) {
  let best = null;
  const scores = [];
  // Every combination worth trying, scored the same way. Adding a cue can hurt as
  // easily as help — more freedom is more room to fit noise — so none of these is
  // asserted to be better; they are raced on targets held out of their own fit.
  const apertureChoices = usesAperture(samples) ? [true, false] : [false];
  // The geometric model replaces both feature axes at once, so the vertical-reading
  // choice below only means anything for the ratio features.
  const candidates = usesModel(samples)
    ? [['model', 'socket'], ['ratio', 'socket'], ['ratio', 'lid']]
    : [['ratio', 'socket'], ['ratio', 'lid']];
  for (const [featureSource, verticalSource] of candidates) {
    const usable = samples.every((sample) => Number.isFinite(withVerticalSource(verticalSource, sample.raw).y));
    if (!usable) continue;
    for (const aperture of apertureChoices) {
      const mapping = fitGazeMapping(samples, verticalSource, aperture, featureSource);
      if (!mapping) continue;
      // Falls back to in-sample error only when there are too few points to hold any out.
      let score = crossValidatedError(samples, verticalSource, aperture, featureSource);
      if (!Number.isFinite(score)) score = calibrationError(mapping, samples);
      scores.push({ featureSource, verticalSource, aperture, score: Math.round(score * 10) / 10 });
      if (!best || score < best.score) best = { mapping, score };
    }
  }
  if (!best) return null;
  return {
    ...best.mapping,
    heldOutError: Number.isFinite(best.score) ? best.score : null,
    candidateScores: scores.sort((a, b) => a.score - b.score),
  };
}

export function calibrationError(mapping, samples) {
  if (!mapping || !samples.length) return Infinity;
  const squaredError = samples.reduce((total, sample) => {
    const predicted = mapGaze(mapping, sample.raw);
    return total + (predicted ? distance(predicted, sample.target) ** 2 : Infinity);
  }, 0);
  return Math.sqrt(squaredError / samples.length);
}

class LowPassFilter {
  constructor() {
    this.value = null;
  }

  filter(next, alpha) {
    this.value = this.value === null ? next : alpha * next + (1 - alpha) * this.value;
    return this.value;
  }
}

function smoothingFactor(cutoff, deltaSeconds) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / Math.max(deltaSeconds, 0.001));
}

class OneEuroAxis {
  constructor(minCutoff, beta, derivativeCutoff) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.derivativeCutoff = derivativeCutoff;
    this.previous = null;
    this.previousTime = null;
    this.valueFilter = new LowPassFilter();
    this.derivativeFilter = new LowPassFilter();
  }

  filter(value, timestamp) {
    if (this.previousTime === null) {
      this.previous = value;
      this.previousTime = timestamp;
      return this.valueFilter.filter(value, 1);
    }
    const deltaSeconds = Math.max((timestamp - this.previousTime) / 1000, 0.001);
    const derivative = (value - this.previous) / deltaSeconds;
    const filteredDerivative = this.derivativeFilter.filter(derivative, smoothingFactor(this.derivativeCutoff, deltaSeconds));
    const cutoff = this.minCutoff + this.beta * Math.abs(filteredDerivative);
    const filtered = this.valueFilter.filter(value, smoothingFactor(cutoff, deltaSeconds));
    this.previous = value;
    this.previousTime = timestamp;
    return filtered;
  }
}

// Every knob that trades responsiveness against steadiness, in one place, because
// the right setting is a matter of taste and of how steady a given person's gaze is.
// Read top to bottom as least averaged to most. Three separate stages of lag live
// here, and a level moves all three together:
//   medianWindow   frames of rolling median. Each frame costs a frame of delay and
//                  blocks fast movement outright, so this is the harshest of the three.
//   minCutoff/beta One Euro. Low cutoff steadies a resting gaze; beta is how far the
//                  filter opens up once you actually move. A near-zero beta never
//                  opens, which reads as wading through syrup on every deliberate look.
//   confirmMs      how long a large jump waits for a second frame to agree with it.
//                  A real look across the board is a large jump, so this is paid on
//                  every intentional move.
// 'high' is the previous behaviour, kept so it can be dialled back in.
export const SMOOTHING_PRESETS = {
  raw: { medianWindow: 1, minCutoff: 6, minCutoffY: 5, beta: 0.05, outlierDistance: 700, confirmMs: 60, confirmDistance: 220 },
  low: { medianWindow: 3, minCutoff: 3, minCutoffY: 2.2, beta: 0.02, outlierDistance: 500, confirmMs: 90, confirmDistance: 160 },
  medium: { medianWindow: 5, minCutoff: 1.2, minCutoffY: 0.9, beta: 0.006, outlierDistance: 380, confirmMs: 150, confirmDistance: 140 },
  high: { medianWindow: 7, minCutoff: 0.5, minCutoffY: 0.38, beta: 0.0012, outlierDistance: 300, confirmMs: 220, confirmDistance: 125 },
};

export const SMOOTHING_LEVELS = Object.keys(SMOOTHING_PRESETS);

export class GazeSmoother {
  // The vertical axis is still the noisier one even on the socket-relative reading,
  // so it keeps its own lower cutoff.
  constructor(options = {}) {
    const preset = SMOOTHING_PRESETS[options.level] ?? SMOOTHING_PRESETS.low;
    const merged = { derivativeCutoff: 1, ...preset, ...options };
    merged.minCutoffY = options.minCutoffY ?? merged.minCutoffY ?? merged.minCutoff;
    merged.betaY = options.betaY ?? merged.betaY ?? merged.beta;
    this.options = merged;
    this.reset();
  }

  reset() {
    this.history = [];
    this.pending = null;
    this.filtered = null;
    this.x = new OneEuroAxis(this.options.minCutoff, this.options.beta, this.options.derivativeCutoff);
    this.y = new OneEuroAxis(this.options.minCutoffY, this.options.betaY, this.options.derivativeCutoff);
  }

  update(point, timestamp) {
    const reference = medianPoint(this.history);
    if (reference && distance(point, reference) > this.options.outlierDistance) {
      const confirmsMove = this.pending
        && timestamp - this.pending.timestamp < this.options.confirmMs
        && distance(point, this.pending.point) < this.options.confirmDistance;
      if (!confirmsMove) {
        this.pending = { point, timestamp };
        return { point: this.filtered, accepted: false, rejected: true };
      }
      this.history = [this.pending.point, point];
      this.pending = null;
    } else {
      this.pending = null;
      this.history.push(point);
      while (this.history.length > this.options.medianWindow) this.history.shift();
    }
    const robust = medianPoint(this.history);
    this.filtered = {
      x: this.x.filter(robust.x, timestamp),
      y: this.y.filter(robust.y, timestamp),
    };
    return { point: this.filtered, accepted: true, rejected: false };
  }
}

// Iris ratios are geometry, and a half-closed lid breaks the geometry: the readings skew
// while the lid travels, in either direction, which the head correction then reads as yaw.
// So gaze pauses as soon as openness leaves the open band, not when a blink is confirmed,
// and only resumes near full baseline so the reopening tail is covered too.
export class BlinkPauseGate {
  // Level alone cannot tell a blink from looking down, and it matters which one is
  // happening: the lids narrow when the eye rotates down, so a purely level-based
  // gate reads the bottom of the screen as a half-blink and freezes tracking exactly
  // where it is needed. That leaves a screen whose lower rows barely respond, which
  // looks for all the world like a broken vertical axis.
  //
  // What separates them is speed. A blink is fast — lids shut in well under a tenth
  // of a second — while a gaze-down narrowing arrives gradually and then stays. So a
  // deep closure still pauses on level alone, and a shallow narrowing pauses only if
  // it arrived at blink speed. A shallow one that arrives slowly is a new resting
  // aperture, and the caller is told to re-baseline to it rather than pause.
  constructor({ enterRatio = 0.76, exitRatio = 0.9, closedRatio = 0.55, fallPerSecond = 2 } = {}) {
    this.options = { enterRatio, exitRatio, closedRatio, fallPerSecond };
    this.reset();
  }

  reset() {
    this.paused = false;
    this.previous = null;
    this.previousAt = null;
  }

  update(openness, baseline, timestamp = null) {
    if (!Number.isFinite(openness) || !Number.isFinite(baseline) || baseline <= 0) return this.paused;
    const elapsed = this.previousAt !== null && timestamp !== null ? (timestamp - this.previousAt) / 1000 : null;
    // Relative to baseline, so the rate means the same thing on any face or camera.
    const fallRate = elapsed && elapsed > 0 ? (this.previous - openness) / baseline / elapsed : 0;
    this.previous = openness;
    this.previousAt = timestamp;

    if (this.paused) {
      if (openness > baseline * this.options.exitRatio) this.paused = false;
      return this.paused;
    }
    if (openness < baseline * this.options.closedRatio) {
      this.paused = true;
    } else if (openness < baseline * this.options.enterRatio) {
      // Timestamps are optional; without them the old level-only rule stands.
      this.paused = timestamp === null || fallRate > this.options.fallPerSecond;
    }
    return this.paused;
  }

  // True when the aperture is sitting at a lower level that is not a blink, which is
  // the caller's cue to move its baseline down instead of waiting the pause out.
  settledBelow(openness, baseline) {
    return !this.paused
      && Number.isFinite(openness)
      && baseline > 0
      && openness < baseline * this.options.enterRatio
      && openness >= baseline * this.options.closedRatio;
  }
}

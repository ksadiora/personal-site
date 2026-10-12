import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rng, vnoise, clamp, sstep } from './util.js';

// Two looks share one scene. Dark: a fluorescence micrograph (additive glow on black).
// Light: ink on a glass slide (normal blending, stained colors). uLight switches every shader.

// ---------- shaders

// Cheap 3D value noise for membrane texture. DETAIL is 1 on phones, 2 elsewhere.
const NOISE = /* glsl */ `
  float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
  float vnoise3(vec3 p) {
    vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash13(i), hash13(i + vec3(1.0, 0.0, 0.0)), f.x), mix(hash13(i + vec3(0.0, 1.0, 0.0)), hash13(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
      mix(mix(hash13(i + vec3(0.0, 0.0, 1.0)), hash13(i + vec3(1.0, 0.0, 1.0)), f.x), mix(hash13(i + vec3(0.0, 1.0, 1.0)), hash13(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
      f.z);
  }
  vec3 hueRot(vec3 c, float a) {
    const vec3 k = vec3(0.57735);
    float ca = cos(a), sa = sin(a);
    return c * ca + cross(k, c) * sa + k * dot(k, c) * (1.0 - ca);
  }
  // Fluorescence is never one flat color: hue drifts and intensity pools across the cell.
  vec3 vary(vec3 c, vec3 p) {
    float h = vnoise3(p * 1.7 + 4.0) - 0.5;
    float b = vnoise3(p * 4.5 + 11.0);
    return max(hueRot(c, h * 0.8), 0.0) * (0.68 + 0.64 * b);
  }
  float membraneTex(vec3 p) {
  #if DETAIL > 1
    return vnoise3(p * 34.0) * 0.6 + vnoise3(p * 97.0) * 0.4;
  #else
    return vnoise3(p * 40.0);
  #endif
  }
`;
const KEY = 'normalize(vec3(-0.35, 0.6, 0.72))';

// Ambient motion for the cell and everything attached to it. The soma stays put and parts sway more the
// farther they are from it: dendrites wander, a slow wave runs down the axon toward the terminal, and the
// terminal and the next cell bob with it. Every vertex shader below uses this one field, evaluated at the
// vertex's world position, so spines, puncta, myelin, boutons and the next cell stay attached.
const SWAY = /* glsl */ `
  uniform float uSwayT; uniform float uSway;
  vec3 sway(vec3 p) {
    vec3 q = p - vec3(-1.0, 0.05, 0.0); // SOMA
    float w = smoothstep(0.24, 1.5, length(q)) * uSway;
    vec3 d = 0.075 * vec3(
      sin(uSwayT * 1.05 + p.y * 2.3 + p.z * 1.7),
      sin(uSwayT * 0.93 + p.x * 2.1 + 1.7),
      0.6 * sin(uSwayT * 0.77 + p.x * 1.4 + p.y * 1.9));
    // Right of the soma is the axon: there the motion is mostly a wave travelling toward the terminal.
    float ax = smoothstep(0.25, 1.1, q.x);
    d.y += ax * 0.1 * sin(p.x * 1.7 - uSwayT * 1.3);
    d.x *= 1.0 - 0.6 * ax;
    return d * w;
  }
`;

const RIM_V = /* glsl */ `
  varying vec3 vN; varying vec3 vV; varying vec3 vPos; varying vec3 vObj;
  ${SWAY}
  void main() {
    vObj = position;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vPos = wp.xyz;
    wp.xyz += sway(wp.xyz);
    vec4 mv = viewMatrix * wp;
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const DEND_V = /* glsl */ `
  attribute float aDist;
  varying float vDist; varying vec3 vN; varying vec3 vV; varying vec3 vPos; varying vec2 vUv;
  ${SWAY}
  void main() {
    vDist = aDist;
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vPos = wp.xyz;
    wp.xyz += sway(wp.xyz);
    vec4 mv = viewMatrix * wp;
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

// Every rim term clamps its base to [0, 1]: |N·V| can round a hair past 1 where a surface faces the camera,
// and pow() of a negative base is NaN, which bloom smears into black boxes. Gaussians use x*x, not pow(x, 2.0).
// Membrane tube with a travelling depolarization pulse and a growth cone while it grows in.
const DEND_F = /* glsl */ `
  uniform vec3 uColor; uniform float uLevel; uniform float uBase; uniform float uMute;
  uniform float uPulse; uniform float uPulseAmp; uniform float uGrow; uniform float uLight;
  uniform float uRootOn; uniform vec3 uRootCol; uniform float uInside;
  varying float vDist; varying vec3 vN; varying vec3 vV; varying vec3 vPos; varying vec2 vUv;
  ${NOISE}
  void main() {
    if (vDist > uGrow) discard;
    // Inside the cell body the soma's own membrane is the root. The branch fades in through it with a
    // fine dither (bloom and grain blur it into a soft fade), so there is no hard edge where it starts.
    // In light mode there is no bloom to hide a dither, so the root fades with real alpha instead.
    float fadeIn = uRootOn > 0.5 ? smoothstep(uInside, uInside + 0.16, vDist) : 1.0;
    if (uLight < 0.5) {
      float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      if (ign > fadeIn) discard;
    } else if (fadeIn <= 0.002) discard;
    vec3 N = normalize(vN);
    float fr = pow(clamp(1.0 - abs(dot(N, normalize(vV))), 0.0, 1.0), 1.4);
    float pulse = uPulseAmp * exp(-((vDist - uPulse) / 0.11) * ((vDist - uPulse) / 0.11));
    float cone = smoothstep(uGrow - 0.08, uGrow, vDist);
    // Mottled membrane, faint fibers running along the branch, and a soft key light for volume.
    float tex = membraneTex(vPos);
    float fib = 0.5 + 0.5 * sin(vUv.y * 37.7 + vnoise3(vPos * 18.0) * 4.0);
    float key = max(dot(N, ${KEY}), 0.0);
    vec3 tint = vary(uColor, vPos);
    float hot = smoothstep(0.74, 0.95, vnoise3(vPos * 6.0 + 3.0));
    float tipFade = mix(1.0, 0.7, smoothstep(0.5, 1.8, vDist));
    // Where a branch leaves the cell body it is still soma membrane; color comes in further out.
    float rootK = uRootOn * (1.0 - smoothstep(uInside, uInside + 0.34, vDist));
    if (uLight > 0.5) {
      vec3 col = mix(mix(tint * (1.0 - 0.22 * hot), vec3(0.6, 0.64, 0.72), uMute), uRootCol, rootK * 0.9);
      float shade = (1.0 - 0.45 * fr) * (0.8 + 0.28 * key) * (0.88 + 0.16 * tex) * (0.96 + 0.06 * fib);
      vec3 c = col * shade * (0.92 + 0.08 * uLevel);
      c = mix(vec3(0.86, 0.88, 0.91), c, clamp(uBase, 0.0, 1.0));
      c = mix(c, vec3(1.0), clamp(pulse, 0.0, 1.0) * 0.82);
      c = mix(c, uColor * 0.45, cone * 0.6);
      gl_FragColor = vec4(c, fadeIn);
      return;
    }
    // Out-of-focus branches fall back to a cool, desaturated membrane stain.
    vec3 col = mix(mix(tint * (1.0 + 0.8 * hot), vec3(0.09, 0.12, 0.22), uMute), uRootCol, rootK);
    float body = ((mix(0.12, 0.03, uMute) + mix(0.62, 0.5, uMute) * fr) * (0.68 + 0.48 * tex) * (0.9 + 0.12 * fib)
               + 0.07 * key * (1.0 - uMute)) * tipFade;
    body = mix(body, (0.015 + 0.36 * fr) * (0.62 + 0.55 * tex) * 0.6, rootK);
    vec3 c = col * uBase * body * (1.0 + 1.35 * uLevel * (1.0 - rootK))
           + (uColor * 1.4 + vec3(0.22)) * pulse
           + uColor * cone * 1.6;
    gl_FragColor = vec4(c, 1.0);
  }
`;

const SOMA_F = /* glsl */ `
  uniform vec3 uColor; uniform vec3 uInk; uniform float uFlash; uniform float uCharge; uniform float uShow; uniform float uLight;
  varying vec3 vN; varying vec3 vV; varying vec3 vPos;
  ${NOISE}
  void main() {
    float fr = pow(clamp(1.0 - abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0), 2.0);
    float tex = membraneTex(vPos * 0.8);
    if (uLight > 0.5) {
      float a = (0.08 + 0.72 * fr) * (0.8 + 0.35 * tex) * (0.85 + 0.35 * uCharge + 0.9 * uFlash);
      gl_FragColor = vec4(uInk, clamp(a, 0.0, 0.95) * uShow);
      return;
    }
    vec3 c = uColor * (0.02 + 0.42 * fr) * (0.62 + 0.55 * tex) * (0.55 + 0.55 * uCharge + 2.2 * uFlash);
    gl_FragColor = vec4(c * uShow, 1.0);
  }
`;

const MYELIN_F = /* glsl */ `
  uniform vec3 uColor; uniform vec3 uInk; uniform vec3 uGlowInk; uniform float uGlow; uniform float uShow; uniform float uLight;
  varying vec3 vN; varying vec3 vV; varying vec3 vPos; varying vec3 vObj;
  ${NOISE}
  void main() {
    float fr = pow(clamp(1.0 - abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0), 2.2);
    // Compact myelin lamellae: fine rings along the sheath.
    float rings = 0.5 + 0.5 * sin(vObj.y * 260.0 + vnoise3(vPos * 30.0) * 2.5);
    float tex = membraneTex(vPos);
    float lam = (0.82 + 0.28 * rings) * (0.78 + 0.35 * tex);
    if (uLight > 0.5) {
      float a = (0.05 + 0.5 * fr) * lam * uShow + uGlow * (0.4 + fr);
      gl_FragColor = vec4(mix(uInk, uGlowInk, clamp(uGlow * 2.5, 0.0, 1.0)), clamp(a, 0.0, 0.92));
      return;
    }
    vec3 c = uColor * (0.03 + 0.34 * fr) * lam * uShow + vec3(0.8, 0.9, 1.0) * uGlow * (0.2 + fr);
    gl_FragColor = vec4(c, 1.0);
  }
`;

// Synaptic puncta along the dendrites: the dotted look of an immunostain.
const PUNCTA_V = /* glsl */ `
  uniform float uLevel[5]; uniform float uMute[5]; uniform float uPulse[5]; uniform float uPulseAmp[5]; uniform vec3 uColL[5];
  uniform float uGrow; uniform float uPR; uniform float uTime; uniform float uBase; uniform float uLight;
  attribute float aDist; attribute float aSid; attribute float aPhase; attribute vec3 aColor;
  varying vec3 vC; varying float vI; varying float vShow;
  ${SWAY}
  void main() {
    int s = int(aSid + 0.5);
    float lv = 0.0, mu = 0.0, pu = -9.0, pa = 0.0;
    vec3 cl = aColor;
    for (int i = 0; i < 5; i++) { if (i == s) { lv = uLevel[i]; mu = uMute[i]; pu = uPulse[i]; pa = uPulseAmp[i]; cl = uColL[i]; } }
    float pulse = pa * exp(-((aDist - pu) / 0.14) * ((aDist - pu) / 0.14));
    float tw = 0.6 + 0.4 * sin(uTime * (0.8 + aPhase * 2.0) + aPhase * 31.0);
    vShow = step(aDist, uGrow);
    vC = uLight > 0.5 ? cl : aColor;
    vI = uBase * (0.3 + 0.4 * tw) * (1.0 + 1.8 * lv) * (1.0 - 0.9 * mu) + pulse * 2.6;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    wp.xyz += sway(wp.xyz);
    vec4 mv = viewMatrix * wp;
    gl_PointSize = uPR * (6.0 + 9.0 * pulse + 3.0 * lv) / -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;
const SOFT_F = /* glsl */ `
  uniform float uLight;
  varying vec3 vC; varying float vI; varying float vShow;
  void main() {
    if (vShow < 0.5) discard;
    vec2 p = gl_PointCoord - 0.5;
    float a = exp(-dot(p, p) * 16.0);
    if (a < 0.03) discard;
    if (uLight > 0.5) { gl_FragColor = vec4(vC, clamp(vI * 0.55, 0.0, 1.0) * a); return; }
    gl_FragColor = vec4(vC * vI * a, 1.0);
  }
`;

const VESICLE_V = /* glsl */ `
  attribute vec3 aVel; attribute float aDelay;
  uniform float uAge; uniform float uPR;
  varying float vA;
  ${SWAY}
  void main() {
    float t = max(0.0, uAge - aDelay);
    vec3 p = position + aVel * t * (1.0 - 0.45 * t);
    vA = step(aDelay, uAge) * max(0.0, 1.0 - t / 0.9);
    vec4 wp = modelMatrix * vec4(p, 1.0);
    wp.xyz += sway(wp.xyz);
    vec4 mv = viewMatrix * wp;
    gl_PointSize = uPR * 11.0 * (0.4 + vA) / -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;
const VESICLE_F = /* glsl */ `
  uniform vec3 uColor; uniform float uLight; varying float vA;
  void main() {
    if (vA <= 0.0) discard;
    vec2 q = gl_PointCoord - 0.5;
    float a = exp(-dot(q, q) * 14.0) * vA;
    if (uLight > 0.5) { gl_FragColor = vec4(uColor, a); return; }
    gl_FragColor = vec4((uColor * 1.6 + 0.25) * a, 1.0);
  }
`;

// Dendritic spines, instanced: one draw call for every spine on the cell.
const SPINE_V = /* glsl */ `
  attribute float aDist; attribute float aSid; attribute float aRnd;
  uniform float uLevel[6]; uniform float uMute[6]; uniform float uPulse[6]; uniform float uPulseAmp[6]; uniform vec3 uCol[6];
  uniform float uGrow;
  varying vec3 vC; varying float vLv; varying float vMute; varying float vPulse; varying float vShow;
  varying vec3 vN; varying vec3 vV; varying vec3 vPos; varying float vRnd;
  ${SWAY}
  void main() {
    int s = int(aSid + 0.5);
    vRnd = aRnd;
    vec3 col = vec3(0.5); float lv = 0.0, mu = 0.0, pu = -9.0, pa = 0.0;
    for (int i = 0; i < 6; i++) { if (i == s) { col = uCol[i]; lv = uLevel[i]; mu = uMute[i]; pu = uPulse[i]; pa = uPulseAmp[i]; } }
    vC = col; vLv = lv; vMute = mu;
    vPulse = pa * exp(-((aDist - pu) / 0.11) * ((aDist - pu) / 0.11));
    vShow = step(aDist, uGrow);
    vec4 wp = modelMatrix * (instanceMatrix * vec4(position, 1.0));
    vPos = wp.xyz;
    wp.xyz += sway(wp.xyz);
    vec4 mv = viewMatrix * wp;
    vN = normalize(normalMatrix * mat3(instanceMatrix) * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;
const SPINE_F = /* glsl */ `
  uniform float uLight; uniform float uBase;
  varying vec3 vC; varying float vLv; varying float vMute; varying float vPulse; varying float vShow;
  varying vec3 vN; varying vec3 vV; varying vec3 vPos; varying float vRnd;
  ${NOISE}
  void main() {
    if (vShow < 0.5) discard;
    vec3 N = normalize(vN);
    float fr = pow(clamp(1.0 - abs(dot(N, normalize(vV))), 0.0, 1.0), 1.3);
    float key = max(dot(N, ${KEY}), 0.0);
    vec3 tint = hueRot(vary(vC, vPos), vRnd * 0.35) * (0.75 + 0.55 * fract(vRnd * 7.31 + 0.5));
    if (uLight > 0.5) {
      vec3 col = mix(tint, vec3(0.6, 0.64, 0.72), vMute);
      vec3 c = col * (1.0 - 0.4 * fr) * (0.82 + 0.25 * key);
      gl_FragColor = vec4(mix(c, vec3(1.0), clamp(vPulse, 0.0, 1.0) * 0.8), 1.0);
      return;
    }
    vec3 col = mix(tint, vec3(0.09, 0.12, 0.22), vMute);
    float body = mix(0.16, 0.04, vMute) + mix(0.7, 0.5, vMute) * fr + 0.06 * key;
    gl_FragColor = vec4(col * uBase * body * (1.0 + 1.35 * vLv) + (vC * 1.4 + vec3(0.22)) * vPulse, 1.0);
  }
`;

// The surrounding network: monochrome cells, each with a faint signal looping through it.
const NET_V = /* glsl */ `
  attribute float aDist; attribute float aSeed; attribute float aMove;
  uniform float uTime; uniform float uMotion;
  varying float vDist; varying float vSeed; varying float vDepth; varying vec3 vN; varying vec3 vV;
  ${SWAY}
  void main() {
    vDist = aDist; vSeed = aSeed;
    vec3 p = position + aMove * uMotion * 0.07 * vec3(
      sin(uTime * 0.33 + position.y * 0.8 + aSeed * 20.0),
      cos(uTime * 0.29 + position.x * 0.7 + aSeed * 11.0),
      sin(uTime * 0.21 + aSeed * 5.0));
    vec4 wp = modelMatrix * vec4(p, 1.0);
    wp.xyz += (1.0 - aMove) * sway(wp.xyz);
    vec4 mv = viewMatrix * wp;
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;
const NET_F = /* glsl */ `
  uniform float uTime; uniform float uLight; uniform float uGrow; uniform float uMotion;
  uniform vec3 uGlow; uniform vec3 uInk;
  varying float vDist; varying float vSeed; varying float vDepth; varying vec3 vN; varying vec3 vV;
  void main() {
    if (vDist > uGrow) discard;
    float fr = pow(clamp(1.0 - abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0), 1.7);
    float fade = clamp(1.3 - vDepth / 13.0, 0.2, 1.0);
    float period = 6.0 + vSeed * 7.0;
    float head = mod(uTime * 1.1 + vSeed * 37.0, period) - 0.5;
    float pulse = uMotion * exp(-((vDist - head) / 0.16) * ((vDist - head) / 0.16));
    fade *= 0.55 + 0.9 * fract(vSeed * 7.13);
    if (uLight > 0.5) {
      float a = ((0.12 + 0.55 * fr) + pulse * 0.4) * fade;
      gl_FragColor = vec4(uInk, clamp(a, 0.0, 0.9));
      return;
    }
    vec3 c = (uGlow * (0.035 + 0.45 * fr) + vec3(0.85, 0.9, 1.0) * pulse * 0.28) * fade;
    gl_FragColor = vec4(c, 1.0);
  }
`;

// Neuropil: long axons crossing the whole field, each carrying an occasional glint.
const FIBER_V = /* glsl */ `
  attribute float aT; attribute float aSeed;
  uniform float uTime; uniform float uMotion;
  varying float vT; varying float vSeed; varying float vDepth;
  void main() {
    vT = aT; vSeed = aSeed;
    vec3 p = position + uMotion * 0.06 * vec3(sin(uTime * 0.25 + position.y * 0.6 + aSeed * 30.0), cos(uTime * 0.22 + position.x * 0.5 + aSeed * 12.0), 0.0);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;
const FIBER_F = /* glsl */ `
  uniform float uTime; uniform float uLight; uniform float uMotion; uniform float uShow;
  uniform vec3 uGlow; uniform vec3 uInk;
  varying float vT; varying float vSeed; varying float vDepth;
  void main() {
    float fade = clamp(1.25 - vDepth / 17.0, 0.15, 1.0) * smoothstep(0.0, 0.06, vT) * smoothstep(1.0, 0.94, vT) * uShow;
    float head = fract(uTime * (0.025 + vSeed * 0.04) + vSeed * 17.0);
    float glint = uMotion * exp(-((vT - head) * 24.0) * ((vT - head) * 24.0));
    float base = 0.25 + 0.3 * fract(vSeed * 13.7);
    if (uLight > 0.5) { gl_FragColor = vec4(uInk, (base * 0.6 + glint * 0.45) * fade); return; }
    gl_FragColor = vec4((uGlow * base + vec3(0.8, 0.9, 1.0) * glint * 0.8) * fade, 1.0);
  }
`;

// Particles that wrap around the camera, so every view is full edge to edge.
const DUST_V = /* glsl */ `
  attribute float aSeed; attribute float aSize;
  uniform float uTime; uniform vec3 uCam; uniform vec3 uBox; uniform float uPR; uniform float uMotion; uniform float uShow;
  varying float vA;
  void main() {
    vec3 drift = vec3(sin(uTime * 0.11 + aSeed * 31.0), cos(uTime * 0.09 + aSeed * 17.0), sin(uTime * 0.07 + aSeed * 7.0)) * 0.4
               + vec3(uTime * 0.05, uTime * 0.018, 0.0);
    vec3 c = uCam + vec3(0.0, 0.0, -uBox.z * 0.38);
    vec3 p = mod(position + uMotion * drift - c + uBox * 0.5, uBox) + c - uBox * 0.5;
    vec3 rel = abs(p - c) / uBox;
    float edge = 1.0 - smoothstep(0.4, 0.5, max(max(rel.x, rel.y), rel.z));
    vec4 mv = viewMatrix * vec4(p, 1.0);
    float d = -mv.z;
    vA = smoothstep(0.3, 1.2, d) * edge * uShow * (0.6 + 0.4 * sin(uTime * (0.5 + fract(aSeed * 9.0)) + aSeed * 40.0));
    gl_PointSize = uPR * aSize / max(d, 0.1);
    gl_Position = projectionMatrix * mv;
  }
`;
const DUST_F = /* glsl */ `
  uniform float uLight; uniform vec3 uColor; uniform float uAlpha;
  varying float vA;
  void main() {
    vec2 q = gl_PointCoord - 0.5;
  #ifdef BOKEH
    float r = length(q);
    float a = (smoothstep(0.5, 0.4, r) * 0.6 + smoothstep(0.5, 0.45, r) * smoothstep(0.36, 0.46, r) * 0.4) * vA;
  #else
    float a = exp(-dot(q, q) * 14.0) * vA;
  #endif
    if (a < 0.004) discard;
    if (uLight > 0.5) { gl_FragColor = vec4(uColor, a * uAlpha); return; }
    gl_FragColor = vec4(uColor * a * uAlpha, 1.0);
  }
`;

// Small solid bodies (nucleus, nodes of Ranvier, boutons): glowing in dark, shaded pigment in light.
const BLOB_F = /* glsl */ `
  uniform vec3 uColor; uniform float uK; uniform float uLight; uniform vec3 uBg; uniform float uTex;
  varying vec3 vN; varying vec3 vV; varying vec3 vPos;
  ${NOISE}
  void main() {
    float fr = pow(clamp(1.0 - abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0), 1.6);
    // uTex = 1 on the nucleus: clumped chromatin.
    float chrom = mix(1.0, 0.42 + 0.95 * membraneTex(vPos * 0.7), uTex);
    if (uLight > 0.5) {
      vec3 c = mix(uColor, uColor * 0.55, fr) * mix(1.0, 0.82 + 0.28 * chrom, uTex);
      gl_FragColor = vec4(mix(uBg, c, clamp(uK, 0.0, 1.0)), 1.0);
      return;
    }
    gl_FragColor = vec4(uColor * uK * (0.75 + 0.5 * fr) * chrom, 1.0);
  }
`;

const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending };

// Tube whose radius follows rFn(u), with path distance from the soma baked in as aDist.
function tube(curve, seg, rad, rFn, d0, len) {
  const g = new THREE.TubeGeometry(curve, seg, 1, rad, false);
  const pa = g.attributes.position;
  const dist = new Float32Array(pa.count);
  const c = new THREE.Vector3(), v = new THREE.Vector3();
  for (let i = 0; i <= seg; i++) {
    const u = i / seg;
    curve.getPointAt(u, c);
    const r = rFn(u);
    for (let j = 0; j <= rad; j++) {
      const k = i * (rad + 1) + j;
      v.fromBufferAttribute(pa, k).sub(c).multiplyScalar(r).add(c);
      pa.setXYZ(k, v.x, v.y, v.z);
      dist[k] = d0 + u * len;
    }
  }
  g.setAttribute('aDist', new THREE.BufferAttribute(dist, 1));
  g.computeBoundingSphere();
  return g;
}

function softDot() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const C = (hex) => new THREE.Color(hex);
const PALETTES = {
  dark: {
    bg: C('#030407'), dapi: C('#4f8dff'), nucleolus: C('#c6d8ff'), cyan: C('#46d9e6'), soma: C('#e4eaff'),
    axon: C('#b9c6e2'), deco: C('#8592b4'), post: C('#8d97ad'), myelin: C('#e3eaf8'), ink: C('#3b4a6b'),
    glowInk: C('#2a5fd6'), net: C('#9aa3b8'), netInk: C('#5d6679'),
    line: C('#33447a'), lineOpacity: 0.55, culture: C('#3c5296'), dust: C('#8fa3d6'), dustOpacity: 0.95,
    bokeh: C('#6f86c4'), bokehOpacity: 0.2, fiber: C('#5a6c9e'), fiberInk: C('#8b93a6'),
  },
  light: {
    bg: C('#eef1f5'), dapi: C('#2a5fd6'), nucleolus: C('#173c99'), cyan: C('#0a8f9e'), soma: C('#e4eaff'),
    axon: C('#76829c'), deco: C('#9aa3b6'), post: C('#b3bbca'), myelin: C('#e3eaf8'), ink: C('#2e3a55'),
    glowInk: C('#1f56d0'), net: C('#9aa3b8'), netInk: C('#4a5366'),
    line: C('#9aa2b3'), lineOpacity: 0.32, culture: C('#8c95a8'), dust: C('#6d778b'), dustOpacity: 0.5,
    bokeh: C('#8a93a8'), bokehOpacity: 0.12, fiber: C('#5a6c9e'), fiberInk: C('#9aa2b3'),
  },
};

// ---------- build

export function createNeuron({ inputs, nNodes, small, pr }) {
  const R = rng(19);
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const root = new THREE.Group();
  const targets = [];
  const SOMA = V(-1.0, 0.05, 0);
  const N = inputs.length;
  const maxDepth = small ? 2 : 3;
  const radSeg = small ? 6 : 8;
  const DEF = { DETAIL: small ? 1 : 2 };
  const uLight = { value: 0 };
  const glowMats = [];
  const glow = (m) => (glowMats.push(m), m);
  let pal = PALETTES.dark;

  const dendMat = (color) => new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: color.clone() }, uLevel: { value: 0 }, uBase: { value: 1 }, uMute: { value: 0 },
      uPulse: { value: -9 }, uPulseAmp: { value: 0 }, uGrow: { value: 0 }, uLight,
      uRootOn: { value: 0 }, uRootCol: { value: PALETTES.dark.soma.clone() }, uInside: { value: 0 },
    },
    vertexShader: DEND_V,
    fragmentShader: DEND_F,
    defines: DEF,
  });

  const uBg = { value: PALETTES.dark.bg.clone() };
  const blobMat = (color) => new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color.clone() }, uK: { value: 1 }, uLight, uBg, uTex: { value: 0 } },
    vertexShader: RIM_V,
    fragmentShader: BLOB_F,
    defines: DEF,
  });

  const dmats = inputs.map((s) => dendMat(C(s.color)));
  const decoMat = dendMat(pal.deco);
  const rootMats = [...dmats, decoMat]; // the axon joins this list once it exists
  const ROOT_LIGHT = C('#c3cad8');
  const maxD = new Array(N).fill(0);
  const outDir = [];
  const leafTips = inputs.map(() => []);
  const pP = [], pD = [], pS = [], pPh = [], pC = [];
  const geos = Array.from({ length: N + 1 }, () => []); // per section, plus one for the unlabeled dendrites
  const spines = []; // { m: Matrix4, dist, sid }
  const sm = new THREE.Matrix4(), sq = new THREE.Quaternion(), ss = new THREE.Vector3();
  const UP = V(0, 1, 0);

  // One branch segment, then its children. Paths meander at two scales, thickness beads along the
  // length, trunks flare where they leave the soma, and spines stud everything past the trunk.
  function grow(start, dir, len, r, depth, sid, d0, out, maxDep) {
    const steps = 6;
    const pts = [start.clone()];
    const p = start.clone(), d = dir.clone();
    for (let k = 1; k <= steps; k++) {
      d.x += (R() - 0.5) * 0.32; d.y += (R() - 0.5) * 0.32; d.z += (R() - 0.5) * 0.24;
      d.normalize();
      p.addScaledVector(d, len / steps);
      const q = p.clone();
      if (k < steps) q.add(V(R() - 0.5, R() - 0.5, R() - 0.5).multiplyScalar(len * 0.04));
      pts.push(q);
    }
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const L = curve.getLength();
    const seed = R() * 100;
    const rFn = (u) => {
      const dist = u * L;
      let rr = r * (1 - 0.34 * u);
      if (depth === 0) rr *= 1 + 0.8 * Math.exp(-dist / 0.14);
      return rr * (1 + (0.1 + 0.05 * depth) * (vnoise(dist * 14 + seed, seed, 0) - 0.5) * 2);
    };
    const bucket = sid >= 0 ? sid : N;
    geos[bucket].push(tube(curve, Math.max(8, Math.round(L * (small ? 26 : 44))), radSeg, rFn, d0, L));
    if (sid >= 0) {
      maxD[sid] = Math.max(maxD[sid], d0 + L);
      if (depth === maxDep) leafTips[sid].push(p.clone());
    }

    // Spines: sparse on the trunk, dense on the branches. A third carry a synaptic punctum on the head.
    const density = (depth === 0 ? 9 : 28) * (small ? 0.55 : 1) * (sid >= 0 ? 1 : 0.6);
    const ns = Math.round(L * density);
    for (let k = 0; k < ns; k++) {
      const u = 0.06 + R() * 0.92;
      if (depth === 0 && u * L < 0.32) continue; // no spines on the root inside the soma
      const c = curve.getPointAt(u), tan = curve.getTangentAt(u);
      const side = V(R() - 0.5, R() - 0.5, R() - 0.5).cross(tan).normalize();
      const base = c.clone().addScaledVector(side, rFn(u) * 0.85);
      const sdir = side.clone().addScaledVector(tan, (R() - 0.5) * 0.7).normalize();
      const len = 0.022 + R() * 0.026;
      const fat = 0.7 + R() * 0.5;
      sq.setFromUnitVectors(UP, sdir);
      ss.set(len * fat, len, len * fat);
      sm.compose(base, sq, ss);
      spines.push({ m: sm.clone(), dist: d0 + u * L, sid: bucket });
      if (sid >= 0 && R() < 0.22) {
        const head = base.clone().addScaledVector(sdir, len * 0.95);
        pP.push(head.x, head.y, head.z); pD.push(d0 + u * L); pS.push(sid); pPh.push(R());
        const pc = cols[sid].clone().offsetHSL((R() - 0.5) * 0.08, (R() - 0.5) * 0.2, 0).multiplyScalar(0.7 + R() * 0.6);
        pC.push(pc.r, pc.g, pc.b);
      }
    }

    if (depth < maxDep) {
      // A small blob at the branch point hides the seam where the children leave.
      const j = new THREE.SphereGeometry(rFn(1) * 1.08, 10, 8);
      j.translate(p.x, p.y, p.z);
      j.setAttribute('aDist', new THREE.BufferAttribute(new Float32Array(j.attributes.position.count).fill(d0 + L), 1));
      geos[bucket].push(j);
      const kids = depth === 0 ? 3 : 2;
      for (let c = 0; c < kids; c++) {
        const axis = V(R() - 0.5, R() - 0.5, R() - 0.5).cross(d).normalize();
        const nd = d.clone().applyAxisAngle(axis, (0.3 + R() * 0.4) * (c % 2 ? 1 : -1));
        if (nd.dot(out) < 0.2) nd.lerp(out, 0.6).normalize();
        grow(p, nd, len * (0.62 + R() * 0.14), rFn(1) / (1 + 0.1), depth + 1, sid, d0 + L, out, maxDep);
      }
    }
  }

  // Five section dendrites fan out to the left; four unlabeled ones make it read as a real cell.
  const cols = inputs.map((s) => C(s.color));
  const angles = [128, 156, 184, 212, 240];
  inputs.forEach((s, i) => {
    const a = THREE.MathUtils.degToRad(angles[i] + (R() - 0.5) * 6);
    const out = V(Math.cos(a), Math.sin(a), (R() - 0.5) * 0.5).normalize();
    outDir[i] = out;
    grow(SOMA.clone().addScaledVector(out, 0.235), out, 0.76 + R() * 0.12, 0.075, 0, i, 0, out, maxDepth);
  });
  const decoDirs = [];
  [[94, 0.95, 0.06], [266, 0.5, 0.045], [302, 0.38, 0.04], [62, 0.42, 0.045]].forEach(([deg, len, r]) => {
    const a = THREE.MathUtils.degToRad(deg);
    const out = V(Math.cos(a), Math.sin(a), (R() - 0.5) * 0.6).normalize();
    decoDirs.push(out);
    grow(SOMA.clone().addScaledVector(out, 0.22), out, len + 0.06, r, 0, -1, 0, out, small ? 1 : 2);
  });

  // Merge each section into one mesh: one draw call per branch system.
  inputs.forEach((s, i) => {
    const m = new THREE.Mesh(mergeGeometries(geos[i], false), dmats[i]);
    m.userData.key = s.id;
    root.add(m);
    targets.push(m);
  });
  root.add(new THREE.Mesh(mergeGeometries(geos[N], false), decoMat));
  geos.flat().forEach((g) => g.dispose());

  const spineGeo = (() => {
    const neck = new THREE.CylinderGeometry(0.11, 0.16, 0.78, 7, 1, true);
    neck.translate(0, 0.39, 0);
    const head = new THREE.SphereGeometry(0.3, 10, 8);
    head.scale(1, 0.82, 1);
    head.translate(0, 0.92, 0);
    return mergeGeometries([neck, head], false);
  })();
  const spineDist = new Float32Array(spines.length), spineSid = new Float32Array(spines.length), spineRnd = new Float32Array(spines.length);
  spines.forEach((sp, i) => { spineDist[i] = sp.dist; spineSid[i] = sp.sid; spineRnd[i] = R() * 2 - 1; });
  spineGeo.setAttribute('aRnd', new THREE.InstancedBufferAttribute(spineRnd, 1));
  spineGeo.setAttribute('aDist', new THREE.InstancedBufferAttribute(spineDist, 1));
  spineGeo.setAttribute('aSid', new THREE.InstancedBufferAttribute(spineSid, 1));
  const spineMat = new THREE.ShaderMaterial({
    uniforms: {
      uLevel: { value: [0, 0, 0, 0, 0, 0] }, uMute: { value: [0, 0, 0, 0, 0, 0] },
      uPulse: { value: [-9, -9, -9, -9, -9, -9] }, uPulseAmp: { value: [0, 0, 0, 0, 0, 0] },
      uCol: { value: [...cols.map((c) => c.clone()), pal.deco.clone()] },
      uGrow: { value: 0 }, uBase: { value: 1 }, uLight,
    },
    vertexShader: SPINE_V, fragmentShader: SPINE_F, defines: DEF,
  });
  const spineMesh = new THREE.InstancedMesh(spineGeo, spineMat, spines.length);
  spines.forEach((sp, i) => spineMesh.setMatrixAt(i, sp.m));
  spineMesh.instanceMatrix.needsUpdate = true;
  spineMesh.frustumCulled = false;
  root.add(spineMesh);

  const punctaGeo = new THREE.BufferGeometry();
  punctaGeo.setAttribute('position', new THREE.Float32BufferAttribute(pP, 3));
  punctaGeo.setAttribute('aDist', new THREE.Float32BufferAttribute(pD, 1));
  punctaGeo.setAttribute('aSid', new THREE.Float32BufferAttribute(pS, 1));
  punctaGeo.setAttribute('aPhase', new THREE.Float32BufferAttribute(pPh, 1));
  punctaGeo.setAttribute('aColor', new THREE.Float32BufferAttribute(pC, 3));
  const punctaMat = glow(new THREE.ShaderMaterial({
    uniforms: {
      uLevel: { value: [0, 0, 0, 0, 0] }, uMute: { value: [0, 0, 0, 0, 0] }, uPulse: { value: [-9, -9, -9, -9, -9] },
      uPulseAmp: { value: [0, 0, 0, 0, 0] }, uColL: { value: inputs.map((s) => C(s.light)) },
      uGrow: { value: 0 }, uPR: { value: pr }, uTime: { value: 0 }, uBase: { value: 1 }, uLight,
    },
    vertexShader: PUNCTA_V, fragmentShader: SOFT_F, ...additive,
  }));
  root.add(new THREE.Points(punctaGeo, punctaMat));

  // Soma: a pyramidal teardrop pulled toward the axon hillock, bulging where dendrites leave.
  const sg = new THREE.SphereGeometry(0.3, small ? 72 : 112, small ? 48 : 72);
  const sp = sg.attributes.position;
  const n = new THREE.Vector3();
  for (let i = 0; i < sp.count; i++) {
    n.fromBufferAttribute(sp, i).normalize();
    let s = 1 + 0.45 * Math.pow(Math.max(0, n.x), 4);
    // Each dendrite leaves through a tapering root of membrane instead of a hard junction.
    for (const o of outDir) s += 0.62 * Math.pow(clamp((n.dot(o) - 0.82) / 0.18, 0, 1), 2.4);
    for (const o of decoDirs) s += 0.4 * Math.pow(clamp((n.dot(o) - 0.87) / 0.13, 0, 1), 2.4);
    s += 0.055 * (vnoise(n.x * 4 + 2, n.y * 4, n.z * 4) - 0.5)
       + 0.018 * (vnoise(n.x * 11 + 7, n.y * 11, n.z * 11) - 0.5)
       + 0.007 * (vnoise(n.x * 27 + 3, n.y * 27, n.z * 27) - 0.5);
    sp.setXYZ(i, n.x * 0.3 * s, n.y * 0.3 * s, n.z * 0.3 * s);
  }
  sg.computeVertexNormals();
  const somaMat = glow(new THREE.ShaderMaterial({
    uniforms: { uColor: { value: pal.soma.clone() }, uInk: { value: pal.ink.clone() }, uFlash: { value: 0 }, uCharge: { value: 0 }, uShow: { value: 0 }, uLight },
    vertexShader: RIM_V, fragmentShader: SOMA_F, defines: DEF, ...additive,
  }));
  const soma = new THREE.Mesh(sg, somaMat);
  soma.position.copy(SOMA);
  soma.userData.key = 'soma';
  root.add(soma);
  targets.push(soma);

  const nucMat = blobMat(pal.dapi);
  nucMat.uniforms.uTex.value = 1;
  const ng = new THREE.SphereGeometry(0.11, 48, 32);
  const np_ = ng.attributes.position;
  for (let i = 0; i < np_.count; i++) {
    n.fromBufferAttribute(np_, i).normalize();
    const k = 0.11 * (1 + 0.06 * (vnoise(n.x * 5 + 9, n.y * 5, n.z * 5) - 0.5));
    np_.setXYZ(i, n.x * k * 1.06, n.y * k * 0.95, n.z * k);
  }
  ng.computeVertexNormals();
  const nuc = new THREE.Mesh(ng, nucMat);
  nuc.position.copy(SOMA).add(V(-0.03, 0.01, 0));
  root.add(nuc);
  const nuclMat = blobMat(pal.nucleolus);
  const nucl = new THREE.Mesh(new THREE.SphereGeometry(0.032, 20, 14), nuclMat);
  nucl.position.copy(nuc.position).add(V(0.035, 0.03, 0.06));
  root.add(nucl);
  const nucl2 = new THREE.Mesh(new THREE.SphereGeometry(0.019, 16, 12), nuclMat);
  nucl2.position.copy(nuc.position).add(V(-0.04, -0.035, 0.065));
  root.add(nucl2);

  // Axon with a flared hillock, myelin sleeves, and one node of Ranvier per award.
  const ax = new THREE.CatmullRomCurve3(
    [V(-0.78, 0.05, 0), V(-0.25, 0.08, 0.02), V(0.5, -0.06, 0.05), V(1.3, 0.08, -0.03), V(2.0, -0.03, 0.02), V(2.4, 0.02, 0)],
    false, 'centripetal',
  );
  const AL = ax.getLength();
  const axMat = dendMat(pal.axon);
  const hill = (u) => 0.026 + 0.095 * Math.exp(-u * 17);
  const axGeos = [tube(ax, small ? 80 : 120, 12, hill, 0, AL)];
  rootMats.push(axMat);
  rootMats.forEach((m) => { m.uniforms.uRootOn.value = 1; });
  dmats.forEach((m) => { m.uniforms.uInside.value = 0.09; });
  decoMat.uniforms.uInside.value = 0.07;
  axMat.uniforms.uInside.value = 0.1;
  const axon = new THREE.Mesh(axGeos[0], axMat);
  axon.userData.key = 'axon';
  root.add(axon);
  targets.push(axon);

  const nSeg = nNodes - 1;
  const s0 = AL * 0.16, s1 = AL * 0.94, pitch = (s1 - s0) / nSeg, gap = 0.075, mr = 0.068;
  const nodeS = [], nodeMats = [], myelin = [];
  const nodeGeo = new THREE.SphereGeometry(0.036, 16, 12);
  for (let k = 0; k < nNodes; k++) {
    const s = s0 + k * pitch;
    nodeS.push(s);
    const nm = blobMat(C('#ffffff'));
    const node = new THREE.Mesh(nodeGeo, nm);
    node.position.copy(ax.getPointAt(s / AL));
    root.add(node);
    nodeMats.push(nm);
  }
  // Collaterals branch off at nodes of Ranvier, as real axons do.
  [[1, 1], [3, -1]].filter(([k]) => k < nNodes).forEach(([k, side]) => {
    const at = nodeS[k];
    const o = ax.getPointAt(at / AL), t = ax.getTangentAt(at / AL);
    const d = V(0, side, (R() - 0.5) * 0.5).addScaledVector(t, 0.55).normalize();
    const pts = [o.clone()];
    const p = o.clone();
    for (let i = 0; i < 5; i++) {
      d.x += (R() - 0.5) * 0.3; d.y += (R() - 0.5) * 0.3; d.normalize();
      p.addScaledVector(d, 0.16);
      pts.push(p.clone());
    }
    const c = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    axGeos.push(tube(c, 30, 6, (u) => 0.0085 - 0.0035 * u, at, c.getLength()));
  });
  axon.geometry = mergeGeometries(axGeos, false);
  axGeos.forEach((g) => g.dispose());

  for (let k = 0; k < nSeg; k++) {
    const a = nodeS[k] + gap / 2, b = nodeS[k + 1] - gap / 2, mid = (a + b) / 2;
    const mat = glow(new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: pal.myelin.clone() }, uInk: { value: pal.ink.clone() }, uGlowInk: { value: pal.glowInk.clone() },
        uGlow: { value: 0 }, uShow: { value: 0 }, uLight,
      },
      vertexShader: RIM_V, fragmentShader: MYELIN_F, defines: DEF, ...additive,
    }));
    const capGeo = new THREE.CapsuleGeometry(mr, Math.max(0.01, b - a - 2 * mr), 8, 22, 8);
    const half = (b - a) / 2;
    const cp = capGeo.attributes.position;
    for (let i = 0; i < cp.count; i++) {
      const y = cp.getY(i);
      const bulge = 1 + 0.09 * (1 - Math.min(1, (y / half) ** 2)) + 0.05 * (vnoise(y * 9 + k * 3, cp.getX(i) * 20, cp.getZ(i) * 20) - 0.5);
      cp.setX(i, cp.getX(i) * bulge);
      cp.setZ(i, cp.getZ(i) * bulge);
    }
    capGeo.computeVertexNormals();
    const cap = new THREE.Mesh(capGeo, mat);
    cap.position.copy(ax.getPointAt(mid / AL));
    cap.quaternion.setFromUnitVectors(V(0, 1, 0), ax.getTangentAt(mid / AL));
    cap.userData.key = 'axon';
    root.add(cap);
    targets.push(cap);
    myelin.push({ mat, mesh: cap, a, b });
  }

  // Axon terminal: five boutons facing the next cell's dendrite across the cleft.
  const end = ax.getPointAt(1);
  const termMat = dendMat(pal.cyan);
  const boutons = [], bMats = [], bAt = [];
  let termEnd = AL;
  for (let i = 0; i < 5; i++) {
    const a = (i - 2) * 0.34 + (R() - 0.5) * 0.12;
    const d = V(Math.cos(a), Math.sin(a), (R() - 0.5) * 0.6).normalize();
    const len = 0.26 + R() * 0.1;
    const tip = end.clone().addScaledVector(d, len);
    const c = new THREE.CatmullRomCurve3([end.clone(), end.clone().addScaledVector(d, len * 0.5).add(V(0, (R() - 0.5) * 0.05, 0)), tip]);
    const L = c.getLength();
    const m = new THREE.Mesh(tube(c, 12, 7, (u) => 0.024 - 0.006 * u, AL, L), termMat);
    m.userData.key = 'synapse';
    root.add(m);
    targets.push(m);
    const bm = blobMat(pal.cyan);
    const bg_ = new THREE.SphereGeometry(0.068, 24, 16);
    const bp = bg_.attributes.position;
    for (let k = 0; k < bp.count; k++) {
      n.fromBufferAttribute(bp, k).normalize();
      const rr = 0.068 * (1 + 0.14 * (vnoise(n.x * 3 + i * 5, n.y * 3, n.z * 3) - 0.5)) * (1 + 0.18 * Math.max(0, n.dot(d)));
      bp.setXYZ(k, n.x * rr, n.y * rr, n.z * rr);
    }
    bg_.computeVertexNormals();
    const bo = new THREE.Mesh(bg_, bm);
    bo.position.copy(tip).addScaledVector(d, 0.035);
    bo.userData.key = 'synapse';
    root.add(bo);
    targets.push(bo);
    boutons.push(bo.position.clone());
    bMats.push(bm);
    bAt.push(AL + L);
    termEnd = Math.max(termEnd, AL + L + 0.05);
  }

  // The next cell: a small neuron below and right of the terminal. One of its dendrites runs up past the
  // boutons (the receptors sit on it); three shorter ones and a thin axon leave its soma. Monochrome, like
  // the network, and it brightens a little when the terminal releases.
  const Rp = rng(911);
  const PS = V(3.62, -0.66, -0.12), PR = 0.16;
  const postGeos = [];
  const psg = new THREE.SphereGeometry(PR, 40, 28);
  const psp = psg.attributes.position;
  const toRecv = V(-0.6, 0.8, 0).normalize();
  for (let i = 0; i < psp.count; i++) {
    n.fromBufferAttribute(psp, i).normalize();
    const k = PR * (1 + 0.12 * (vnoise(n.x * 3 + 4, n.y * 3, n.z * 3) - 0.5) + 0.35 * Math.pow(Math.max(0, n.dot(toRecv)), 3));
    psp.setXYZ(i, n.x * k, n.y * k, n.z * k);
  }
  psg.computeVertexNormals();
  // Its soma uses the main soma's membrane material, so it reads as a cell body rather than a bright knot.
  const postSomaMat = glow(new THREE.ShaderMaterial({
    uniforms: { uColor: { value: pal.post.clone() }, uInk: { value: pal.ink.clone() }, uFlash: { value: 0 }, uCharge: { value: 0.35 }, uShow: { value: 1 }, uLight },
    vertexShader: RIM_V, fragmentShader: SOMA_F, defines: DEF, ...additive,
  }));
  const postSoma = new THREE.Mesh(psg, postSomaMat);
  postSoma.position.copy(PS);
  postSoma.userData.key = 'synapse';
  root.add(postSoma);
  targets.push(postSoma);
  const post = new THREE.CatmullRomCurve3(
    [PS.clone().addScaledVector(toRecv, PR * 1.1), V(3.3, -0.3, 0.02), V(3.02, 0.02, 0.05), V(2.97, 0.42, 0.02), V(3.05, 0.82, -0.04), V(3.16, 1.12, -0.08)],
    false, 'centripetal',
  );
  postGeos.push(tube(post, 48, 10, (u) => 0.011 + 0.045 * Math.pow(1 - u, 1.5), 0, post.getLength()));
  const postBranch = (from, dir, len, r0, depth) => {
    const pts = [from.clone()], p = from.clone(), d = dir.clone().normalize();
    for (let k = 1; k <= 4; k++) {
      d.x += (Rp() - 0.5) * 0.35; d.y += (Rp() - 0.5) * 0.35; d.z += (Rp() - 0.5) * 0.2;
      d.normalize();
      pts.push(p.addScaledVector(d, len / 4).clone());
    }
    const c = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    postGeos.push(tube(c, 20, 8, (u) => r0 * (1 - 0.6 * u), 0, c.getLength()));
    if (depth < 1) for (const side of [-1, 1]) postBranch(p, d.clone().applyAxisAngle(V(0, 0, 1), side * (0.35 + Rp() * 0.25)), len * 0.55, r0 * 0.4, depth + 1);
  };
  [[V(0.5, 0.85, 0.1), 0.5], [V(1, 0.1, -0.1), 0.42], [V(0.25, -1, 0.05), 0.5], [V(-0.6, -0.8, 0.1), 0.46]].forEach(([d, len]) =>
    postBranch(PS.clone().addScaledVector(d.clone().normalize(), PR * 0.98), d, len, 0.036, 0));
  const pAxDir = V(0.82, -0.57, 0), pa0 = PS.clone().addScaledVector(pAxDir, PR * 0.98);
  const pAx = new THREE.CatmullRomCurve3([pa0, pa0.clone().addScaledVector(pAxDir, 0.5).add(V(0, 0.05, 0)), pa0.clone().addScaledVector(pAxDir, 1.0).add(V(0.05, -0.04, 0)), pa0.clone().addScaledVector(pAxDir, 1.6)]);
  postGeos.push(tube(pAx, 30, 8, (u) => 0.011 + 0.022 * Math.exp(-u * 10), 0, pAx.getLength()));
  const postMat = glow(dendMat(pal.post));
  Object.assign(postMat, additive);
  postMat.uniforms.uGrow.value = 99;
  const postMesh = new THREE.Mesh(mergeGeometries(postGeos, false), postMat);
  postGeos.forEach((g) => g.dispose());
  postMesh.userData.key = 'synapse';
  root.add(postMesh);
  targets.push(postMesh);
  const postNucMat = blobMat(pal.dapi);
  const postNuc = new THREE.Mesh(new THREE.SphereGeometry(0.066, 24, 16), postNucMat);
  postNuc.position.copy(PS).add(V(0.01, -0.01, 0.03));
  root.add(postNuc);
  // Where the receiving dendrite passes closest to the boutons, and how much of it they face.
  const bc = boutons.reduce((a, b) => a.add(b), V(0, 0, 0)).multiplyScalar(1 / boutons.length);
  let uMid = 0, uBest = 1e9;
  for (let i = 0; i <= 120; i++) { const dd = post.getPointAt(i / 120).distanceTo(bc); if (dd < uBest) { uBest = dd; uMid = i / 120; } }
  const ys = boutons.map((b) => b.y);
  const uSpan = ((Math.max(...ys) - Math.min(...ys)) / 2 + 0.06) / post.getLength();

  const recP = [], recC = [], recD = [], recS = [], recPh = [];
  for (let k = 0; k < 46; k++) {
    // Receptors on the face of the dendrite opposite the boutons.
    const u = clamp(uMid + (R() - 0.5) * 2 * uSpan, 0, 1);
    const c = post.getPointAt(u);
    c.addScaledVector(bc.clone().sub(c).setZ(0).normalize(), 0.045).add(V(0, 0, (R() - 0.5) * 0.1));
    recP.push(c.x, c.y, c.z); recC.push(pal.cyan.r, pal.cyan.g, pal.cyan.b); recD.push(0); recS.push(0); recPh.push(R());
  }
  const recGeo = new THREE.BufferGeometry();
  recGeo.setAttribute('position', new THREE.Float32BufferAttribute(recP, 3));
  recGeo.setAttribute('aColor', new THREE.Float32BufferAttribute(recC, 3));
  recGeo.setAttribute('aDist', new THREE.Float32BufferAttribute(recD, 1));
  recGeo.setAttribute('aSid', new THREE.Float32BufferAttribute(recS, 1));
  recGeo.setAttribute('aPhase', new THREE.Float32BufferAttribute(recPh, 1));
  const recMat = glow(new THREE.ShaderMaterial({
    uniforms: {
      uLevel: { value: [0, 0, 0, 0, 0] }, uMute: { value: [0, 0, 0, 0, 0] }, uPulse: { value: [0, -9, -9, -9, -9] },
      uPulseAmp: { value: [0, 0, 0, 0, 0] }, uColL: { value: inputs.map(() => PALETTES.light.cyan.clone()) },
      uGrow: { value: 1 }, uPR: { value: pr }, uTime: { value: 0 }, uBase: { value: 0 }, uLight,
    },
    vertexShader: PUNCTA_V, fragmentShader: SOFT_F, ...additive,
  }));
  root.add(new THREE.Points(recGeo, recMat));

  const VN = 150;
  const vo = new Float32Array(VN * 3), vv = new Float32Array(VN * 3), vd = new Float32Array(VN);
  for (let i = 0; i < VN; i++) {
    const b = boutons[i % boutons.length];
    vo.set([b.x + (R() - 0.5) * 0.05, b.y + (R() - 0.5) * 0.05, b.z + (R() - 0.5) * 0.05], i * 3);
    vv.set([0.3 + R() * 0.3, (R() - 0.5) * 0.25, (R() - 0.5) * 0.25], i * 3);
    vd[i] = R() * 0.25;
  }
  const vesGeo = new THREE.BufferGeometry();
  vesGeo.setAttribute('position', new THREE.BufferAttribute(vo, 3));
  vesGeo.setAttribute('aVel', new THREE.BufferAttribute(vv, 3));
  vesGeo.setAttribute('aDelay', new THREE.BufferAttribute(vd, 1));
  const vesMat = glow(new THREE.ShaderMaterial({
    uniforms: { uAge: { value: 9 }, uPR: { value: pr }, uColor: { value: pal.cyan.clone() }, uLight },
    vertexShader: VESICLE_V, fragmentShader: VESICLE_F, ...additive,
  }));
  const ves = new THREE.Points(vesGeo, vesMat);
  ves.frustumCulled = false;
  root.add(ves);

  // ---------- the network around the cell: monochrome neurons, some wired into it

  const Rn = rng(303);
  const netGeos = [];
  const nTub = small ? 8 : 10;
  let moveNow = 0; // 1 while building free-floating field cells, 0 for cells wired into the main one
  function tag(g, seed, dist) {
    const count = g.attributes.position.count;
    if (!g.attributes.aDist) g.setAttribute('aDist', new THREE.BufferAttribute(new Float32Array(count).fill(dist || 0), 1));
    g.setAttribute('aSeed', new THREE.BufferAttribute(new Float32Array(count).fill(seed), 1));
    g.setAttribute('aMove', new THREE.BufferAttribute(new Float32Array(count).fill(moveNow), 1));
    g.deleteAttribute('uv');
    netGeos.push(g);
  }
  function netGrow(start, dir, len, r, depth, maxDep, d0, seed) {
    const pts = [start.clone()];
    const p = start.clone(), d = dir.clone();
    for (let k = 1; k <= 5; k++) {
      d.x += (Rn() - 0.5) * 0.42; d.y += (Rn() - 0.5) * 0.42; d.z += (Rn() - 0.5) * 0.3;
      d.normalize();
      p.addScaledVector(d, len / 5);
      pts.push(k < 5 ? p.clone().add(V(Rn() - 0.5, Rn() - 0.5, Rn() - 0.5).multiplyScalar(len * 0.04)) : p.clone());
    }
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const L = curve.getLength();
    const bs = Rn() * 100;
    tag(tube(curve, nTub + 2, 5, (u) => r * (1 - 0.35 * u) * (1 + 0.14 * (vnoise(u * L * 12 + bs, bs, 0) - 0.5) * 2), d0, L), seed);
    if (depth < maxDep) {
      for (let c = 0; c < 2; c++) {
        const axis = V(Rn() - 0.5, Rn() - 0.5, Rn() - 0.5).cross(d).normalize();
        const nd = d.clone().applyAxisAngle(axis, (0.35 + Rn() * 0.4) * (c ? 1 : -1));
        netGrow(p, nd, len * (0.62 + Rn() * 0.15), r * 0.7, depth + 1, maxDep, d0 + L, seed);
      }
    }
  }
  function netAxon(from, to, seed, withBouton) {
    const span = from.distanceTo(to);
    const w = () => V(Rn() - 0.5, Rn() - 0.5, (Rn() - 0.5) * 0.5).multiplyScalar(span * 0.18);
    const curve = new THREE.CatmullRomCurve3(
      [from, from.clone().lerp(to, 0.33).add(w()), from.clone().lerp(to, 0.66).add(w()), to],
      false, 'centripetal',
    );
    const L = curve.getLength();
    tag(tube(curve, small ? 22 : 34, 5, (u) => 0.021 * (1 - 0.3 * u), 0, L), seed);
    if (withBouton) {
      const b = new THREE.SphereGeometry(0.045, 12, 8);
      b.translate(to.x, to.y, to.z);
      tag(b, seed, L);
    }
  }
  function netNeuron(c, axonTo, withBouton) {
    const seed = Rn();
    const rs = 0.16 + Rn() * 0.09;
    const s = new THREE.SphereGeometry(rs, 18, 12);
    s.translate(c.x, c.y, c.z);
    tag(s, seed, 0);
    const axDir = axonTo ? axonTo.clone().sub(c).normalize() : V(Rn() - 0.5, Rn() - 0.5, (Rn() - 0.5) * 0.4).normalize();
    const nd = 3 + Math.floor(Rn() * 3);
    for (let k = 0; k < nd; k++) {
      const d = V(Rn() - 0.5, Rn() - 0.5, (Rn() - 0.5) * 0.5).normalize();
      if (d.dot(axDir) > 0.3) d.addScaledVector(axDir, -1.2).normalize();
      netGrow(c.clone().addScaledVector(d, rs * 0.85), d, 0.45 + Rn() * 0.5, 0.042, 0, small ? 1 : 2, 0, seed);
    }
    const to = axonTo || c.clone().addScaledVector(axDir, 2.2 + Rn() * 2.4);
    netAxon(c.clone().addScaledVector(axDir, rs * 0.85), to, seed, withBouton);
  }

  // One presynaptic partner per section: its axon ends on that branch's farthest tip.
  inputs.forEach((s, i) => {
    let tip = leafTips[i][0] || SOMA.clone().addScaledVector(outDir[i], 1.6);
    for (const t of leafTips[i]) if (t.distanceTo(SOMA) > tip.distanceTo(SOMA)) tip = t;
    const c = tip.clone().addScaledVector(outDir[i], 1.3 + Rn() * 0.8).add(V((Rn() - 0.5) * 0.9, (Rn() - 0.5) * 0.9, -1.1 - Rn() * 1.4));
    netNeuron(c, tip.clone(), true);
  });
  // The postsynaptic cell the terminal talks to, just above frame.
  netNeuron(V(3.3, 2.5, -0.2), null, false);
  // The rest of the field fills the whole volume the camera travels through, drifting slowly.
  moveNow = 1;
  const field = [];
  const want = small ? 14 : 34;
  for (let tries = 0; field.length < want && tries < 2000; tries++) {
    const c = V(-12 + Rn() * 24.5, -5.8 + Rn() * 11.6, -9.5 + Rn() * 8.1);
    if (c.z > -2.4 && c.x > -3.6 && c.x < 3.8 && Math.abs(c.y) < 2.1) continue;
    if (field.some((o) => o.distanceTo(c) < 1.9)) continue;
    field.push(c);
  }
  field.forEach((c, k) => {
    const to = k % 2 === 0 && field.length > 3
      ? field[(k + 3) % field.length].clone().add(V((Rn() - 0.5) * 0.3, (Rn() - 0.5) * 0.3, 0))
      : null;
    netNeuron(c, to, !!to);
  });
  const netGeo = mergeGeometries(netGeos, false);
  netGeos.forEach((g) => g.dispose());
  const netMat = glow(new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uGrow: { value: 0 }, uMotion: { value: 1 }, uLight,
      uGlow: { value: pal.net.clone() }, uInk: { value: pal.netInk.clone() },
    },
    vertexShader: NET_V, fragmentShader: NET_F, ...additive,
  }));
  const netMesh = new THREE.Mesh(netGeo, netMat);
  netMesh.frustumCulled = false;
  root.add(netMesh);

  // Far field: faint arbors and drifting particles for depth.
  const bg = new THREE.Group();
  const Rb = rng(77);
  const lp = [];
  const somata = [];
  const branch = (p, d, len, depth) => {
    let q = p.clone();
    const dd = d.clone();
    for (let k = 0; k < 4; k++) {
      dd.x += (Rb() - 0.5) * 0.5; dd.y += (Rb() - 0.5) * 0.5; dd.normalize();
      const nq = q.clone().addScaledVector(dd, len / 4);
      lp.push(q.x, q.y, q.z, nq.x, nq.y, nq.z);
      q = nq;
    }
    if (depth < 3) for (let c = 0; c < 2; c++) branch(q, dd.clone().applyAxisAngle(V(0, 0, 1), (Rb() - 0.5) * 1.4), len * 0.7, depth + 1);
  };
  for (let k = 0; k < (small ? 14 : 30); k++) {
    const c = V((Rb() - 0.5) * 30, (Rb() - 0.5) * 14, -10 - Rb() * 8);
    somata.push(c.x, c.y, c.z);
    const nb = 4 + Math.floor(Rb() * 3);
    for (let b = 0; b < nb; b++) {
      const a = Rb() * Math.PI * 2;
      branch(c, V(Math.cos(a), Math.sin(a), (Rb() - 0.5) * 0.3).normalize(), 0.9 + Rb() * 0.9, 0);
    }
  }
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
  const lineMat = new THREE.LineBasicMaterial({ color: pal.line.clone(), opacity: pal.lineOpacity, ...additive });
  bg.add(new THREE.LineSegments(lineGeo, lineMat));
  const dot = softDot();
  const somaGeo = new THREE.BufferGeometry();
  somaGeo.setAttribute('position', new THREE.Float32BufferAttribute(somata, 3));
  const cultureMat = new THREE.PointsMaterial({ size: 0.9, map: dot, color: pal.culture.clone(), ...additive });
  bg.add(new THREE.Points(somaGeo, cultureMat));
  const fp = [], ft = [], fsd = [];
  for (let k = 0; k < (small ? 70 : 170); k++) {
    const a = Rb() * Math.PI * 2;
    const dir = V(Math.cos(a), Math.sin(a) * 0.75, (Rb() - 0.5) * 0.35).normalize();
    const len = 6 + Rb() * 10;
    const mid = V((Rb() - 0.5) * 26, (Rb() - 0.5) * 13, -2.2 - Rb() * 11);
    const ctrl = [];
    for (let i = 0; i <= 4; i++) {
      ctrl.push(mid.clone().addScaledVector(dir, (i / 4 - 0.5) * len).add(V(Rb() - 0.5, Rb() - 0.5, (Rb() - 0.5) * 0.5).multiplyScalar(1.3)));
    }
    const curve = new THREE.CatmullRomCurve3(ctrl);
    const seg = 40, seed = Rb();
    let prev = curve.getPoint(0);
    for (let i = 1; i <= seg; i++) {
      const q = curve.getPoint(i / seg);
      fp.push(prev.x, prev.y, prev.z, q.x, q.y, q.z);
      ft.push((i - 1) / seg, i / seg);
      fsd.push(seed, seed);
      prev = q;
    }
  }
  const fiberGeo = new THREE.BufferGeometry();
  fiberGeo.setAttribute('position', new THREE.Float32BufferAttribute(fp, 3));
  fiberGeo.setAttribute('aT', new THREE.Float32BufferAttribute(ft, 1));
  fiberGeo.setAttribute('aSeed', new THREE.Float32BufferAttribute(fsd, 1));
  const fiberMat = glow(new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uMotion: { value: 1 }, uShow: { value: 0 }, uLight,
      uGlow: { value: pal.fiber.clone() }, uInk: { value: pal.fiberInk.clone() },
    },
    vertexShader: FIBER_V, fragmentShader: FIBER_F, ...additive,
  }));
  const fibers = new THREE.LineSegments(fiberGeo, fiberMat);
  fibers.frustumCulled = false;
  bg.add(fibers);

  const uCam = { value: V(0, 0, 10) };
  const uBox = { value: V(20, 12, 22) };
  function particles(count, sizeMin, sizeMax, color, alpha, bokeh) {
    const pos = new Float32Array(count * 3), seed = new Float32Array(count), size = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos.set([Rb() * 20, Rb() * 12, Rb() * 22], i * 3);
      seed[i] = Rb();
      size[i] = sizeMin + Rb() * Rb() * (sizeMax - sizeMin);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    const m = glow(new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uCam, uBox, uPR: { value: pr }, uMotion: { value: 1 }, uShow: { value: 0 }, uLight,
        uColor: { value: color.clone() }, uAlpha: { value: alpha },
      },
      vertexShader: DUST_V, fragmentShader: DUST_F, defines: bokeh ? { BOKEH: 1 } : {}, ...additive,
    }));
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    bg.add(pts);
    return m;
  }
  const dustMat = particles(small ? 1200 : 2800, 3.5, 11, pal.dust, pal.dustOpacity, false);
  const bokehMat = particles(small ? 30 : 70, 60, 170, pal.bokeh, pal.bokehOpacity, true);
  root.add(bg);

  // ---------- theme

  function setTheme(light) {
    pal = light ? PALETTES.light : PALETTES.dark;
    uLight.value = light ? 1 : 0;
    uBg.value.copy(pal.bg);
    const blend = light ? THREE.NormalBlending : THREE.AdditiveBlending;
    for (const m of [...glowMats, lineMat, cultureMat]) { m.blending = blend; m.needsUpdate = true; }
    dmats.forEach((m, i) => m.uniforms.uColor.value.set(light ? inputs[i].light : inputs[i].color));
    inputs.forEach((sec, i) => spineMat.uniforms.uCol.value[i].set(light ? sec.light : sec.color));
    spineMat.uniforms.uCol.value[N].copy(pal.deco);
    decoMat.uniforms.uColor.value.copy(pal.deco);
    rootMats.forEach((m) => {
      m.uniforms.uRootCol.value.copy(light ? ROOT_LIGHT : pal.soma);
      m.transparent = light;
      m.needsUpdate = true;
    });
    axMat.uniforms.uColor.value.copy(pal.axon);
    termMat.uniforms.uColor.value.copy(pal.cyan);
    postMat.uniforms.uColor.value.copy(pal.post);
    postSomaMat.uniforms.uColor.value.copy(pal.post);
    postSomaMat.uniforms.uInk.value.copy(pal.ink);
    somaMat.uniforms.uInk.value.copy(pal.ink);
    for (const m of myelin) { m.mat.uniforms.uInk.value.copy(pal.ink); m.mat.uniforms.uGlowInk.value.copy(pal.glowInk); }
    vesMat.uniforms.uColor.value.copy(pal.cyan);
    netMat.uniforms.uInk.value.copy(pal.netInk);
    lineMat.color.copy(pal.line);
    lineMat.opacity = pal.lineOpacity;
    cultureMat.color.copy(pal.culture);
    dustMat.uniforms.uColor.value.copy(pal.dust);
    dustMat.uniforms.uAlpha.value = pal.dustOpacity;
    bokehMat.uniforms.uColor.value.copy(pal.bokeh);
    bokehMat.uniforms.uAlpha.value = pal.bokehOpacity;
    fiberMat.uniforms.uGlow.value.copy(pal.fiber);
    fiberMat.uniforms.uInk.value.copy(pal.fiberInk);
  }

  // ---------- anchors for labels and camera

  const labelAnchors = [
    ...inputs.map((s, i) => ({ key: s.id, pos: SOMA.clone().addScaledVector(outDir[i], 0.27 + maxD[i] * 0.8 + 0.12) })),
    { key: 'soma', pos: SOMA.clone().add(V(0.05, -0.52, 0)) },
    { key: 'axon', pos: ax.getPointAt(0.55).add(V(0, -0.3, 0)) },
    { key: 'synapse', pos: end.clone().add(V(0.42, 0.5, 0)) },
  ];

  // ---------- runtime

  const pulses = inputs.map(() => ({ t0: -9, amp: 0, done: true }));
  let flash = 0, vesT = 9, nextBurst = 0;
  const tmp = new THREE.Color();
  const nodeRestLight = C('#8c95a8');

  function fire(i, amp, t) {
    pulses[i] = { t0: t, amp, done: false };
  }
  const blob = (mat, color, k) => { mat.uniforms.uColor.value.copy(color); mat.uniforms.uK.value = k; };
  const nodeGlowDark = C('#000000').setRGB(1, 1.08, 1.26);

  // s: { t, dt, lv:{d[], soma, axon, syn}, grow, show, dim, apDist, nodeFade, motion, spike, restMute, cam }
  // spike: true on the frame the cell fires. restMute: how desaturated idle branches are (0 = full color).
  function update(s) {
    const { t, dt, lv, grow } = s;
    const light = uLight.value > 0.5;
    for (const m of dmats) m.uniforms.uGrow.value = grow;
    decoMat.uniforms.uGrow.value = grow;
    axMat.uniforms.uGrow.value = grow;
    termMat.uniforms.uGrow.value = grow;
    punctaMat.uniforms.uGrow.value = grow;
    punctaMat.uniforms.uTime.value = t;
    recMat.uniforms.uTime.value = t;
    netMat.uniforms.uGrow.value = grow * 1.25;
    netMat.uniforms.uTime.value = t;
    netMat.uniforms.uMotion.value = s.motion ? 1 : 0;

    // Color is activity: idle branches rest desaturated, and a branch takes its color while it is driven.
    const focus = Math.max(s.restMute || 0, ...lv.d.map((d) => d * 1.1), lv.soma * 0.66);
    for (let i = 0; i < N; i++) {
      const p = pulses[i];
      const k = (t - p.t0) / 0.85;
      const u = dmats[i].uniforms;
      if (k >= 0 && k < 1) {
        u.uPulse.value = maxD[i] * (1 - k);
        u.uPulseAmp.value = p.amp;
      } else {
        u.uPulseAmp.value = 0;
        if (k >= 1 && !p.done) { p.done = true; flash = Math.max(flash, 0.3 * p.amp); }
      }
      punctaMat.uniforms.uPulse.value[i] = u.uPulse.value;
      punctaMat.uniforms.uPulseAmp.value[i] = u.uPulseAmp.value;
      u.uLevel.value = lv.d[i];
      u.uBase.value = s.dim;
      u.uMute.value = clamp(focus * (1 - lv.d[i]), 0, 0.85);
      punctaMat.uniforms.uLevel.value[i] = lv.d[i];
      punctaMat.uniforms.uMute.value[i] = u.uMute.value;
      const su = spineMat.uniforms;
      su.uLevel.value[i] = lv.d[i];
      su.uMute.value[i] = u.uMute.value;
      su.uPulse.value[i] = u.uPulse.value;
      su.uPulseAmp.value[i] = u.uPulseAmp.value;
    }
    spineMat.uniforms.uMute.value[N] = clamp(focus, 0, 0.85);
    spineMat.uniforms.uGrow.value = grow;
    spineMat.uniforms.uBase.value = s.dim;
    punctaMat.uniforms.uBase.value = s.dim;
    decoMat.uniforms.uBase.value = light ? 1 : s.dim * 0.7;
    decoMat.uniforms.uMute.value = clamp(focus, 0, 0.85);

    if (s.spike) flash = 1.3;
    flash *= Math.exp(-dt * 3);
    somaMat.uniforms.uShow.value = s.show;
    somaMat.uniforms.uFlash.value = flash;
    somaMat.uniforms.uCharge.value = lv.soma;
    if (light) {
      blob(nucMat, pal.dapi, s.show * (0.85 + flash * 0.15));
      blob(nuclMat, pal.nucleolus, s.show);
    } else {
      blob(nucMat, pal.dapi, s.show * (0.4 + lv.soma * 0.22 + flash * 1.4));
      blob(nuclMat, tmp.setRGB(0.55, 0.68, 1), s.show * (0.5 + lv.soma * 0.5 + flash * 1.5));
    }

    // Saltatory conduction, driven by scroll: the signal is only ever bright at a node.
    const apD = s.apDist;
    let lastNode = -1;
    nodeS.forEach((ns, k) => {
      let g = 0;
      if (apD >= ns) { g = 0.25 + Math.exp(-(apD - ns) * 5.5); lastNode = k; }
      g *= s.nodeFade;
      const vis = grow > ns ? 1 : 0;
      if (light) blob(nodeMats[k], tmp.copy(nodeRestLight).lerp(pal.glowInk, clamp(g, 0, 1)), vis);
      else blob(nodeMats[k], nodeGlowDark, (0.018 + g * 2.3) * vis);
    });
    for (const m of myelin) {
      const show = sstep(m.a, m.b + 0.15, grow);
      m.mesh.scale.setScalar(Math.max(0.001, show));
      m.mat.uniforms.uShow.value = show * s.dim * (0.85 + lv.axon * 0.7);
      m.mat.uniforms.uGlow.value = apD > m.a - 0.04 && apD < m.b + 0.04 ? 0.26 * s.nodeFade : 0;
    }
    axMat.uniforms.uBase.value = s.dim;
    axMat.uniforms.uLevel.value = lv.axon * 0.6;
    if (apD >= 0 && apD < nodeS[0]) { axMat.uniforms.uPulse.value = apD; axMat.uniforms.uPulseAmp.value = 1.1; }
    else if (apD >= 0 && apD <= AL && lastNode >= 0) { axMat.uniforms.uPulse.value = nodeS[lastNode]; axMat.uniforms.uPulseAmp.value = 1.1; }
    else axMat.uniforms.uPulseAmp.value = 0;

    termMat.uniforms.uBase.value = s.dim;
    termMat.uniforms.uLevel.value = lv.syn;
    if (apD > AL) { termMat.uniforms.uPulse.value = apD; termMat.uniforms.uPulseAmp.value = 1.2; }
    else termMat.uniforms.uPulseAmp.value = 0;

    if (s.motion && lv.syn > 0.5 && t > nextBurst) { vesT = 0; nextBurst = t + 1.8; }
    vesT += dt;
    vesMat.uniforms.uAge.value = vesT;
    const burst = vesT < 0.7 ? Math.exp(-vesT * 5) : 0;
    bMats.forEach((bm, i) => {
      const shown = grow > bAt[i] ? 1 : 0;
      if (light) blob(bm, tmp.copy(pal.cyan).lerp(C('#ffffff'), 0.6 * burst), shown * (0.7 + 0.3 * lv.syn));
      else blob(bm, pal.cyan, shown * s.dim * (0.3 + 0.9 * lv.syn + 2.2 * burst));
    });
    const recv = sstep(0.22, 0.42, vesT) * (1 - sstep(0.6, 1.3, vesT));
    recMat.uniforms.uBase.value = (0.25 + 2.2 * recv) * lv.syn;
    postMat.uniforms.uBase.value = sstep(AL, termEnd, grow) * (light ? 0.75 + 0.25 * lv.syn : 1.15 + 0.3 * lv.syn + recv * lv.syn * 1.4);
    postMat.uniforms.uLevel.value = 0;

    const motion = s.motion ? 1 : 0;
    uSwayT.value = t;
    uSway.value = motion;
    postSomaMat.uniforms.uShow.value = s.show;
    postSomaMat.uniforms.uFlash.value = 0.25 * recv * lv.syn;
    if (light) blob(postNucMat, pal.dapi, 0.42);
    else blob(postNucMat, pal.dapi, 0.14 + 0.6 * recv * lv.syn);
    if (s.cam) uCam.value.copy(s.cam);
    for (const m of [dustMat, bokehMat, fiberMat]) {
      m.uniforms.uTime.value = t;
      m.uniforms.uMotion.value = motion;
      m.uniforms.uShow.value = s.show;
    }
    if (s.motion) {
      bg.position.x = Math.sin(t * 0.05) * 0.15;
      bg.position.y = Math.sin(t * 0.037) * 0.08;
    }
  }

  const uSwayT = { value: 0 }, uSway = { value: 1 };
  root.traverse((o) => {
    const m = o.material;
    if (m && m.vertexShader && m.vertexShader.includes('sway(')) Object.assign(m.uniforms, { uSwayT, uSway });
  });

  return {
    root, targets, update, fire, setTheme, labelAnchors,
    SOMA, outDir, maxD, axon: ax, AL, nodeS, end, termEnd,
  };
}

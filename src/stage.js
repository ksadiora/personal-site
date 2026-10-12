import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// Final pass: a fluorescence-microscope look. Slight chromatic fringe toward the edges,
// vignette, and sensor grain.
const ScopeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uLight: { value: 0 },
    uBg: { value: new THREE.Color('#eef1f5') },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime; uniform vec2 uRes; uniform float uLight; uniform vec3 uBg; varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 c = vUv - 0.5;
      float r = dot(c, c);
      vec2 off = c * (uLight > 0.5 ? 0.0 : 0.004) * (0.4 + r * 3.0);
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;
      float vig = smoothstep(0.12, 0.6, r);
      // Dark: edges fall off like a fluorescence field. Light: edges wash out like brightfield.
      col = uLight > 0.5 ? mix(col, uBg, vig * 0.55) : col * (1.0 - vig * 0.75);
      float g = hash(floor(vUv * uRes) + fract(uTime * 7.0) * 113.0) - 0.5;
      col += g * (uLight > 0.5 ? 0.012 : 0.018);
      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};

export function createStage(canvas) {
  const small = Math.min(innerWidth, innerHeight) < 700;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  const pr = Math.min(window.devicePixelRatio || 1, small ? 1.6 : 2);
  renderer.setPixelRatio(pr);
  renderer.setClearColor(0x030407, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 200);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.82, 0.55, 0.16);
  composer.addPass(bloom);
  const scope = new ShaderPass(ScopeShader);
  composer.addPass(scope);
  composer.addPass(new OutputPass());

  const size = { w: 1, h: 1 };
  function resize() {
    size.w = window.innerWidth;
    size.h = window.innerHeight;
    renderer.setSize(size.w, size.h, false);
    composer.setPixelRatio(pr);
    composer.setSize(size.w, size.h);
    camera.aspect = size.w / size.h;
    camera.updateProjectionMatrix();
    scope.uniforms.uRes.value.set(size.w * pr, size.h * pr);
  }

  function setTheme(light) {
    renderer.setClearColor(light ? 0xeef1f5 : 0x030407, 1);
    bloom.enabled = !light;
    scope.uniforms.uLight.value = light ? 1 : 0;
  }

  function render(t) {
    scope.uniforms.uTime.value = t;
    composer.render();
  }

  return { renderer, scene, camera, composer, bloom, pr, small, size, resize, render, setTheme };
}

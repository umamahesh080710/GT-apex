/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import {
  Camera,
  Volume2,
  VolumeX,
  Settings,
  RotateCcw,
  Pause,
  Play,
  ChevronLeft,
  ChevronRight,
  Trophy,
  AlertTriangle,
  Download,
  WifiOff,
} from 'lucide-react';

// ============================================================================
// TYPES & CONSTANTS
// ============================================================================
type GameScreen = 'menu' | 'racing' | 'paused' | 'finished';
type CameraMode = 'Chase Cam' | 'Hood Cam' | 'Far Cam';
type CarColorId = 'red' | 'blue' | 'black' | 'white';
type ControlKey = 'up' | 'down' | 'left' | 'right' | 'handbrake';

interface CarColorOption {
  id: CarColorId;
  name: string;
  hex: number;
  swatch: string;
  matte: boolean;
}

interface AiConfig {
  name: string;
  hex: number;
  swatch: string;
  baseSpeedFactor: number;
  laneOffset: number;
}

interface TrackSample {
  t: number;
  pos: THREE.Vector3;
  tangent: THREE.Vector3;
  right: THREE.Vector3;
}

interface TrackData {
  curve: THREE.CatmullRomCurve3;
  totalLength: number;
  samples: TrackSample[];
}

interface WheelRef {
  steerPivot: THREE.Group;
  spinGroup: THREE.Group;
  front: boolean;
}

interface CarVisual {
  group: THREE.Group;
  chassisPivot: THREE.Group;
  paintMat: THREE.MeshPhysicalMaterial;
  brakeMat: THREE.MeshStandardMaterial;
  headlights: THREE.SpotLight[];
  wheels: WheelRef[];
}

interface CarState {
  id: string;
  name: string;
  isPlayer: boolean;
  swatch: string;
  baseSpeedFactor?: number;
  baseLaneOffset?: number;
  laneOffset: number;
  visual: CarVisual;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  steerAngle: number;
  wheelSpin: number;
  pitch: number;
  roll: number;
  speed: number;
  lap: number;
  prevT: number;
  currT: number;
  checkpoints: Set<number>;
  finished: boolean;
  finishTimeMs: number;
  progress: number;
  startT: number;
  startOffset: number;
}

interface SmokeParticle {
  sprite: THREE.Sprite;
  mat: THREE.SpriteMaterial;
  life: number;
  maxLife: number;
  vx: number;
  vy: number;
  vz: number;
}

interface AudioRig {
  ctx: AudioContext;
  masterGain: GainNode;
  osc1: OscillatorNode;
  osc2: OscillatorNode;
  osc3: OscillatorNode;
  noiseSrc: AudioBufferSourceNode;
  engineFilter: BiquadFilterNode;
  engineGain: GainNode;
  screechGain: GainNode;
}

interface StandingRow {
  id: string;
  name: string;
  isPlayer: boolean;
  swatch: string;
  finished: boolean;
  finishTimeMs: number;
  lap: number;
}

interface HudSnapshot {
  speedKmh: number;
  rpmRatio: number;
  gear: number;
  lap: number;
  position: number;
  raceTimeMs: number;
  wrongWay: boolean;
}

const CAR_COLORS: CarColorOption[] = [
  { id: 'red', name: 'Metallic Red', hex: 0xc8102e, swatch: '#c8102e', matte: false },
  { id: 'blue', name: 'Midnight Blue', hex: 0x0f2d6b, swatch: '#0f2d6b', matte: false },
  { id: 'black', name: 'Matte Black', hex: 0x181a1f, swatch: '#181a1f', matte: true },
  { id: 'white', name: 'Pearl White', hex: 0xf2f4f8, swatch: '#f2f4f8', matte: false },
];

const AI_CONFIGS: AiConfig[] = [
  { name: 'Vortex GT', hex: 0xff7b00, swatch: '#ff7b00', baseSpeedFactor: 0.96, laneOffset: -4.2 },
  { name: 'Apex RS', hex: 0x00b4d8, swatch: '#00b4d8', baseSpeedFactor: 0.93, laneOffset: 4.2 },
  { name: 'Specter V8', hex: 0x16a34a, swatch: '#16a34a', baseSpeedFactor: 0.9, laneOffset: -1.8 },
];

const TRACK_HALF_WIDTH = 12.5;
const CURB_WIDTH = 1.6;
const TRACK_SAMPLES = 700;
const CHECKPOINTS = [0.2, 0.4, 0.6, 0.8];

// Closed-loop circuit control points (Start/Finish at [0, 0, 220] heading +X)
const TRACK_POINTS: [number, number, number][] = [
  [0, 0, 220],
  [160, 0, 220],
  [275, 1, 200],
  [330, 3, 125],
  [305, 4, 30],
  [215, 4, -20],
  [225, 5, -105],
  [290, 5, -175],
  [230, 4, -255],
  [90, 3, -275],
  [-65, 2, -245],
  [-155, 2, -165],
  [-260, 3, -185],
  [-335, 3, -105],
  [-305, 2, 15],
  [-285, 1, 135],
  [-235, 0, 208],
  [-130, 0, 220],
];

// Reusable math scratchpad (zero GC inside animation loop)
const _up = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _targetPos = new THREE.Vector3();
const _targetLook = new THREE.Vector3();
const _aiPt = new THREE.Vector3();
const _aiTan = new THREE.Vector3();
const _aiRight = new THREE.Vector3();
const _tanAhead = new THREE.Vector3();
const _vZeroOffset = new THREE.Vector3();
const _mat4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _posTmp = new THREE.Vector3();
const _colorTmp = new THREE.Color();

// ============================================================================
// PROCEDURAL CANVAS TEXTURES (ZERO EXTERNAL ASSETS)
// ============================================================================
function createAsphaltTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#2b2d31';
  ctx.fillRect(0, 0, 1024, 1024);

  const imgData = ctx.getImageData(0, 0, 1024, 1024);
  const data = imgData.data;
  for (let i = 0; i < data.length; i += 4) {
    const n = (Math.random() - 0.5) * 26;
    data[i] = Math.min(255, Math.max(0, data[i] + n));
    data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + n));
    data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + n));
  }
  ctx.putImageData(imgData, 0, 0);

  // Subtle racing groove & tire skid marks
  const groove1 = ctx.createLinearGradient(220, 0, 400, 0);
  groove1.addColorStop(0, 'rgba(10,10,12,0)');
  groove1.addColorStop(0.5, 'rgba(12,12,15,0.32)');
  groove1.addColorStop(1, 'rgba(10,10,12,0)');
  ctx.fillStyle = groove1;
  ctx.fillRect(200, 0, 220, 1024);

  const groove2 = ctx.createLinearGradient(624, 0, 804, 0);
  groove2.addColorStop(0, 'rgba(10,10,12,0)');
  groove2.addColorStop(0.5, 'rgba(12,12,15,0.32)');
  groove2.addColorStop(1, 'rgba(10,10,12,0)');
  ctx.fillStyle = groove2;
  ctx.fillRect(604, 0, 220, 1024);

  // Edge solid white boundary lines
  ctx.fillStyle = 'rgba(242, 242, 238, 0.9)';
  ctx.fillRect(26, 0, 18, 1024);
  ctx.fillRect(980, 0, 18, 1024);

  // Dashed yellow/amber center lane markings
  ctx.fillStyle = 'rgba(235, 190, 60, 0.78)';
  for (let y = 0; y < 1024; y += 128) {
    ctx.fillRect(507, y + 16, 10, 70);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = maxAnisotropy;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createCurbTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  for (let y = 0; y < 512; y += 128) {
    ctx.fillStyle = (y / 128) % 2 === 0 ? '#d92626' : '#f1f1ef';
    ctx.fillRect(0, y, 256, 128);
  }
  ctx.fillStyle = 'rgba(20,20,20,0.12)';
  for (let i = 0; i < 600; i++) {
    ctx.fillRect(Math.random() * 256, Math.random() * 512, 4, 4);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = maxAnisotropy;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createConcreteTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#9aa0a6';
  ctx.fillRect(0, 0, 512, 256);

  for (let i = 0; i < 4000; i++) {
    const shade = 120 + Math.floor(Math.random() * 65);
    ctx.fillStyle = `rgb(${shade},${shade},${shade})`;
    ctx.fillRect(Math.random() * 512, Math.random() * 256, 3, 3);
  }
  ctx.fillStyle = 'rgba(50,55,60,0.45)';
  for (let x = 0; x < 512; x += 128) {
    ctx.fillRect(x, 0, 4, 256);
  }
  ctx.fillStyle = '#c83e2b';
  ctx.fillRect(0, 20, 512, 16);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = maxAnisotropy;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createGrassTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#3b572d';
  ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 8000; i++) {
    const g = 70 + Math.floor(Math.random() * 45);
    const r = 45 + Math.floor(Math.random() * 35);
    ctx.fillStyle = `rgb(${r},${g},36)`;
    ctx.fillRect(Math.random() * 512, Math.random() * 512, 3, 3);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(60, 60);
  tex.anisotropy = maxAnisotropy;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createSkyTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d')!;

  const skyGrad = ctx.createLinearGradient(0, 0, 0, 620);
  skyGrad.addColorStop(0, '#13274f');
  skyGrad.addColorStop(0.35, '#2b4c7e');
  skyGrad.addColorStop(0.62, '#9e6b70');
  skyGrad.addColorStop(0.84, '#eb9458');
  skyGrad.addColorStop(1.0, '#ffd480');
  ctx.fillStyle = skyGrad;
  ctx.fillRect(0, 0, 2048, 1024);

  const sunGlow = ctx.createRadialGradient(540, 500, 15, 540, 500, 340);
  sunGlow.addColorStop(0, 'rgba(255, 250, 220, 0.98)');
  sunGlow.addColorStop(0.18, 'rgba(255, 210, 120, 0.75)');
  sunGlow.addColorStop(0.55, 'rgba(255, 145, 70, 0.25)');
  sunGlow.addColorStop(1, 'rgba(255, 145, 70, 0)');
  ctx.fillStyle = sunGlow;
  ctx.fillRect(0, 150, 1000, 650);

  for (let i = 0; i < 38; i++) {
    const cx = Math.random() * 2048;
    const cy = 220 + Math.random() * 240;
    const rx = 80 + Math.random() * 180;
    const ry = 12 + Math.random() * 26;
    const cg = ctx.createRadialGradient(cx, cy, 4, cx, cy, rx);
    cg.addColorStop(0, 'rgba(255, 220, 185, 0.22)');
    cg.addColorStop(1, 'rgba(255, 200, 160, 0)');
    ctx.fillStyle = cg;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  const drawMountainLayer = (
    baseY: number,
    amp: number,
    freq1: number,
    freq2: number,
    color: string
  ) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, 1024);
    for (let x = 0; x <= 2048; x += 8) {
      const t = (x / 2048) * Math.PI * 2;
      const h =
        Math.sin(t * freq1) * amp +
        Math.cos(t * freq2 + 1.2) * (amp * 0.55) +
        Math.sin(t * (freq1 + freq2)) * (amp * 0.25);
      ctx.lineTo(x, baseY - Math.abs(h));
    }
    ctx.lineTo(2048, 1024);
    ctx.closePath();
    ctx.fill();
  };

  drawMountainLayer(575, 75, 3, 7, '#4f4359');
  drawMountainLayer(595, 52, 5, 11, '#363242');

  ctx.fillStyle = '#2d3726';
  ctx.fillRect(0, 600, 2048, 424);

  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createCheckeredTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const size = 32;
  for (let y = 0; y < 128; y += size) {
    for (let x = 0; x < 512; x += size) {
      ctx.fillStyle = (x / size + y / size) % 2 === 0 ? '#ffffff' : '#111111';
      ctx.fillRect(x, y, size, size);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = maxAnisotropy;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createContactShadowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(128, 128, 18, 128, 128, 124);
  grad.addColorStop(0, 'rgba(0,0,0,0.72)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0.35)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ============================================================================
// TRACK SPLINE & GEOMETRY BUILDERS
// ============================================================================
function buildTrackData(): TrackData {
  const vectors = TRACK_POINTS.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
  const curve = new THREE.CatmullRomCurve3(vectors, true, 'catmullrom', 0.5);
  const totalLength = curve.getLength();

  const samples: TrackSample[] = [];
  const up = new THREE.Vector3(0, 1, 0);

  for (let i = 0; i < TRACK_SAMPLES; i++) {
    const t = i / TRACK_SAMPLES;
    const pos = curve.getPointAt(t);
    const tangent = curve.getTangentAt(t).normalize();
    const right = new THREE.Vector3().crossVectors(tangent, up).normalize();
    samples.push({ t, pos, tangent, right });
  }

  return { curve, totalLength, samples };
}

function createRibbonGeometry(
  samples: TrackSample[],
  offsetLeft: number,
  offsetRight: number,
  yOffset: number,
  uvRepeatLength: number
): THREE.BufferGeometry {
  const count = samples.length;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  let accDist = 0;
  for (let i = 0; i <= count; i++) {
    const idx = i % count;
    const prevIdx = (i - 1 + count) % count;
    const s = samples[idx];
    if (i > 0) {
      accDist += s.pos.distanceTo(samples[prevIdx].pos);
    }

    const pL = s.pos.clone().addScaledVector(s.right, offsetLeft);
    const pR = s.pos.clone().addScaledVector(s.right, offsetRight);
    pL.y += yOffset;
    pR.y += yOffset;

    positions.push(pL.x, pL.y, pL.z, pR.x, pR.y, pR.z);
    normals.push(0, 1, 0, 0, 1, 0);
    const vCoord = accDist / uvRepeatLength;
    uvs.push(0, vCoord, 1, vCoord);
  }

  for (let i = 0; i < count; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    indices.push(a, b, c, b, d, c);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function createBarrierWallGeometry(
  samples: TrackSample[],
  lateralOffset: number,
  height: number,
  thickness: number,
  uvLength: number
): THREE.BufferGeometry {
  const count = samples.length;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  let accDist = 0;
  const innerOffset = lateralOffset;
  const outerOffset = lateralOffset + (lateralOffset > 0 ? thickness : -thickness);

  for (let i = 0; i <= count; i++) {
    const idx = i % count;
    const prevIdx = (i - 1 + count) % count;
    const s = samples[idx];
    if (i > 0) accDist += s.pos.distanceTo(samples[prevIdx].pos);

    const pIn = s.pos.clone().addScaledVector(s.right, innerOffset);
    const pOut = s.pos.clone().addScaledVector(s.right, outerOffset);
    const v = accDist / uvLength;

    positions.push(
      pIn.x,
      pIn.y,
      pIn.z,
      pIn.x,
      pIn.y + height,
      pIn.z,
      pOut.x,
      pOut.y + height,
      pOut.z,
      pOut.x,
      pOut.y,
      pOut.z
    );
    uvs.push(v, 0, v, 0.45, v, 0.7, v, 1);
  }

  for (let i = 0; i < count; i++) {
    const base = i * 4;
    const next = (i + 1) * 4;
    for (let face = 0; face < 3; face++) {
      const a = base + face;
      const b = base + face + 1;
      const c = next + face;
      const d = next + face + 1;
      if (lateralOffset > 0) {
        indices.push(a, c, b, b, c, d);
      } else {
        indices.push(a, b, c, b, d, c);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// ============================================================================
// CAR MESH BUILDER (COMPOSITE PBR GROUP + HEADLIGHTS + BRAKE LIGHTS)
// ============================================================================
function createCarMesh(
  colorHex: number,
  isMatte: boolean,
  shadowTex: THREE.Texture,
  isPlayer = false
): CarVisual {
  const group = new THREE.Group();
  const chassisPivot = new THREE.Group();
  group.add(chassisPivot);

  // Ground contact shadow plane directly beneath car
  const contactMat = new THREE.MeshBasicMaterial({
    map: shadowTex,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const contactShadow = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 5.6), contactMat);
  contactShadow.rotation.x = -Math.PI / 2;
  contactShadow.position.y = 0.08;
  group.add(contactShadow);

  const paintMat = new THREE.MeshPhysicalMaterial({
    color: colorHex,
    metalness: isMatte ? 0.25 : 0.75,
    roughness: isMatte ? 0.58 : 0.16,
    clearcoat: isMatte ? 0.12 : 1.0,
    clearcoatRoughness: isMatte ? 0.45 : 0.05,
    envMapIntensity: 1.45,
  });

  const carbonMat = new THREE.MeshStandardMaterial({
    color: 0x16181c,
    metalness: 0.35,
    roughness: 0.52,
  });

  const chromeMat = new THREE.MeshStandardMaterial({
    color: 0xd8dde6,
    metalness: 0.92,
    roughness: 0.14,
  });

  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0x09131e,
    metalness: 0.08,
    roughness: 0.04,
    clearcoat: 1.0,
    clearcoatRoughness: 0.03,
    transparent: true,
    opacity: 0.86,
    envMapIntensity: 2.0,
  });

  const brakeMat = new THREE.MeshStandardMaterial({
    color: 0x550000,
    emissive: 0xff1111,
    emissiveIntensity: 0.3,
    roughness: 0.2,
  });

  const headlightMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xfff5d6,
    emissiveIntensity: 2.2,
  });

  // Lower body shell
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.02, 0.52, 4.55), paintMat);
  body.position.set(0, 0.52, 0);
  body.castShadow = true;
  body.receiveShadow = true;
  chassisPivot.add(body);

  // Sculpted front hood slope
  const hood = new THREE.Mesh(new THREE.BoxGeometry(1.88, 0.26, 1.55), paintMat);
  hood.position.set(0, 0.68, 1.42);
  hood.rotation.x = 0.09;
  hood.castShadow = true;
  chassisPivot.add(hood);

  // Front grille & splitter + rear diffuser
  const grille = new THREE.Mesh(new THREE.BoxGeometry(1.32, 0.22, 0.12), carbonMat);
  grille.position.set(0, 0.42, 2.26);
  chassisPivot.add(grille);

  const splitter = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.08, 0.44), carbonMat);
  splitter.position.set(0, 0.23, 2.24);
  chassisPivot.add(splitter);

  const diffuser = new THREE.Mesh(new THREE.BoxGeometry(1.94, 0.16, 0.35), carbonMat);
  diffuser.position.set(0, 0.27, -2.2);
  chassisPivot.add(diffuser);

  // Twin chrome exhaust tips
  const exhaustGeo = new THREE.CylinderGeometry(0.075, 0.075, 0.22, 12);
  exhaustGeo.rotateX(Math.PI / 2);
  for (const ex of [-0.52, 0.52]) {
    const exhaust = new THREE.Mesh(exhaustGeo, chromeMat);
    exhaust.position.set(ex, 0.27, -2.32);
    chassisPivot.add(exhaust);
  }

  // Side skirts & side mirrors
  for (const sx of [-1.02, 1.02]) {
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 2.8), carbonMat);
    skirt.position.set(sx, 0.26, 0);
    chassisPivot.add(skirt);

    const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.11, 0.16), paintMat);
    mirror.position.set(sx * 0.96, 0.86, 0.52);
    chassisPivot.add(mirror);
  }

  // Cabin greenhouse
  const cabinRoof = new THREE.Mesh(new THREE.BoxGeometry(1.56, 0.44, 1.85), paintMat);
  cabinRoof.position.set(0, 0.99, -0.18);
  cabinRoof.castShadow = true;
  chassisPivot.add(cabinRoof);

  // Glossy windshield & rear glass
  const windshield = new THREE.Mesh(new THREE.BoxGeometry(1.52, 0.44, 0.85), glassMat);
  windshield.position.set(0, 0.94, 0.85);
  windshield.rotation.x = 0.56;
  chassisPivot.add(windshield);

  const rearGlass = new THREE.Mesh(new THREE.BoxGeometry(1.48, 0.4, 0.88), glassMat);
  rearGlass.position.set(0, 0.95, -1.16);
  rearGlass.rotation.x = -0.48;
  chassisPivot.add(rearGlass);

  const sideGlass = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.34, 1.65), glassMat);
  sideGlass.position.set(0, 0.98, -0.18);
  chassisPivot.add(sideGlass);

  // GT Rear Wing
  const wingBlade = new THREE.Mesh(new THREE.BoxGeometry(2.04, 0.07, 0.34), carbonMat);
  wingBlade.position.set(0, 1.16, -2.08);
  wingBlade.rotation.x = -0.12;
  wingBlade.castShadow = true;
  chassisPivot.add(wingBlade);

  for (const px of [-0.62, 0.62]) {
    const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.38, 0.18), carbonMat);
    pylon.position.set(px, 0.94, -2.04);
    chassisPivot.add(pylon);
  }

  // Headlights
  for (const hx of [-0.68, 0.68]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.11, 0.08), headlightMat);
    hl.position.set(hx, 0.56, 2.27);
    chassisPivot.add(hl);
  }

  // Wide LED brake bar
  const brakeBar = new THREE.Mesh(new THREE.BoxGeometry(1.78, 0.1, 0.08), brakeMat);
  brakeBar.position.set(0, 0.64, -2.27);
  chassisPivot.add(brakeBar);

  // Dynamic headlight SpotLights for player car
  const headlights: THREE.SpotLight[] = [];
  if (isPlayer) {
    for (const sx of [-0.65, 0.65]) {
      const spot = new THREE.SpotLight(0xfff0cc, 38, 82, Math.PI / 5.5, 0.48, 1.2);
      spot.position.set(sx, 0.62, 2.25);
      const target = new THREE.Object3D();
      target.position.set(sx, 0.0, 26);
      chassisPivot.add(target);
      spot.target = target;
      chassisPivot.add(spot);
      headlights.push(spot);
    }
  }

  // Wheels & brake calipers
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.86, metalness: 0.05 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xd0d4dc, roughness: 0.2, metalness: 0.9 });
  const caliperMat = new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.35, metalness: 0.5 });

  const tireGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.28, 22);
  tireGeo.rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(0.24, 0.24, 0.295, 14);
  rimGeo.rotateZ(Math.PI / 2);
  const spokeGeo = new THREE.BoxGeometry(0.31, 0.42, 0.055);
  const caliperGeo = new THREE.BoxGeometry(0.14, 0.18, 0.14);

  const wheelPositions = [
    { x: -0.96, y: 0.36, z: 1.42, front: true },
    { x: 0.96, y: 0.36, z: 1.42, front: true },
    { x: -0.98, y: 0.36, z: -1.42, front: false },
    { x: 0.98, y: 0.36, z: -1.42, front: false },
  ];

  const wheels: WheelRef[] = [];
  for (const wp of wheelPositions) {
    const steerPivot = new THREE.Group();
    steerPivot.position.set(wp.x, wp.y, wp.z);

    const spinGroup = new THREE.Group();
    const tire = new THREE.Mesh(tireGeo, tireMat);
    tire.castShadow = true;
    spinGroup.add(tire);

    const rim = new THREE.Mesh(rimGeo, rimMat);
    spinGroup.add(rim);

    for (let r = 0; r < 3; r++) {
      const spoke = new THREE.Mesh(spokeGeo, rimMat);
      spoke.rotation.x = (r * Math.PI) / 3;
      spinGroup.add(spoke);
    }

    const caliper = new THREE.Mesh(caliperGeo, caliperMat);
    caliper.position.set(wp.x > 0 ? -0.05 : 0.05, 0.04, -0.14);
    steerPivot.add(caliper);
    steerPivot.add(spinGroup);
    group.add(steerPivot);

    wheels.push({ steerPivot, spinGroup, front: wp.front });
  }

  return { group, chassisPivot, paintMat, brakeMat, headlights, wheels };
}

// ============================================================================
// FORMATTING HELPERS
// ============================================================================
function formatRaceTime(ms: number): string {
  const totalSec = Math.max(0, ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = Math.floor(totalSec % 60);
  const hundredths = Math.floor((ms % 1000) / 10);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
}

function ordinal(n: number): string {
  if (n === 1) return '1st';
  if (n === 2) return '2nd';
  if (n === 3) return '3rd';
  return `${n}th`;
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

const PREFS_STORAGE_KEY = 'apex_horizon_prefs_v1';

interface SavedPrefs {
  carColorId?: CarColorId;
  totalLaps?: number;
  controlsScale?: number;
  showTouchControls?: boolean;
  isMuted?: boolean;
}

function loadSavedPrefs(): SavedPrefs {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as SavedPrefs;
  } catch {
    return {};
  }
}

function usePWAInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isIOS, setIsIOS] = useState(false);

  useEffect(() => {
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    setIsInstalled(isStandalone);

    const ua = window.navigator.userAgent.toLowerCase();
    setIsIOS(/iphone|ipad|ipod/.test(ua));

    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    const onAppInstalled = () => {
      setIsInstalled(true);
      setDeferredPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onAppInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!deferredPrompt) return false;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setIsInstalled(true);
      setDeferredPrompt(null);
      return true;
    }
    return false;
  }, [deferredPrompt]);

  return {
    isInstallable: !!deferredPrompt,
    isInstalled,
    isIOS,
    install,
  };
}

function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  return isOnline;
}

// ============================================================================
// MAIN SELF-CONTAINED COMPONENT
// ============================================================================
export default function App() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const minimapRef = useRef<HTMLCanvasElement | null>(null);
  const initialPrefs = useRef<SavedPrefs>(loadSavedPrefs()).current;

  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const isOnline = useOnlineStatus();

  // UI & Menu State
  const [screen, setScreen] = useState<GameScreen>('menu');
  const [carColorId, setCarColorId] = useState<CarColorId>(initialPrefs.carColorId ?? 'red');
  const [totalLaps, setTotalLaps] = useState<number>(initialPrefs.totalLaps ?? 3);
  const [cameraMode, setCameraMode] = useState<CameraMode>('Chase Cam');
  const [isMuted, setIsMuted] = useState<boolean>(initialPrefs.isMuted ?? false);
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [showIOSGuide, setShowIOSGuide] = useState<boolean>(false);
  const [controlsScale, setControlsScale] = useState<number>(initialPrefs.controlsScale ?? 1.0);
  const [showTouchControls, setShowTouchControls] = useState<boolean>(initialPrefs.showTouchControls ?? true);
  const [contextLost, setContextLost] = useState<boolean>(false);

  const [hud, setHud] = useState<HudSnapshot>({
    speedKmh: 0,
    rpmRatio: 0.14,
    gear: 1,
    lap: 1,
    position: 4,
    raceTimeMs: 0,
    wrongWay: false,
  });

  const [standings, setStandings] = useState<StandingRow[]>([]);

  // Mutable simulation state stored in useRef so 60fps loop never stalls on React re-renders
  const simRef = useRef<{
    screen: GameScreen;
    cameraMode: CameraMode;
    isMuted: boolean;
    totalLaps: number;
    carColorId: CarColorId;
    raceElapsedMs: number;
    keys: Record<ControlKey, boolean>;
    touch: Record<ControlKey, boolean>;
    cars: CarState[];
    track: TrackData | null;
    audio: AudioRig | null;
    resetRace: (() => void) | null;
    updatePlayerColor: ((colorId: CarColorId) => void) | null;
  }>({
    screen: 'menu',
    cameraMode: 'Chase Cam',
    isMuted: false,
    totalLaps: 3,
    carColorId: 'red',
    raceElapsedMs: 0,
    keys: { up: false, down: false, left: false, right: false, handbrake: false },
    touch: { up: false, down: false, left: false, right: false, handbrake: false },
    cars: [],
    track: null,
    audio: null,
    resetRace: null,
    updatePlayerColor: null,
  });

  // Sync React state -> simulation refs
  useEffect(() => {
    simRef.current.screen = screen;
    if (simRef.current.audio) {
      const { ctx, masterGain } = simRef.current.audio;
      const shouldPlay = screen === 'racing' && !simRef.current.isMuted;
      masterGain.gain.setTargetAtTime(shouldPlay ? 0.3 : 0, ctx.currentTime, 0.06);
    }
  }, [screen]);

  useEffect(() => {
    simRef.current.cameraMode = cameraMode;
  }, [cameraMode]);

  useEffect(() => {
    simRef.current.isMuted = isMuted;
    if (simRef.current.audio) {
      const { ctx, masterGain } = simRef.current.audio;
      const shouldPlay = simRef.current.screen === 'racing' && !isMuted;
      masterGain.gain.setTargetAtTime(shouldPlay ? 0.3 : 0, ctx.currentTime, 0.05);
    }
  }, [isMuted]);

  useEffect(() => {
    simRef.current.totalLaps = totalLaps;
  }, [totalLaps]);

  useEffect(() => {
    simRef.current.carColorId = carColorId;
    if (simRef.current.updatePlayerColor) {
      simRef.current.updatePlayerColor(carColorId);
    }
  }, [carColorId]);

  useEffect(() => {
    try {
      const prefs: SavedPrefs = {
        carColorId,
        totalLaps,
        controlsScale,
        showTouchControls,
        isMuted,
      };
      localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // ignore storage quota errors
    }
  }, [carColorId, totalLaps, controlsScale, showTouchControls, isMuted]);

  const ensureAudioStarted = useCallback(() => {
    const audio = simRef.current.audio;
    if (!audio) return;
    if (audio.ctx.state === 'suspended') {
      audio.ctx.resume().catch(() => {});
    }
  }, []);

  // ==========================================================================
  // THREE.JS SCENE, TRACK, PHYSICS & AUDIO LIFECYCLE
  // ==========================================================================
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const disposableGeos: THREE.BufferGeometry[] = [];
    const disposableMats: THREE.Material[] = [];
    const disposableTexs: THREE.Texture[] = [];

    const regGeo = <T extends THREE.BufferGeometry>(g: T): T => {
      disposableGeos.push(g);
      return g;
    };
    const regMat = <T extends THREE.Material>(m: T): T => {
      disposableMats.push(m);
      return m;
    };
    const regTex = <T extends THREE.Texture>(t: T): T => {
      disposableTexs.push(t);
      return t;
    };

    // Detect software WebGL (SwiftShader / llvmpipe / WARP) for adaptive render cost
    const isSoftwareGl = (() => {
      try {
        const probe = document.createElement('canvas').getContext('webgl2');
        if (!probe) return true;
        const ext = probe.getExtension('WEBGL_debug_renderer_info');
        const param = ext ? ext.UNMASKED_RENDERER_WEBGL : probe.RENDERER;
        const gpu = String(probe.getParameter(param) || '');
        probe.getExtension('WEBGL_lose_context')?.loseContext();
        return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
      } catch {
        return false;
      }
    })();

    // 1. Renderer, Scene, Camera & Golden-Hour Lighting
    const renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      powerPreference: 'high-performance',
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
    renderer.shadowMap.enabled = !isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    container.appendChild(renderer.domElement);

    const handleContextLost = (e: Event) => {
      e.preventDefault();
      setContextLost(true);
    };
    const handleContextRestored = () => {
      setContextLost(false);
    };
    renderer.domElement.addEventListener('webglcontextlost', handleContextLost);
    renderer.domElement.addEventListener('webglcontextrestored', handleContextRestored);

    const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0xd69f73, 0.00145);

    // Procedural Sky + PMREM Environment Reflections for PBR Clearcoat & Glass
    const skyTex = regTex(createSkyTexture());
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    pmremGenerator.compileEquirectangularShader();
    const envRT = pmremGenerator.fromEquirectangular(skyTex);
    regTex(envRT.texture);
    scene.environment = envRT.texture;
    pmremGenerator.dispose();

    const skyDome = new THREE.Mesh(
      regGeo(new THREE.SphereGeometry(1300, 48, 32)),
      regMat(new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false }))
    );
    scene.add(skyDome);

    const initW = container.clientWidth || window.innerWidth;
    const initH = container.clientHeight || window.innerHeight;
    const camera = new THREE.PerspectiveCamera(64, initW / initH, 0.25, 1800);
    const camPos = new THREE.Vector3(0, 6, 200);
    const camLook = new THREE.Vector3(0, 1, 220);

    // Golden-Hour 3-Part Lighting Rig
    const hemiLight = new THREE.HemisphereLight(0xffdfb0, 0x3b4832, 0.9);
    scene.add(hemiLight);

    const sunLight = new THREE.DirectionalLight(0xffcf8b, 2.75);
    sunLight.position.set(-220, 130, 160);
    sunLight.castShadow = !isSoftwareGl;
    sunLight.shadow.mapSize.set(2048, 2048);
    sunLight.shadow.camera.near = 10;
    sunLight.shadow.camera.far = 420;
    const dShadow = 95;
    sunLight.shadow.camera.left = -dShadow;
    sunLight.shadow.camera.right = dShadow;
    sunLight.shadow.camera.top = dShadow;
    sunLight.shadow.camera.bottom = -dShadow;
    sunLight.shadow.bias = -0.0005;
    sunLight.shadow.normalBias = 0.02;
    scene.add(sunLight);
    scene.add(sunLight.target);

    // 2. Track, Terrain & Trackside Scenery
    const trackData = buildTrackData();
    simRef.current.track = trackData;

    const grassTex = regTex(createGrassTexture(maxAniso));
    const ground = new THREE.Mesh(
      regGeo(new THREE.PlaneGeometry(2400, 2400)),
      regMat(new THREE.MeshStandardMaterial({ map: grassTex, roughness: 0.95, metalness: 0.0 }))
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    ground.receiveShadow = true;
    scene.add(ground);

    // Distant 3D mountain ring (InstancedMesh)
    const mountainMat = regMat(
      new THREE.MeshStandardMaterial({ color: 0x454452, roughness: 0.95, flatShading: true })
    );
    const mountainGeo = regGeo(new THREE.ConeGeometry(85, 110, 7));
    const mountainInst = new THREE.InstancedMesh(mountainGeo, mountainMat, 36);
    for (let i = 0; i < 36; i++) {
      const ang = (i / 36) * Math.PI * 2;
      const dist = 760 + (i % 3) * 90;
      _posTmp.set(Math.cos(ang) * dist, 38, Math.sin(ang) * dist);
      _quat.setFromAxisAngle(_up, i * 0.8);
      _scale.set(1.2 + (i % 4) * 0.4, 0.8 + (i % 5) * 0.35, 1.1 + (i % 3) * 0.4);
      _mat4.compose(_posTmp, _quat, _scale);
      mountainInst.setMatrixAt(i, _mat4);
    }
    mountainInst.instanceMatrix.needsUpdate = true;
    mountainInst.computeBoundingSphere();
    scene.add(mountainInst);

    // Asphalt Road
    const asphaltTex = regTex(createAsphaltTexture(maxAniso));
    const roadMat = regMat(
      new THREE.MeshStandardMaterial({
        map: asphaltTex,
        roughness: 0.72,
        metalness: 0.08,
      })
    );
    const roadMesh = new THREE.Mesh(
      regGeo(createRibbonGeometry(trackData.samples, -TRACK_HALF_WIDTH, TRACK_HALF_WIDTH, 0.04, 18)),
      roadMat
    );
    roadMesh.receiveShadow = true;
    scene.add(roadMesh);

    // Red-and-White Rumble Curbs
    const curbTex = regTex(createCurbTexture(maxAniso));
    const curbMat = regMat(new THREE.MeshStandardMaterial({ map: curbTex, roughness: 0.75 }));
    const leftCurb = new THREE.Mesh(
      regGeo(createRibbonGeometry(trackData.samples, -TRACK_HALF_WIDTH - CURB_WIDTH, -TRACK_HALF_WIDTH, 0.055, 7.5)),
      curbMat
    );
    leftCurb.receiveShadow = true;
    scene.add(leftCurb);

    const rightCurb = new THREE.Mesh(
      regGeo(createRibbonGeometry(trackData.samples, TRACK_HALF_WIDTH, TRACK_HALF_WIDTH + CURB_WIDTH, 0.055, 7.5)),
      curbMat
    );
    rightCurb.receiveShadow = true;
    scene.add(rightCurb);

    // Concrete Safety Barriers
    const concreteTex = regTex(createConcreteTexture(maxAniso));
    const barrierMat = regMat(new THREE.MeshStandardMaterial({ map: concreteTex, roughness: 0.88 }));
    const leftBarrier = new THREE.Mesh(
      regGeo(createBarrierWallGeometry(trackData.samples, -(TRACK_HALF_WIDTH + CURB_WIDTH + 1.8), 1.3, 0.75, 14)),
      barrierMat
    );
    leftBarrier.castShadow = true;
    leftBarrier.receiveShadow = true;
    scene.add(leftBarrier);

    const rightBarrier = new THREE.Mesh(
      regGeo(createBarrierWallGeometry(trackData.samples, TRACK_HALF_WIDTH + CURB_WIDTH + 1.8, 1.3, 0.75, 14)),
      barrierMat
    );
    rightBarrier.castShadow = true;
    rightBarrier.receiveShadow = true;
    scene.add(rightBarrier);

    // Start/Finish Checkered Line & Overhead Gantry
    const startSample = trackData.samples[0];
    const startAngle = Math.atan2(startSample.tangent.x, startSample.tangent.z);
    const checkeredTex = regTex(createCheckeredTexture(maxAniso));

    const startLine = new THREE.Mesh(
      regGeo(new THREE.PlaneGeometry(TRACK_HALF_WIDTH * 2, 3.2)),
      regMat(
        new THREE.MeshStandardMaterial({
          map: checkeredTex,
          roughness: 0.65,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
        })
      )
    );
    startLine.rotation.x = -Math.PI / 2;
    startLine.rotation.z = -startAngle;
    startLine.position.copy(startSample.pos).add(new THREE.Vector3(0, 0.065, 0));
    startLine.receiveShadow = true;
    scene.add(startLine);

    const gantryGroup = new THREE.Group();
    gantryGroup.position.copy(startSample.pos);
    gantryGroup.rotation.y = startAngle;

    const steelMat = regMat(new THREE.MeshStandardMaterial({ color: 0x262930, metalness: 0.75, roughness: 0.35 }));
    const gantrySpan = TRACK_HALF_WIDTH * 2 + 5;
    for (const side of [-1, 1]) {
      const pillar = new THREE.Mesh(regGeo(new THREE.BoxGeometry(0.9, 8.8, 0.9)), steelMat);
      pillar.position.set(side * (gantrySpan / 2), 4.4, 0);
      pillar.castShadow = true;
      gantryGroup.add(pillar);
    }
    const truss = new THREE.Mesh(regGeo(new THREE.BoxGeometry(gantrySpan + 1.2, 1.4, 1.1)), steelMat);
    truss.position.set(0, 8.4, 0);
    truss.castShadow = true;
    gantryGroup.add(truss);

    const banner = new THREE.Mesh(
      regGeo(new THREE.BoxGeometry(gantrySpan - 2, 1.1, 1.18)),
      regMat(new THREE.MeshStandardMaterial({ map: checkeredTex, roughness: 0.5 }))
    );
    banner.position.set(0, 8.4, 0);
    gantryGroup.add(banner);

    const gantryLightMat = regMat(
      new THREE.MeshStandardMaterial({ color: 0x11aa44, emissive: 0x22ff66, emissiveIntensity: 2.0 })
    );
    const podGeo = regGeo(new THREE.SphereGeometry(0.32, 12, 12));
    for (let i = -2; i <= 2; i++) {
      const pod = new THREE.Mesh(podGeo, gantryLightMat);
      pod.position.set(i * 2.2, 7.4, 0);
      gantryGroup.add(pod);
    }
    scene.add(gantryGroup);

    // Grandstands along the main straightaway
    const standStepMat = regMat(new THREE.MeshStandardMaterial({ color: 0x7a808a, roughness: 0.85 }));
    const standRoofMat = regMat(new THREE.MeshStandardMaterial({ color: 0xb91c1c, roughness: 0.45, metalness: 0.25 }));
    const standSupportMat = regMat(new THREE.MeshStandardMaterial({ color: 0x1e2024, metalness: 0.7, roughness: 0.4 }));
    for (const sampleIdx of [675, 692, 14, 30]) {
      const s = trackData.samples[sampleIdx % TRACK_SAMPLES];
      const gStand = new THREE.Group();
      const pos = s.pos.clone().addScaledVector(s.right, -(TRACK_HALF_WIDTH + CURB_WIDTH + 11));
      gStand.position.copy(pos);
      gStand.rotation.y = Math.atan2(s.tangent.x, s.tangent.z);

      for (let tier = 0; tier < 5; tier++) {
        const step = new THREE.Mesh(regGeo(new THREE.BoxGeometry(1.6, 0.85, 22)), standStepMat);
        step.position.set(-tier * 1.4, 0.6 + tier * 0.85, 0);
        step.castShadow = true;
        step.receiveShadow = true;
        gStand.add(step);
      }
      const roof = new THREE.Mesh(regGeo(new THREE.BoxGeometry(9.5, 0.35, 23)), standRoofMat);
      roof.position.set(-3.2, 7.6, 0);
      roof.rotation.z = -0.14;
      roof.castShadow = true;
      gStand.add(roof);

      for (const rz of [-9.5, 9.5]) {
        const post = new THREE.Mesh(regGeo(new THREE.BoxGeometry(0.45, 7.5, 0.45)), standSupportMat);
        post.position.set(-6.5, 3.75, rz);
        gStand.add(post);
      }
      scene.add(gStand);
    }

    // Distance marker boards before key braking zones
    const markerPostGeo = regGeo(new THREE.BoxGeometry(0.15, 2.2, 0.15));
    const markerSignGeo = regGeo(new THREE.BoxGeometry(0.12, 0.9, 1.6));
    const markerSignMat = regMat(new THREE.MeshStandardMaterial({ color: 0xfef08a, roughness: 0.4 }));
    for (const sIdx of [85, 93, 101, 285, 293, 301, 505, 513, 521]) {
      const s = trackData.samples[sIdx];
      const board = new THREE.Group();
      board.position.copy(s.pos).addScaledVector(s.right, TRACK_HALF_WIDTH + CURB_WIDTH + 3.1);
      board.rotation.y = Math.atan2(s.tangent.x, s.tangent.z);
      const post = new THREE.Mesh(markerPostGeo, steelMat);
      post.position.y = 1.1;
      const sign = new THREE.Mesh(markerSignGeo, markerSignMat);
      sign.position.y = 1.9;
      sign.castShadow = true;
      board.add(post, sign);
      scene.add(board);
    }

    // Instanced Tire Barriers outside sweeping corners
    const tireEntries: { pos: THREE.Vector3; red: boolean }[] = [];
    for (let i = 115; i < 620; i += 4) {
      const s = trackData.samples[i];
      const sNext = trackData.samples[(i + 6) % TRACK_SAMPLES];
      const crossY = s.tangent.z * sNext.tangent.x - s.tangent.x * sNext.tangent.z;
      if (Math.abs(crossY) > 0.08) {
        const side = crossY > 0 ? 1 : -1;
        const tp = s.pos.clone().addScaledVector(s.right, side * (TRACK_HALF_WIDTH + CURB_WIDTH + 0.95));
        tp.y += 0.55;
        tireEntries.push({ pos: tp, red: i % 8 === 0 });
      }
    }
    if (tireEntries.length > 0) {
      const tireWallGeo = regGeo(new THREE.CylinderGeometry(0.55, 0.55, 1.1, 14));
      const tireMatInst = regMat(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 }));
      const tireInst = new THREE.InstancedMesh(tireWallGeo, tireMatInst, tireEntries.length);
      tireInst.castShadow = true;
      _quat.identity();
      _scale.set(1, 1, 1);
      for (let i = 0; i < tireEntries.length; i++) {
        _mat4.compose(tireEntries[i].pos, _quat, _scale);
        tireInst.setMatrixAt(i, _mat4);
        _colorTmp.setHex(tireEntries[i].red ? 0xdc2626 : 0xf1f5f9);
        tireInst.setColorAt(i, _colorTmp);
      }
      tireInst.instanceMatrix.needsUpdate = true;
      if (tireInst.instanceColor) tireInst.instanceColor.needsUpdate = true;
      tireInst.computeBoundingSphere();
      scene.add(tireInst);
    }

    // Instanced Trees strictly outside track boundaries
    const treePositions: { x: number; z: number; scale: number; tint: number }[] = [];
    const minTreeClearanceSq = Math.pow(TRACK_HALF_WIDTH + CURB_WIDTH + 11, 2);
    let attempts = 0;
    while (treePositions.length < 190 && attempts < 1800) {
      attempts++;
      const tx = (Math.random() - 0.5) * 920;
      const tz = (Math.random() - 0.5) * 820;
      let tooClose = false;
      for (let j = 0; j < TRACK_SAMPLES; j += 3) {
        const sp = trackData.samples[j].pos;
        const dx = tx - sp.x;
        const dz = tz - sp.z;
        if (dx * dx + dz * dz < minTreeClearanceSq) {
          tooClose = true;
          break;
        }
      }
      if (!tooClose) {
        treePositions.push({
          x: tx,
          z: tz,
          scale: 0.85 + Math.random() * 0.75,
          tint: treePositions.length % 2 === 0 ? 0x2d5a27 : 0x3b6e2c,
        });
      }
    }

    if (treePositions.length > 0) {
      const trunkGeo = regGeo(new THREE.CylinderGeometry(0.32, 0.48, 3.6, 8));
      const coneGeo1 = regGeo(new THREE.ConeGeometry(2.6, 5.4, 8));
      const coneGeo2 = regGeo(new THREE.ConeGeometry(1.9, 4.2, 8));
      const trunkMat = regMat(new THREE.MeshStandardMaterial({ color: 0x4b3621, roughness: 0.95 }));
      const foliageMat = regMat(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88 }));

      const trunkInst = new THREE.InstancedMesh(trunkGeo, trunkMat, treePositions.length);
      const crown1Inst = new THREE.InstancedMesh(coneGeo1, foliageMat, treePositions.length);
      const crown2Inst = new THREE.InstancedMesh(coneGeo2, foliageMat, treePositions.length);
      trunkInst.castShadow = true;
      crown1Inst.castShadow = true;
      crown2Inst.castShadow = true;

      for (let i = 0; i < treePositions.length; i++) {
        const tp = treePositions[i];
        _quat.setFromAxisAngle(_up, (i * 1.1) % (Math.PI * 2));
        _scale.setScalar(tp.scale);

        _posTmp.set(tp.x, 1.8 * tp.scale, tp.z);
        _mat4.compose(_posTmp, _quat, _scale);
        trunkInst.setMatrixAt(i, _mat4);

        _posTmp.set(tp.x, 5.1 * tp.scale, tp.z);
        _mat4.compose(_posTmp, _quat, _scale);
        crown1Inst.setMatrixAt(i, _mat4);

        _posTmp.set(tp.x, 7.6 * tp.scale, tp.z);
        _mat4.compose(_posTmp, _quat, _scale);
        crown2Inst.setMatrixAt(i, _mat4);

        _colorTmp.setHex(tp.tint);
        crown1Inst.setColorAt(i, _colorTmp);
        _colorTmp.setHex(0x3b6e2c);
        crown2Inst.setColorAt(i, _colorTmp);
      }

      for (const inst of [trunkInst, crown1Inst, crown2Inst]) {
        inst.instanceMatrix.needsUpdate = true;
        if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
        inst.computeBoundingSphere();
        scene.add(inst);
      }
    }

    // 3. Tire Smoke Particle Pool
    const smokeCanvas = document.createElement('canvas');
    smokeCanvas.width = 128;
    smokeCanvas.height = 128;
    const sctx = smokeCanvas.getContext('2d')!;
    const sGrad = sctx.createRadialGradient(64, 64, 6, 64, 64, 60);
    sGrad.addColorStop(0, 'rgba(235, 238, 242, 0.68)');
    sGrad.addColorStop(0.5, 'rgba(210, 215, 220, 0.3)');
    sGrad.addColorStop(1, 'rgba(200, 205, 210, 0)');
    sctx.fillStyle = sGrad;
    sctx.fillRect(0, 0, 128, 128);
    const smokeTex = regTex(new THREE.CanvasTexture(smokeCanvas));
    smokeTex.colorSpace = THREE.SRGBColorSpace;

    const smokeParticles: SmokeParticle[] = [];
    for (let i = 0; i < 68; i++) {
      const mat = regMat(
        new THREE.SpriteMaterial({ map: smokeTex, transparent: true, opacity: 0, depthWrite: false })
      );
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      scene.add(sprite);
      smokeParticles.push({ sprite, mat, life: 0, maxLife: 0.7, vx: 0, vy: 0, vz: 0 });
    }
    let smokeCursor = 0;

    const spawnSmoke = (x: number, y: number, z: number, vx: number, vz: number) => {
      const p = smokeParticles[smokeCursor];
      smokeCursor = (smokeCursor + 1) % smokeParticles.length;
      p.life = p.maxLife;
      p.sprite.visible = true;
      p.sprite.position.set(x, y + 0.25, z);
      p.sprite.scale.set(0.9, 0.9, 1);
      p.vx = vx * 0.25 + (Math.random() - 0.5) * 1.4;
      p.vy = 1.2 + Math.random() * 1.1;
      p.vz = vz * 0.25 + (Math.random() - 0.5) * 1.4;
      p.mat.opacity = 0.52;
    };

    // 4. Cars (Player + 3 AI Competitors)
    const contactShadowTex = regTex(createContactShadowTexture());
    const initialColor = CAR_COLORS.find((c) => c.id === simRef.current.carColorId) || CAR_COLORS[0];
    const playerVisual = createCarMesh(initialColor.hex, initialColor.matte, contactShadowTex, true);
    scene.add(playerVisual.group);
    playerVisual.group.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const m = obj as THREE.Mesh;
        disposableGeos.push(m.geometry);
        if (Array.isArray(m.material)) disposableMats.push(...m.material);
        else disposableMats.push(m.material);
      }
    });

    const carStates: CarState[] = [
      {
        id: 'player',
        name: 'You',
        isPlayer: true,
        swatch: initialColor.swatch,
        visual: playerVisual,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        yaw: 0,
        steerAngle: 0,
        wheelSpin: 0,
        pitch: 0,
        roll: 0,
        speed: 0,
        lap: 1,
        prevT: 0.976,
        currT: 0.976,
        checkpoints: new Set(),
        finished: false,
        finishTimeMs: 0,
        progress: -0.024,
        startT: 0.976,
        startOffset: 3.8,
        laneOffset: 0,
      },
      ...AI_CONFIGS.map((ai, idx): CarState => {
        const aiVisual = createCarMesh(ai.hex, false, contactShadowTex, false);
        scene.add(aiVisual.group);
        aiVisual.group.traverse((obj) => {
          if ((obj as THREE.Mesh).isMesh) {
            const m = obj as THREE.Mesh;
            disposableGeos.push(m.geometry);
            if (Array.isArray(m.material)) disposableMats.push(...m.material);
            else disposableMats.push(m.material);
          }
        });
        return {
          id: `ai_${idx}`,
          name: ai.name,
          isPlayer: false,
          swatch: ai.swatch,
          baseSpeedFactor: ai.baseSpeedFactor,
          baseLaneOffset: ai.laneOffset,
          laneOffset: ai.laneOffset,
          visual: aiVisual,
          pos: new THREE.Vector3(),
          vel: new THREE.Vector3(),
          yaw: 0,
          steerAngle: 0,
          wheelSpin: 0,
          pitch: 0,
          roll: 0,
          speed: 0,
          lap: 1,
          prevT: 0.992 - idx * 0.0055,
          currT: 0.992 - idx * 0.0055,
          checkpoints: new Set(),
          finished: false,
          finishTimeMs: 0,
          progress: -0.008 - idx * 0.0055,
          startT: 0.992 - idx * 0.0055,
          startOffset: idx % 2 === 0 ? -3.8 : 3.8,
        };
      }),
    ];

    simRef.current.cars = carStates;

    simRef.current.updatePlayerColor = (colorId: CarColorId) => {
      const cfg = CAR_COLORS.find((c) => c.id === colorId) || CAR_COLORS[0];
      const pCar = carStates[0];
      pCar.swatch = cfg.swatch;
      pCar.visual.paintMat.color.setHex(cfg.hex);
      pCar.visual.paintMat.metalness = cfg.matte ? 0.25 : 0.75;
      pCar.visual.paintMat.roughness = cfg.matte ? 0.58 : 0.16;
      pCar.visual.paintMat.clearcoat = cfg.matte ? 0.12 : 1.0;
      pCar.visual.paintMat.clearcoatRoughness = cfg.matte ? 0.45 : 0.05;
      pCar.visual.paintMat.needsUpdate = true;
    };

    const resetAllCars = () => {
      simRef.current.raceElapsedMs = 0;
      for (const car of carStates) {
        const pt = trackData.curve.getPointAt(car.startT);
        const tan = trackData.curve.getTangentAt(car.startT).normalize();
        const right = _aiRight.crossVectors(tan, _up).normalize();

        car.pos.copy(pt).addScaledVector(right, car.startOffset);
        car.vel.set(0, 0, 0);
        car.yaw = Math.atan2(tan.x, tan.z);
        car.steerAngle = 0;
        car.wheelSpin = 0;
        car.pitch = 0;
        car.roll = 0;
        car.speed = 0;
        car.lap = 1;
        car.prevT = car.startT;
        car.currT = car.startT;
        car.checkpoints.clear();
        car.finished = false;
        car.finishTimeMs = 0;
        car.progress = car.startT - 1.0;
        if (!car.isPlayer && car.baseLaneOffset !== undefined) {
          car.laneOffset = car.baseLaneOffset;
        }

        car.visual.group.position.copy(car.pos);
        car.visual.group.rotation.y = car.yaw;
        car.visual.chassisPivot.rotation.set(0, 0, 0);
        car.visual.brakeMat.emissiveIntensity = 0.3;
        for (const w of car.visual.wheels) {
          w.steerPivot.rotation.y = 0;
          w.spinGroup.rotation.x = 0;
        }
      }

      for (const p of smokeParticles) {
        p.life = 0;
        p.sprite.visible = false;
      }

      const pCar = carStates[0];
      _fwd.set(Math.sin(pCar.yaw), 0, Math.cos(pCar.yaw));
      camPos.copy(pCar.pos).addScaledVector(_fwd, -7.8).add(_vZeroOffset.set(0, 3.2, 0));
      camLook.copy(pCar.pos).addScaledVector(_fwd, 10);
      camera.position.copy(camPos);
      camera.lookAt(camLook);

      setHud({
        speedKmh: 0,
        rpmRatio: 0.14,
        gear: 1,
        lap: 1,
        position: 4,
        raceTimeMs: 0,
        wrongWay: false,
      });
    };

    simRef.current.resetRace = resetAllCars;
    resetAllCars();

    // 5. Web Audio Procedural Synth (Multi-Oscillator Engine + Tire Screech)
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        const masterGain = ctx.createGain();
        masterGain.gain.value = 0;
        masterGain.connect(ctx.destination);

        const osc1 = ctx.createOscillator();
        osc1.type = 'sawtooth';
        osc1.frequency.value = 55;

        const osc2 = ctx.createOscillator();
        osc2.type = 'triangle';
        osc2.frequency.value = 110;

        const osc3 = ctx.createOscillator();
        osc3.type = 'sine';
        osc3.frequency.value = 28;

        const engineFilter = ctx.createBiquadFilter();
        engineFilter.type = 'lowpass';
        engineFilter.frequency.value = 280;
        engineFilter.Q.value = 2.2;

        const engineGain = ctx.createGain();
        engineGain.gain.value = 0.35;

        osc1.connect(engineFilter);
        osc2.connect(engineFilter);
        osc3.connect(engineFilter);
        engineFilter.connect(engineGain);
        engineGain.connect(masterGain);

        osc1.start();
        osc2.start();
        osc3.start();

        const noiseLen = ctx.sampleRate * 2;
        const noiseBuffer = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
        const output = noiseBuffer.getChannelData(0);
        for (let i = 0; i < noiseLen; i++) {
          output[i] = Math.random() * 2 - 1;
        }
        const noiseSrc = ctx.createBufferSource();
        noiseSrc.buffer = noiseBuffer;
        noiseSrc.loop = true;

        const screechFilter = ctx.createBiquadFilter();
        screechFilter.type = 'bandpass';
        screechFilter.frequency.value = 1180;
        screechFilter.Q.value = 3.8;

        const screechGain = ctx.createGain();
        screechGain.gain.value = 0;

        noiseSrc.connect(screechFilter);
        screechFilter.connect(screechGain);
        screechGain.connect(masterGain);
        noiseSrc.start();

        simRef.current.audio = {
          ctx,
          masterGain,
          osc1,
          osc2,
          osc3,
          noiseSrc,
          engineFilter,
          engineGain,
          screechGain,
        };
      }
    } catch {
      // AudioContext unavailable
    }

    // Pre-compile shaders on hardware GPU to avoid first-frame stutter
    if (!isSoftwareGl) {
      renderer.compile(scene, camera);
    }

    // 6. Track Projection & Anti-Cheat Lap Validation
    const findTrackSample = (pos: THREE.Vector3) => {
      let bestIdx = 0;
      let bestDistSq = Infinity;
      const samples = trackData.samples;
      for (let i = 0; i < TRACK_SAMPLES; i++) {
        const sp = samples[i].pos;
        const dx = pos.x - sp.x;
        const dz = pos.z - sp.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestDistSq) {
          bestDistSq = d2;
          bestIdx = i;
        }
      }
      const s = samples[bestIdx];
      const dx = pos.x - s.pos.x;
      const dz = pos.z - s.pos.z;
      const along = dx * s.tangent.x + dz * s.tangent.z;
      const lateral = dx * s.right.x + dz * s.right.z;
      const t = (bestIdx / TRACK_SAMPLES + along / trackData.totalLength + 1) % 1;

      // Smooth linear Y interpolation between adjacent spline samples
      const segLen = trackData.totalLength / TRACK_SAMPLES;
      const frac = along / segLen;
      const neighborIdx = frac >= 0 ? (bestIdx + 1) % TRACK_SAMPLES : (bestIdx - 1 + TRACK_SAMPLES) % TRACK_SAMPLES;
      const yInterp = THREE.MathUtils.lerp(s.pos.y, samples[neighborIdx].pos.y, Math.min(1, Math.abs(frac)));

      return { sample: s, t, lateral, yInterp };
    };

    const updateCarLapProgress = (car: CarState, currT: number) => {
      const prevT = car.prevT;
      car.currT = currT;

      if (!car.finished) {
        const nextCpIdx = car.checkpoints.size;
        if (nextCpIdx < CHECKPOINTS.length) {
          const cp = CHECKPOINTS[nextCpIdx];
          if (currT >= cp && currT < cp + 0.08 && prevT <= cp + 0.02) {
            car.checkpoints.add(cp);
          }
        }

        if (prevT > 0.85 && currT < 0.15) {
          if (car.checkpoints.size === CHECKPOINTS.length) {
            if (car.lap >= simRef.current.totalLaps) {
              car.finished = true;
              car.finishTimeMs = simRef.current.raceElapsedMs;
              car.progress = simRef.current.totalLaps + 1;
            } else {
              car.lap += 1;
              car.checkpoints.clear();
            }
          }
        }

        if (!car.finished) {
          if (car.checkpoints.size === 0 && currT > 0.85) {
            car.progress = car.lap - 1 + (currT - 1.0);
          } else {
            car.progress = car.lap - 1 + currT;
          }
        }
      }

      car.prevT = currT;
    };

    // 7. Keyboard & Resize Listeners
    const onKeyDown = (e: KeyboardEvent) => {
      const k = simRef.current.keys;
      switch (e.code) {
        case 'KeyW':
        case 'ArrowUp':
          k.up = true;
          break;
        case 'KeyS':
        case 'ArrowDown':
          k.down = true;
          break;
        case 'KeyA':
        case 'ArrowLeft':
          k.left = true;
          break;
        case 'KeyD':
        case 'ArrowRight':
          k.right = true;
          break;
        case 'Space':
          k.handbrake = true;
          if (simRef.current.screen === 'racing') e.preventDefault();
          break;
        case 'Escape':
        case 'KeyP':
          if (simRef.current.screen === 'racing') setScreen('paused');
          else if (simRef.current.screen === 'paused') setScreen('racing');
          break;
        default:
          break;
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const k = simRef.current.keys;
      switch (e.code) {
        case 'KeyW':
        case 'ArrowUp':
          k.up = false;
          break;
        case 'KeyS':
        case 'ArrowDown':
          k.down = false;
          break;
        case 'KeyA':
        case 'ArrowLeft':
          k.left = false;
          break;
        case 'KeyD':
        case 'ArrowRight':
          k.right = false;
          break;
        case 'Space':
          k.handbrake = false;
          break;
        default:
          break;
      }
    };

    const onResize = () => {
      if (!container) return;
      const w = Math.max(1, container.clientWidth || window.innerWidth);
      const h = Math.max(1, container.clientHeight || window.innerHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(w, h, false);
    };

    const resizeObserver =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => onResize()) : null;
    resizeObserver?.observe(container);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    window.visualViewport?.addEventListener('resize', onResize);

    // 8. Main Animation & Physics Loop
    let frameId = 0;
    let isDisposed = false;
    let lastTime = performance.now();
    let hudTimer = 0;

    const drawMinimap = () => {
      const canvas = minimapRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      const mapX = (wx: number) => ((wx + 380) / 760) * (w - 20) + 10;
      const mapY = (wz: number) => ((wz + 310) / 580) * (h - 20) + 10;

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.48)';
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < TRACK_SAMPLES; i += 4) {
        const p = trackData.samples[i].pos;
        if (i === 0) ctx.moveTo(mapX(p.x), mapY(p.z));
        else ctx.lineTo(mapX(p.x), mapY(p.z));
      }
      ctx.closePath();
      ctx.stroke();

      const sp = trackData.samples[0].pos;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(mapX(sp.x) - 2, mapY(sp.z) - 5, 4, 10);

      for (let i = carStates.length - 1; i >= 0; i--) {
        const c = carStates[i];
        ctx.beginPath();
        ctx.arc(mapX(c.pos.x), mapY(c.pos.z), c.isPlayer ? 5.2 : 3.8, 0, Math.PI * 2);
        ctx.fillStyle = c.isPlayer ? '#facc15' : c.swatch;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#0f172a';
        ctx.stroke();
      }
    };

    const stepPhysics = (dt: number) => {
      const maxLateralLimit = TRACK_HALF_WIDTH + CURB_WIDTH + 0.35;
      const keys = simRef.current.keys;
      const touch = simRef.current.touch;

      const throttleIn = keys.up || touch.up ? 1 : 0;
      const brakeIn = keys.down || touch.down ? 1 : 0;
      const steerLeft = keys.left || touch.left ? 1 : 0;
      const steerRight = keys.right || touch.right ? 1 : 0;
      const handbrake = keys.handbrake || touch.handbrake;
      const steerInput = steerLeft - steerRight;

      let playerLatSlip = 0;
      let playerWrongWay = false;

      for (const car of carStates) {
        _fwd.set(Math.sin(car.yaw), 0, Math.cos(car.yaw));
        _right.set(-Math.cos(car.yaw), 0, Math.sin(car.yaw));

        let vFwd = car.vel.dot(_fwd);
        let vLat = car.vel.dot(_right);

        let accelInput = 0;
        let braking = false;
        let targetSteer = 0;
        let isDrifting = false;

        if (car.isPlayer && !car.finished) {
          targetSteer = steerInput * 0.54;
          const topSpeed = 76; // ~274 km/h

          if (throttleIn > 0) {
            const speedFactor = Math.max(0.18, 1 - Math.max(0, vFwd) / topSpeed);
            vFwd += 36 * speedFactor * dt;
            accelInput = 1;
          }

          if (brakeIn > 0) {
            if (vFwd > 1.5) {
              vFwd -= 48 * dt;
              braking = true;
              accelInput = -1;
            } else {
              vFwd = Math.max(-22, vFwd - 22 * dt);
              braking = true;
              accelInput = -0.5;
            }
          }

          if (handbrake && Math.abs(vFwd) > 3) {
            vFwd *= Math.max(0, 1 - 1.35 * dt);
            braking = true;
            isDrifting = true;
          }

          vFwd -= vFwd * (0.14 + 0.0022 * Math.abs(vFwd)) * dt;

          car.steerAngle += (targetSteer - car.steerAngle) * Math.min(1, 11 * dt);
          const speedMag = Math.abs(vFwd);
          const steerAuthority = Math.min(1, speedMag / 7.5) * (1 / (1 + speedMag * 0.022));
          const dirSign = vFwd >= -0.5 ? 1 : -1;
          const driftTurnBoost = handbrake ? 1.32 : 1.0;
          car.yaw += car.steerAngle * 3.85 * steerAuthority * dirSign * driftTurnBoost * dt;

          const lateralGrip = handbrake ? 2.3 : Math.abs(vLat) > 7.5 ? 5.6 : 9.4;
          vLat -= vLat * Math.min(1, lateralGrip * dt);

          playerLatSlip = Math.abs(vLat);
          if (playerLatSlip > 4.6 && speedMag > 11) {
            isDrifting = true;
          }
        } else {
          const proj = findTrackSample(car.pos);
          const lookaheadDist = 15 + Math.abs(vFwd) * 0.34;
          const lookaheadT = (proj.t + lookaheadDist / trackData.totalLength) % 1;
          const curveCheckT = (proj.t + 46 / trackData.totalLength) % 1;

          let desiredLane = car.isPlayer ? 0 : (car.baseLaneOffset ?? 0);
          if (!car.isPlayer) {
            for (const other of carStates) {
              if (other === car) continue;
              const dtAhead = (other.currT - proj.t + 1) % 1;
              if (dtAhead > 0.002 && dtAhead < 0.032) {
                const otherProj = findTrackSample(other.pos);
                if (Math.abs(otherProj.lateral - car.laneOffset) < 2.8) {
                  desiredLane = otherProj.lateral > 0 ? -4.8 : 4.8;
                  break;
                }
              }
            }
            car.laneOffset += (desiredLane - car.laneOffset) * Math.min(1, 2.5 * dt);
          }

          trackData.curve.getPointAt(lookaheadT, _aiPt);
          trackData.curve.getTangentAt(lookaheadT, _aiTan).normalize();
          _aiRight.crossVectors(_aiTan, _up).normalize();
          _aiPt.addScaledVector(_aiRight, car.isPlayer ? 0 : car.laneOffset);

          const toTargetX = _aiPt.x - car.pos.x;
          const toTargetZ = _aiPt.z - car.pos.z;
          const desiredYaw = Math.atan2(toTargetX, toTargetZ);
          let yawErr = desiredYaw - car.yaw;
          while (yawErr > Math.PI) yawErr -= Math.PI * 2;
          while (yawErr < -Math.PI) yawErr += Math.PI * 2;

          car.steerAngle +=
            (THREE.MathUtils.clamp(yawErr * 1.4, -0.52, 0.52) - car.steerAngle) * Math.min(1, 9 * dt);
          car.yaw += THREE.MathUtils.clamp(yawErr * 3.8, -2.9, 2.9) * Math.min(1, Math.abs(vFwd) / 6) * dt;

          const tanNow = proj.sample.tangent;
          trackData.curve.getTangentAt(curveCheckT, _tanAhead).normalize();
          const cornerSharpness = Math.max(0, 1 - tanNow.dot(_tanAhead));
          const aiBaseMax = car.isPlayer ? 56 : 74 * (car.baseSpeedFactor ?? 0.92);

          let rubberBand = 1.0;
          if (!car.isPlayer) {
            const pDiff = carStates[0].progress - car.progress;
            rubberBand = THREE.MathUtils.clamp(1 + pDiff * 0.28, 0.92, 1.09);
          }

          const targetSpeed = Math.max(24, aiBaseMax * rubberBand * (1 - cornerSharpness * 1.45));
          if (vFwd < targetSpeed) {
            vFwd += 31 * dt;
            accelInput = 0.8;
          } else if (vFwd > targetSpeed + 4) {
            vFwd -= 35 * dt;
            braking = true;
            accelInput = -0.8;
          }
          vLat -= vLat * Math.min(1, 8.8 * dt);
        }

        _fwd.set(Math.sin(car.yaw), 0, Math.cos(car.yaw));
        _right.set(-Math.cos(car.yaw), 0, Math.sin(car.yaw));
        car.vel.copy(_fwd).multiplyScalar(vFwd).addScaledVector(_right, vLat);
        car.pos.addScaledVector(car.vel, dt);
        car.speed = car.vel.length();

        const trackInfo = findTrackSample(car.pos);
        car.pos.y = trackInfo.yInterp;

        if (car.isPlayer) {
          playerWrongWay = _fwd.dot(trackInfo.sample.tangent) < -0.35 && car.speed > 5;
        }

        if (Math.abs(trackInfo.lateral) > maxLateralLimit) {
          const sign = Math.sign(trackInfo.lateral);
          const excess = Math.abs(trackInfo.lateral) - maxLateralLimit;
          car.pos.addScaledVector(trackInfo.sample.right, -sign * excess);

          const outVel = car.vel.dot(trackInfo.sample.right) * sign;
          if (outVel > 0) {
            car.vel.addScaledVector(trackInfo.sample.right, -sign * outVel * 1.28);
            car.vel.multiplyScalar(0.88);
          }
        }

        updateCarLapProgress(car, trackInfo.t);

        if (isDrifting && Math.random() < 0.72) {
          const rx = car.pos.x - _fwd.x * 1.45;
          const rz = car.pos.z - _fwd.z * 1.45;
          spawnSmoke(rx + _right.x * 0.9, car.pos.y, rz + _right.z * 0.9, car.vel.x, car.vel.z);
          spawnSmoke(rx - _right.x * 0.9, car.pos.y, rz - _right.z * 0.9, car.vel.x, car.vel.z);
        }

        const targetPitch = -accelInput * 0.032;
        const targetRoll = THREE.MathUtils.clamp(car.steerAngle * (vFwd / 55) * 0.12, -0.075, 0.075);
        car.pitch += (targetPitch - car.pitch) * Math.min(1, 9 * dt);
        car.roll += (targetRoll - car.roll) * Math.min(1, 9 * dt);
        car.wheelSpin += (vFwd / 0.36) * dt;

        car.visual.group.position.copy(car.pos);
        car.visual.group.rotation.y = car.yaw;
        car.visual.chassisPivot.rotation.x = car.pitch;
        car.visual.chassisPivot.rotation.z = car.roll;
        car.visual.brakeMat.emissiveIntensity = braking ? 3.2 : 0.28;

        for (const w of car.visual.wheels) {
          if (w.front) w.steerPivot.rotation.y = car.steerAngle;
          w.spinGroup.rotation.x = car.wheelSpin;
        }
      }

      // Solid car-to-car collision separation & momentum transfer
      const carRadius = 1.65;
      const minDist = carRadius * 2;
      for (let i = 0; i < carStates.length; i++) {
        for (let j = i + 1; j < carStates.length; j++) {
          const a = carStates[i];
          const b = carStates[j];
          const dx = b.pos.x - a.pos.x;
          const dz = b.pos.z - a.pos.z;
          const distSq = dx * dx + dz * dz;
          if (distSq > 0.0001 && distSq < minDist * minDist) {
            const dist = Math.sqrt(distSq);
            const nx = dx / dist;
            const nz = dz / dist;
            const overlap = (minDist - dist) * 0.5;
            a.pos.x -= nx * overlap;
            a.pos.z -= nz * overlap;
            b.pos.x += nx * overlap;
            b.pos.z += nz * overlap;

            const rvx = b.vel.x - a.vel.x;
            const rvz = b.vel.z - a.vel.z;
            const relNormal = rvx * nx + rvz * nz;
            if (relNormal < 0) {
              const impulse = -(1 + 0.38) * relNormal * 0.5;
              a.vel.x -= nx * impulse;
              a.vel.z -= nz * impulse;
              b.vel.x += nx * impulse;
              b.vel.z += nz * impulse;
            }
          }
        }
      }

      // Web Audio Engine RPM & Tire Screech
      if (simRef.current.audio && simRef.current.screen === 'racing' && !simRef.current.isMuted) {
        const { ctx, osc1, osc2, osc3, engineFilter, screechGain } = simRef.current.audio;
        const pCar = carStates[0];
        const speedNorm = Math.min(1, pCar.speed / 76);
        const gearProgress = ((speedNorm * 5.2) % 1) * 0.65 + speedNorm * 0.35;
        const baseFreq = 46 + gearProgress * 118 + (throttleIn ? 12 : 0);

        osc1.frequency.setTargetAtTime(baseFreq, ctx.currentTime, 0.04);
        osc2.frequency.setTargetAtTime(baseFreq * 2.01, ctx.currentTime, 0.04);
        osc3.frequency.setTargetAtTime(baseFreq * 0.5, ctx.currentTime, 0.04);
        engineFilter.frequency.setTargetAtTime(240 + gearProgress * 950, ctx.currentTime, 0.05);

        const screechLevel =
          playerLatSlip > 4.6 && pCar.speed > 10 ? Math.min(0.45, (playerLatSlip - 4.6) * 0.045) : 0;
        screechGain.gain.setTargetAtTime(screechLevel, ctx.currentTime, 0.04);
      }

      return { playerWrongWay };
    };

    const afterDraw = (cb: () => void) => {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const sync = gl.fenceSync ? gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) : null;
      gl.flush();
      const poll = () => {
        if (isDisposed) return;
        const state = sync ? gl.getSyncParameter(sync, gl.SYNC_STATUS) : gl.SIGNALED;
        if (state === gl.UNSIGNALED) {
          frameId = window.setTimeout(poll, 5);
        } else {
          if (sync) gl.deleteSync(sync);
          frameId = window.setTimeout(cb, 80);
        }
      };
      frameId = window.setTimeout(poll, 5);
    };

    const animate = (now: number) => {
      if (isDisposed) return;
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000));
      lastTime = now;

      const curScreen = simRef.current.screen;
      let wrongWay = false;

      if (curScreen === 'racing') {
        simRef.current.raceElapsedMs += dt * 1000;
        const res = stepPhysics(dt);
        wrongWay = res.playerWrongWay;

        const pCar = carStates[0];
        if (pCar.finished) {
          const sorted = [...carStates].sort((a, b) => {
            if (a.finished && b.finished) return a.finishTimeMs - b.finishTimeMs;
            if (a.finished) return -1;
            if (b.finished) return 1;
            return b.progress - a.progress;
          });
          setStandings(
            sorted.map((c) => ({
              id: c.id,
              name: c.name,
              isPlayer: c.isPlayer,
              swatch: c.swatch,
              finished: c.finished,
              finishTimeMs: c.finishTimeMs,
              lap: c.lap,
            }))
          );
          setScreen('finished');
        }
      }

      for (const p of smokeParticles) {
        if (p.life > 0) {
          p.life -= dt;
          if (p.life <= 0) {
            p.sprite.visible = false;
          } else {
            const ratio = p.life / p.maxLife;
            p.sprite.position.x += p.vx * dt;
            p.sprite.position.y += p.vy * dt;
            p.sprite.position.z += p.vz * dt;
            const scale = 0.9 + (1 - ratio) * 2.8;
            p.sprite.scale.set(scale, scale, 1);
            p.mat.opacity = ratio * 0.45;
          }
        }
      }

      const pCar = carStates[0];
      if (curScreen === 'menu') {
        const orbitAngle = now * 0.00032;
        _targetPos.set(
          pCar.pos.x + Math.cos(orbitAngle) * 8.5,
          pCar.pos.y + 3.1,
          pCar.pos.z + Math.sin(orbitAngle) * 8.5
        );
        camPos.lerp(_targetPos, Math.min(1, 5 * dt));
        _vZeroOffset.set(0, 0.9, 0);
        camLook.copy(pCar.pos).add(_vZeroOffset);
        camera.fov += (55 - camera.fov) * Math.min(1, 5 * dt);
        camera.updateProjectionMatrix();
        camera.position.copy(camPos);
        camera.lookAt(camLook);
      } else {
        _fwd.set(Math.sin(pCar.yaw), 0, Math.cos(pCar.yaw));
        const speedNorm = Math.min(1, pCar.speed / 76);
        const mode = simRef.current.cameraMode;

        if (mode === 'Hood Cam') {
          _vZeroOffset.set(0, 1.32, 0);
          _targetPos.copy(pCar.pos).addScaledVector(_fwd, 0.72).add(_vZeroOffset);
          _vZeroOffset.set(0, 1.05, 0);
          _targetLook.copy(pCar.pos).addScaledVector(_fwd, 26).add(_vZeroOffset);
          camera.position.copy(_targetPos);
          camera.lookAt(_targetLook);
          const targetFov = 68 + speedNorm * 16;
          camera.fov += (targetFov - camera.fov) * Math.min(1, 6 * dt);
          camera.updateProjectionMatrix();
        } else {
          const dist = mode === 'Far Cam' ? 12.2 : 7.6;
          const height = mode === 'Far Cam' ? 5.1 : 3.05;
          _vZeroOffset.set(0, height, 0);
          _targetPos.copy(pCar.pos).addScaledVector(_fwd, -dist).add(_vZeroOffset);
          _vZeroOffset.set(0, 1.15, 0);
          _targetLook.copy(pCar.pos).addScaledVector(_fwd, 10).add(_vZeroOffset);

          const damp = 1 - Math.exp(-9.5 * dt);
          camPos.lerp(_targetPos, damp);
          camLook.lerp(_targetLook, 1 - Math.exp(-13 * dt));

          const targetFov = (mode === 'Far Cam' ? 60 : 62) + speedNorm * 20;
          camera.fov += (targetFov - camera.fov) * Math.min(1, 6 * dt);
          camera.updateProjectionMatrix();
          camera.position.copy(camPos);
          camera.lookAt(camLook);
        }
      }

      skyDome.position.copy(pCar.pos);
      sunLight.position.set(pCar.pos.x - 180, pCar.pos.y + 125, pCar.pos.z + 140);
      sunLight.target.position.copy(pCar.pos);
      sunLight.target.updateMatrixWorld();

      renderer.render(scene, camera);

      hudTimer += dt;
      if (hudTimer >= 0.05) {
        hudTimer = 0;
        if (curScreen === 'racing') {
          drawMinimap();
          const speedKmh = Math.round(pCar.speed * 3.6);
          const speedNorm = Math.min(1, pCar.speed / 76);
          const gear = Math.min(6, Math.max(1, Math.floor(speedNorm * 5.8) + 1));
          const rpmRatio = Math.min(1, Math.max(0.14, ((speedNorm * 5.2) % 1) * 0.72 + speedNorm * 0.28));

          const sorted = [...carStates].sort((a, b) => {
            if (a.finished && b.finished) return a.finishTimeMs - b.finishTimeMs;
            if (a.finished) return -1;
            if (b.finished) return 1;
            return b.progress - a.progress;
          });
          const position = sorted.findIndex((c) => c.isPlayer) + 1;

          setHud({
            speedKmh,
            rpmRatio,
            gear,
            lap: pCar.lap,
            position,
            raceTimeMs: simRef.current.raceElapsedMs,
            wrongWay,
          });
        }
      }

      if (isSoftwareGl) {
        afterDraw(() => animate(performance.now()));
      } else {
        frameId = requestAnimationFrame(animate);
      }
    };

    frameId = requestAnimationFrame(animate);

    // 9. Strict Resource Cleanup on Unmount
    return () => {
      isDisposed = true;
      cancelAnimationFrame(frameId);
      clearTimeout(frameId);
      resizeObserver?.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
      renderer.domElement.removeEventListener('webglcontextlost', handleContextLost);
      renderer.domElement.removeEventListener('webglcontextrestored', handleContextRestored);

      if (simRef.current.audio) {
        try {
          simRef.current.audio.osc1.stop();
          simRef.current.audio.osc2.stop();
          simRef.current.audio.osc3.stop();
          simRef.current.audio.noiseSrc.stop();
          simRef.current.audio.ctx.close();
        } catch {
          // ignore
        }
        simRef.current.audio = null;
      }

      for (const g of disposableGeos) g.dispose();
      for (const m of disposableMats) m.dispose();
      for (const t of disposableTexs) t.dispose();
      renderer.dispose();

      if (renderer.domElement && renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  // ==========================================================================
  // UI ACTION HANDLERS
  // ==========================================================================
  const handleStartRace = () => {
    ensureAudioStarted();
    if (simRef.current.resetRace) simRef.current.resetRace();
    setShowSettings(false);
    setScreen('racing');
  };

  const handleRestartRace = () => {
    ensureAudioStarted();
    if (simRef.current.resetRace) simRef.current.resetRace();
    setShowSettings(false);
    setScreen('racing');
  };

  const handleToggleCamera = () => {
    setCameraMode((prev) => {
      if (prev === 'Chase Cam') return 'Hood Cam';
      if (prev === 'Hood Cam') return 'Far Cam';
      return 'Chase Cam';
    });
  };

  const setTouchControl = (key: ControlKey, active: boolean) => {
    ensureAudioStarted();
    simRef.current.touch[key] = active;
  };

  const controlButtonProps = (key: ControlKey) => ({
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      setTouchControl(key, true);
    },
    onPointerUp: (e: React.PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      setTouchControl(key, false);
    },
    onPointerLeave: () => setTouchControl(key, false),
    onPointerCancel: () => setTouchControl(key, false),
  });

  // ==========================================================================
  // RENDER UI OVERLAYS
  // ==========================================================================
  return (
    <div
      className="fixed inset-0 w-full h-full overflow-hidden bg-slate-950 select-none font-sans text-white"
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingRight: 'env(safe-area-inset-right)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        paddingLeft: 'env(safe-area-inset-left)',
      }}
    >
      {/* Isolated WebGL Canvas Container */}
      <div ref={mountRef} className="absolute inset-0 w-full h-full overflow-hidden" />

      {contextLost && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-950/95 p-6 text-center">
          <div className="max-w-sm rounded-2xl bg-slate-900 border border-white/15 p-6">
            <h2 className="text-lg font-bold mb-2">Graphics Context Interrupted</h2>
            <p className="text-sm text-slate-300">Restoring 3D rendering context...</p>
          </div>
        </div>
      )}

      {/* IN-GAME HUD */}
      {(screen === 'racing' || screen === 'paused') && (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col justify-between p-2 sm:p-4 md:p-5 overflow-hidden">
          {/* Top Bar */}
          <div className="flex items-start justify-between gap-2 sm:gap-3">
            {/* Telemetry Readout: Position, Lap, Time */}
            <div className="flex flex-wrap items-center gap-1.5 sm:gap-2.5">
              <div className="rounded-lg sm:rounded-xl bg-slate-950/85 border border-white/15 px-2.5 py-1.5 sm:px-4 sm:py-2 shadow-lg">
                <div className="text-[10px] sm:text-[11px] tracking-wider text-amber-400 font-semibold">Pos</div>
                <div className="text-lg sm:text-3xl font-black leading-none tabular-nums">
                  {ordinal(hud.position)}
                  <span className="text-xs sm:text-sm text-slate-400 font-semibold">/4</span>
                </div>
              </div>

              <div className="rounded-lg sm:rounded-xl bg-slate-950/85 border border-white/15 px-2.5 py-1.5 sm:px-4 sm:py-2 shadow-lg">
                <div className="text-[10px] sm:text-[11px] tracking-wider text-sky-400 font-semibold">Lap</div>
                <div className="text-lg sm:text-3xl font-black leading-none tabular-nums">
                  {hud.lap}
                  <span className="text-xs sm:text-sm text-slate-400 font-semibold">/{totalLaps}</span>
                </div>
              </div>

              <div className="rounded-lg sm:rounded-xl bg-slate-950/85 border border-white/15 px-2.5 py-1.5 sm:px-4 sm:py-2 shadow-lg">
                <div className="text-[10px] sm:text-[11px] tracking-wider text-slate-300 font-semibold">Time</div>
                <div className="text-sm sm:text-2xl font-mono font-bold leading-none tabular-nums">
                  {formatRaceTime(hud.raceTimeMs)}
                </div>
              </div>
            </div>

            {/* Action Buttons & Mini-Map Radar */}
            <div className="flex flex-col items-end gap-1.5 sm:gap-2 min-w-0">
              <div className="pointer-events-auto flex flex-wrap justify-end gap-1.5 sm:gap-2">
                <button
                  type="button"
                  onClick={handleToggleCamera}
                  className="inline-flex items-center gap-1 rounded-lg bg-slate-950/88 hover:bg-slate-800 border border-white/15 px-2 py-1.5 sm:px-3 sm:py-2 text-[11px] sm:text-sm font-semibold whitespace-nowrap shrink-0 transition active:scale-95 cursor-pointer"
                  aria-label="Toggle Camera View"
                >
                  <Camera className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-amber-400" />
                  <span className="hidden md:inline">{cameraMode}</span>
                  <span className="md:hidden">{cameraMode.replace(' Cam', '')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    ensureAudioStarted();
                    setIsMuted((m) => !m);
                  }}
                  className="inline-flex items-center gap-1 rounded-lg bg-slate-950/88 hover:bg-slate-800 border border-white/15 px-2 py-1.5 sm:px-3 sm:py-2 text-[11px] sm:text-sm font-semibold whitespace-nowrap shrink-0 transition active:scale-95 cursor-pointer"
                  aria-label={isMuted ? 'Unmute Audio' : 'Mute Audio'}
                >
                  {isMuted ? (
                    <VolumeX className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-red-400" />
                  ) : (
                    <Volume2 className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-emerald-400" />
                  )}
                  <span className="hidden sm:inline">{isMuted ? 'Muted' : 'Audio'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowSettings(true)}
                  className="inline-flex items-center gap-1 rounded-lg bg-slate-950/88 hover:bg-slate-800 border border-white/15 px-2 py-1.5 sm:px-3 sm:py-2 text-[11px] sm:text-sm font-semibold whitespace-nowrap shrink-0 transition active:scale-95 cursor-pointer"
                  aria-label="Settings and Controls"
                >
                  <Settings className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-slate-300" />
                  <span className="hidden sm:inline">Controls</span>
                </button>
                <button
                  type="button"
                  onClick={handleRestartRace}
                  className="inline-flex items-center gap-1 rounded-lg bg-slate-950/88 hover:bg-slate-800 border border-white/15 px-2 py-1.5 sm:px-3 sm:py-2 text-[11px] sm:text-sm font-semibold whitespace-nowrap shrink-0 transition active:scale-95 cursor-pointer"
                  aria-label="Restart Race"
                >
                  <RotateCcw className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-sky-400" />
                  <span className="hidden sm:inline">Restart</span>
                </button>
                <button
                  type="button"
                  onClick={() => setScreen((s) => (s === 'paused' ? 'racing' : 'paused'))}
                  className="inline-flex items-center gap-1 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 px-2.5 py-1.5 sm:px-3.5 sm:py-2 text-[11px] sm:text-sm font-bold whitespace-nowrap shrink-0 shadow transition active:scale-95 cursor-pointer"
                >
                  {screen === 'paused' ? (
                    <Play className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                  ) : (
                    <Pause className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                  )}
                  <span>{screen === 'paused' ? 'Resume' : 'Pause'}</span>
                </button>
              </div>

              {/* Mini-Map Radar */}
              <div className="rounded-xl bg-slate-950/82 border border-white/15 p-1 shadow-lg">
                <canvas
                  ref={minimapRef}
                  width={156}
                  height={116}
                  className="block w-24 h-[72px] sm:w-32 sm:h-24 md:w-40 md:h-28"
                />
              </div>
            </div>
          </div>

          {/* Wrong Way Alert */}
          {hud.wrongWay && screen === 'racing' && (
            <div className="self-center inline-flex items-center gap-2 rounded-xl bg-red-600/95 border border-red-300 px-4 py-1.5 sm:px-6 sm:py-2.5 text-sm sm:text-lg font-black tracking-wider uppercase shadow-xl">
              <AlertTriangle className="w-4 h-4 sm:w-5 sm:h-5" />
              <span>Wrong Way</span>
            </div>
          )}

          {/* Bottom Bar: Responsive Touch Controls & Speedometer / RPM */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            {/* Digital Speedometer & RPM Bar (Above pedals on narrow portrait, centered on sm+) */}
            <div className="self-center sm:order-2 sm:self-end rounded-xl sm:rounded-2xl bg-slate-950/85 border border-white/15 px-3.5 py-2 sm:px-5 sm:py-3 shadow-xl min-w-[148px] sm:min-w-[190px] md:min-w-[225px]">
              <div className="flex items-baseline justify-between gap-2 sm:gap-3">
                <div>
                  <span className="text-2xl sm:text-4xl font-black font-mono tracking-tight tabular-nums">
                    {hud.speedKmh}
                  </span>
                  <span className="ml-1 text-[10px] sm:text-xs font-bold text-slate-400">KM/H</span>
                </div>
                <div className="rounded-md bg-amber-500/20 border border-amber-400/40 px-1.5 py-0.5 text-[11px] sm:text-xs font-black text-amber-300 tabular-nums">
                  G{hud.gear}
                </div>
              </div>
              <div className="mt-1.5 sm:mt-2 h-2 sm:h-2.5 w-full rounded-full bg-slate-800 overflow-hidden border border-white/10">
                <div
                  className="h-full transition-all duration-75 rounded-full"
                  style={{
                    width: `${Math.round(hud.rpmRatio * 100)}%`,
                    background:
                      hud.rpmRatio > 0.85
                        ? 'linear-gradient(90deg, #f59e0b, #ef4444)'
                        : 'linear-gradient(90deg, #38bdf8, #f59e0b)',
                  }}
                />
              </div>
            </div>

            {showTouchControls && (
              <div className="flex items-end justify-between w-full sm:contents">
                {/* Left Steering Controls */}
                <div
                  className="pointer-events-auto sm:order-1 flex items-center gap-2 sm:gap-2.5 origin-bottom-left"
                  style={{ transform: `scale(${controlsScale})` }}
                >
                  <button
                    type="button"
                    {...controlButtonProps('left')}
                    className="w-12 h-12 sm:w-16 sm:h-16 md:w-20 md:h-20 flex items-center justify-center rounded-xl sm:rounded-2xl bg-slate-950/82 active:bg-amber-500 active:text-slate-950 border-2 border-white/25 shadow-xl touch-none cursor-pointer"
                    aria-label="Steer Left"
                  >
                    <ChevronLeft className="w-7 h-7 sm:w-9 sm:h-9" />
                  </button>
                  <button
                    type="button"
                    {...controlButtonProps('right')}
                    className="w-12 h-12 sm:w-16 sm:h-16 md:w-20 md:h-20 flex items-center justify-center rounded-xl sm:rounded-2xl bg-slate-950/82 active:bg-amber-500 active:text-slate-950 border-2 border-white/25 shadow-xl touch-none cursor-pointer"
                    aria-label="Steer Right"
                  >
                    <ChevronRight className="w-7 h-7 sm:w-9 sm:h-9" />
                  </button>
                </div>

                {/* Right Pedals (Handbrake, Brake/Reverse, Gas) */}
                <div
                  className="pointer-events-auto sm:order-3 flex items-end gap-1.5 sm:gap-2.5 origin-bottom-right"
                  style={{ transform: `scale(${controlsScale})` }}
                >
                  <button
                    type="button"
                    {...controlButtonProps('handbrake')}
                    className="w-11 h-11 sm:w-14 sm:h-14 md:w-16 md:h-16 rounded-xl sm:rounded-2xl bg-amber-600/88 active:bg-amber-400 active:text-slate-950 border-2 border-amber-300/45 text-[10px] sm:text-xs font-black tracking-wider shadow-xl touch-none cursor-pointer"
                  >
                    DRIFT
                  </button>
                  <button
                    type="button"
                    {...controlButtonProps('down')}
                    className="w-12 h-12 sm:w-16 sm:h-16 md:w-20 md:h-20 rounded-xl sm:rounded-2xl bg-red-600/88 active:bg-red-400 border-2 border-red-300/45 text-[10px] sm:text-sm font-black shadow-xl touch-none cursor-pointer"
                  >
                    BRAKE
                  </button>
                  <button
                    type="button"
                    {...controlButtonProps('up')}
                    className="w-12 h-16 sm:w-16 sm:h-20 md:w-20 md:h-24 rounded-xl sm:rounded-2xl bg-emerald-600/90 active:bg-emerald-400 border-2 border-emerald-300/45 text-[10px] sm:text-sm font-black shadow-xl touch-none cursor-pointer"
                  >
                    GAS
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* MAIN MENU OVERLAY */}
      {screen === 'menu' && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/60 p-3 sm:p-4">
          <div className="w-full max-w-md max-h-[calc(100%-1rem)] overflow-y-auto rounded-3xl bg-slate-900/94 border border-white/15 p-5 sm:p-8 shadow-2xl">
            <div className="text-center mb-5 sm:mb-6">
              <p className="text-xs font-semibold tracking-widest uppercase text-amber-400 mb-1">
                Golden Hour Circuit
              </p>
              <h1 className="text-2xl sm:text-4xl font-black tracking-tight">Apex Horizon 3D</h1>
              <p className="text-xs sm:text-sm text-slate-400 mt-1">
                WASD / Arrows + Space Handbrake · Touch Pedals Supported
              </p>
            </div>

            {/* Car Color Selector */}
            <div className="mb-4 sm:mb-5">
              <div className="text-xs tracking-wider uppercase text-slate-300 font-bold mb-2">Car Color</div>
              <div className="grid grid-cols-2 gap-2">
                {CAR_COLORS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setCarColorId(c.id)}
                    className={`flex items-center gap-2 rounded-xl px-3 py-2 sm:py-2.5 border text-xs sm:text-sm font-semibold transition cursor-pointer ${
                      carColorId === c.id
                        ? 'border-amber-400 bg-amber-500/18 text-white'
                        : 'border-white/10 bg-slate-800/80 text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    <span
                      className="w-4 h-4 sm:w-5 sm:h-5 rounded-full border border-white/40 shrink-0"
                      style={{ backgroundColor: c.swatch }}
                    />
                    <span className="truncate">{c.name}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Laps Selector */}
            <div className="mb-5 sm:mb-6">
              <div className="text-xs tracking-wider uppercase text-slate-300 font-bold mb-2">Laps</div>
              <div className="grid grid-cols-3 gap-2">
                {[1, 3, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setTotalLaps(n)}
                    className={`rounded-xl py-2 sm:py-2.5 border text-sm font-bold transition cursor-pointer ${
                      totalLaps === n
                        ? 'border-amber-400 bg-amber-500/20 text-amber-300'
                        : 'border-white/10 bg-slate-800/80 text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    {n} {n === 1 ? 'Lap' : 'Laps'}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={handleStartRace}
                className="w-full rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-base sm:text-lg py-3 sm:py-3.5 shadow-lg transition active:scale-[0.99] cursor-pointer"
              >
                Start Race
              </button>
              <button
                type="button"
                onClick={() => setShowSettings(true)}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-white/10 text-sm font-bold py-2.5 transition cursor-pointer"
              >
                <Settings className="w-4 h-4 text-slate-300" />
                <span>Settings / Controls</span>
              </button>
              {!isInstalled && isInstallable && (
                <button
                  type="button"
                  onClick={() => {
                    void install();
                  }}
                  className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold py-2.5 transition cursor-pointer"
                >
                  <Download className="w-4 h-4" />
                  <span>Install App (Offline)</span>
                </button>
              )}
              {!isInstalled && !isInstallable && isIOS && (
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(true)}
                  className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-white/10 text-sm font-bold py-2.5 transition cursor-pointer"
                >
                  <Download className="w-4 h-4 text-emerald-400" />
                  <span>Install on iOS</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* PAUSE MODAL */}
      {screen === 'paused' && !showSettings && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/72 p-3 sm:p-4">
          <div className="w-full max-w-sm max-h-[calc(100%-1rem)] overflow-y-auto rounded-3xl bg-slate-900 border border-white/15 p-5 sm:p-6 text-center shadow-2xl">
            <h2 className="text-2xl font-black mb-4 sm:mb-5">Race Paused</h2>
            <div className="flex flex-col gap-2.5">
              <button
                type="button"
                onClick={() => setScreen('racing')}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black py-3 transition cursor-pointer"
              >
                <Play className="w-4 h-4" />
                <span>Resume Race</span>
              </button>
              <button
                type="button"
                onClick={() => setShowSettings(true)}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-white/10 font-bold py-2.5 transition cursor-pointer"
              >
                <Settings className="w-4 h-4 text-slate-300" />
                <span>Settings / Controls</span>
              </button>
              <button
                type="button"
                onClick={handleRestartRace}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-white/10 font-bold py-2.5 transition cursor-pointer"
              >
                <RotateCcw className="w-4 h-4 text-sky-400" />
                <span>Restart Race</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  if (simRef.current.resetRace) simRef.current.resetRace();
                  setScreen('menu');
                }}
                className="w-full rounded-xl bg-slate-800/80 hover:bg-red-950/70 border border-white/10 text-slate-300 font-bold py-2.5 transition cursor-pointer"
              >
                Exit to Main Menu
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SETTINGS / CONTROLS MODAL */}
      {showSettings && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-950/78 p-3 sm:p-4">
          <div className="w-full max-w-sm max-h-[calc(100%-1rem)] overflow-y-auto rounded-3xl bg-slate-900 border border-white/15 p-5 sm:p-6 shadow-2xl">
            <h2 className="text-xl font-black mb-4">Settings & Controls</h2>

            <div className="mb-4 flex items-center justify-between rounded-xl bg-slate-800/80 border border-white/10 px-4 py-3">
              <div>
                <div className="text-sm font-bold">On-Screen Controls</div>
                <div className="text-xs text-slate-400">Show touch/click driving buttons</div>
              </div>
              <button
                type="button"
                onClick={() => setShowTouchControls((v) => !v)}
                className={`px-3.5 py-1.5 rounded-lg text-xs font-black transition cursor-pointer ${
                  showTouchControls ? 'bg-emerald-500 text-slate-950' : 'bg-slate-700 text-slate-300'
                }`}
              >
                {showTouchControls ? 'Shown' : 'Hidden'}
              </button>
            </div>

            <div className="mb-5 rounded-xl bg-slate-800/80 border border-white/10 px-4 py-3">
              <div className="flex justify-between text-sm font-bold mb-2">
                <span>Button Size</span>
                <span className="text-amber-400 tabular-nums">{Math.round(controlsScale * 100)}%</span>
              </div>
              <input
                type="range"
                min="0.5"
                max="1.5"
                step="0.05"
                value={controlsScale}
                onChange={(e) => setControlsScale(parseFloat(e.target.value))}
                className="w-full accent-amber-500 cursor-pointer"
              />
              <div className="flex justify-between text-[11px] text-slate-400 mt-1 tabular-nums">
                <span>50%</span>
                <span>100%</span>
                <span>150%</span>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setShowSettings(false)}
              className="w-full rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black py-3 transition cursor-pointer"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {/* FINISH SCREEN */}
      {screen === 'finished' && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/78 p-3 sm:p-4">
          <div className="w-full max-w-md max-h-[calc(100%-1rem)] overflow-y-auto rounded-3xl bg-slate-900 border border-white/15 p-5 sm:p-8 shadow-2xl">
            <div className="text-center mb-4 sm:mb-5">
              <p className="text-xs uppercase tracking-widest text-amber-400 font-bold">Checkered Flag</p>
              <h2 className="mt-1 inline-flex items-center justify-center gap-2 text-2xl sm:text-3xl font-black">
                {standings[0]?.isPlayer && <Trophy className="w-6 h-6 sm:w-7 sm:h-7 text-amber-400" />}
                <span>
                  {standings[0]?.isPlayer
                    ? 'Victory!'
                    : `Finished ${ordinal(standings.findIndex((s) => s.isPlayer) + 1 || 1)}`}
                </span>
              </h2>
            </div>

            <div className="space-y-2 mb-5 sm:mb-6">
              {standings.map((row, idx) => (
                <div
                  key={row.id}
                  className={`flex items-center justify-between rounded-xl px-4 py-2.5 sm:py-3 border ${
                    row.isPlayer ? 'bg-amber-500/18 border-amber-400/50' : 'bg-slate-800/80 border-white/10'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span className="font-black text-slate-300 w-7 tabular-nums">{ordinal(idx + 1)}</span>
                    <span
                      className="w-3.5 h-3.5 rounded-full border border-white/40"
                      style={{ backgroundColor: row.swatch }}
                    />
                    <span className="font-bold">{row.name}</span>
                  </div>
                  <div className="font-mono text-sm font-bold text-slate-200 tabular-nums">
                    {row.finished ? formatRaceTime(row.finishTimeMs) : `Lap ${row.lap}/${totalLaps}`}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={handleRestartRace}
                className="flex-1 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black py-3 sm:py-3.5 shadow-lg transition cursor-pointer"
              >
                Race Again
              </button>
              <button
                type="button"
                onClick={() => {
                  if (simRef.current.resetRace) simRef.current.resetRace();
                  setScreen('menu');
                }}
                className="rounded-xl bg-slate-800 hover:bg-slate-700 border border-white/10 px-5 font-bold py-3 sm:py-3.5 transition cursor-pointer"
              >
                Menu
              </button>
            </div>
          </div>
        </div>
      )}

      {/* iOS SAFARI INSTALL GUIDE MODAL */}
      {showIOSGuide && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-slate-950/82 p-4">
          <div className="w-full max-w-sm rounded-3xl bg-slate-900 border border-white/15 p-6 shadow-2xl">
            <h2 className="text-lg font-black mb-2">Install on iPhone / iPad</h2>
            <p className="text-sm text-slate-300 leading-relaxed mb-5">
              1. Tap the <strong>Share</strong> button in the Safari toolbar.
              <br />
              2. Scroll down and tap <strong>Add to Home Screen</strong> to play offline anytime.
            </p>
            <button
              type="button"
              onClick={() => setShowIOSGuide(false)}
              className="w-full rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black py-3 transition cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* OFFLINE STATUS INDICATOR */}
      {!isOnline && (
        <div className="pointer-events-none fixed top-3 left-1/2 -translate-x-1/2 z-40 inline-flex items-center gap-2 rounded-lg bg-amber-600/95 border border-amber-300/40 px-3 py-1.5 text-xs font-bold text-white shadow-lg">
          <WifiOff className="w-3.5 h-3.5" />
          <span>Offline Mode · Cached Game Active</span>
        </div>
      )}
    </div>
  );
}

// player.js — Phase Shift Operator
// One looped stem (Mass). Subtle autonomous drift + obvious temporary "stress" on interaction.
// Fixes brightening over time by damping the delay feedback loop.
// Makes interaction more unstable: motion shock + flutter + pitch wobble + stronger drive.
// Adds a 3s fade-in on Play (and a short fade-out on Pause) so playback is not jarring.

const FILE = "audio/mass.m4a";

// Timing
const RAMP = 0.06;
const START_FADE_SECONDS = 3.0;
const STOP_FADE_SECONDS = 0.25;

// Base tuning (subtle)
const BASE = {
  gain: 0.95,
  lowpassHz: 5200,
  highpassHz: 40,
  wet: 0.06,
  feedback: 0.12,
  delayTime: 0.045,
  drive: 0.02,
  width: 0.92, // 1 = fully stereo, 0 = mono
};

// Delay damping (prevents runaway brightness / harshness)
const ECHO_DAMP = {
  hpHz: 140,
  lpHzBase: 2200,
  lpHzMin: 900, // stress pushes it darker
};

// Stress tuning (added on top when user interacts)
const STRESS = {
  highpassAddHz: 1600,
  lowpassMul: 0.35,
  wetAdd: 0.32,
  feedbackAdd: 0.20,
  driveAdd: 0.18,
  widthTarget: 0.06,
  sheenMax: 0.70,

  // new instability
  pitchCentsMax: 18,      // +/- cents
  delayJitterMsMax: 18,   // +/- ms
  motionKickMax: 0.55,    // extra stress from fast movement
};

// Drift (autonomous)
const DRIFT = {
  lpDepthHz: 700,
  lpPeriodSec: 52,
  widthDepth: 0.06,
  widthPeriodSec: 36,
  delayWarbleMs: 6,
  delayWarblePeriodSec: 11,
};

// State
let audioCtx = null;
let buffer = null;
let source = null;

let isReady = false;
let isPlaying = false;

let nodes = null;
let driftTimers = null;

let stress = 0;
let stressTarget = 0;
let rafId = null;

// velocity shock state
let lastPtr = null;   // {x,y,t}
let motionKick = 0;   // 0..~0.55

// UI
const statusEl = document.getElementById("status");
const enterBtn = document.getElementById("enterBtn");
const playPauseBtn = document.getElementById("playPauseBtn");
const stateReadoutEl = document.getElementById("stateReadout");
const specEl = document.getElementById("spec");
const wrapEl = document.getElementById("wrap");

const operatorEl = document.getElementById("operator");
const sheenEl = document.getElementById("stressSheen");

enterBtn.addEventListener("click", onEnter);
playPauseBtn.addEventListener("click", togglePlay);

// Interaction (pointer)
operatorEl.addEventListener("pointerdown", onPointerDown);
operatorEl.addEventListener("pointermove", onPointerMove);
window.addEventListener("pointerup", onPointerUp);

function setStatus(msg) {
  statusEl.textContent = msg;
  const isLoading = (msg === "INITIALIZING" || msg === "LOADING");
  statusEl.classList.toggle("loading", isLoading);
}

async function onEnter() {
  if (isReady) return;

  try {
    setStatus("INITIALIZING");
    enterBtn.disabled = true;

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    setStatus("LOADING");
    buffer = await fetchDecode(FILE);

    buildGraph();

    isReady = true;
    wrapEl.classList.remove("standby");
    wrapEl.classList.add("active");

    playPauseBtn.disabled = false;

    setStatus("ACTIVE");
    stateReadoutEl.textContent = "FIELD STABLE";
    specEl.innerHTML = `PHASE NODE: <a href="https://liberandos.com" target="_blank" rel="noopener" class="la5">LA5</a> · MODE: DRIFT · STATUS: ACTIVE`;
  } catch (e) {
    console.error(e);
    setStatus("ERROR");
    enterBtn.disabled = false;
    specEl.textContent = "PHASE NODE: LA5 · MODE: DRIFT · STATUS: ERROR";
  }
}

async function fetchDecode(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load: ${url}`);
  const arr = await res.arrayBuffer();
  return await audioCtx.decodeAudioData(arr);
}

function buildGraph() {
  // Master
  const master = audioCtx.createGain();
  master.gain.value = 0.0; // fade in on play
  master.connect(audioCtx.destination);

  // Stereo -> Mono crossfade
  const stereoGain = audioCtx.createGain();
  const monoGain = audioCtx.createGain();

  // Split + sum to mono
  const splitter = audioCtx.createChannelSplitter(2);
  const merger = audioCtx.createChannelMerger(2);
  const monoSum = audioCtx.createGain();

  const lHalf = audioCtx.createGain(); lHalf.gain.value = 0.5;
  const rHalf = audioCtx.createGain(); rHalf.gain.value = 0.5;

  // FX chain (shared pre width mix)
  const highpass = audioCtx.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = BASE.highpassHz;
  highpass.Q.value = 0.7;

  const lowpass = audioCtx.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = BASE.lowpassHz;
  lowpass.Q.value = 0.7;

  // Delay send bus
  const delay = audioCtx.createDelay(1.0);
  delay.delayTime.value = BASE.delayTime;

  const feedback = audioCtx.createGain();
  feedback.gain.value = BASE.feedback;

  const wetGain = audioCtx.createGain();
  wetGain.gain.value = BASE.wet;

  const dryGain = audioCtx.createGain();
  dryGain.gain.value = 1.0;

  // Damping filters INSIDE the feedback loop (prevents runaway brightness)
  const echoHP = audioCtx.createBiquadFilter();
  echoHP.type = "highpass";
  echoHP.frequency.value = ECHO_DAMP.hpHz;
  echoHP.Q.value = 0.7;

  const echoLP = audioCtx.createBiquadFilter();
  echoLP.type = "lowpass";
  echoLP.frequency.value = ECHO_DAMP.lpHzBase;
  echoLP.Q.value = 0.7;

  // Drive on wet only
  const shaper = audioCtx.createWaveShaper();
  shaper.curve = makeSoftClipCurve(BASE.drive);
  shaper.oversample = "2x";

  // feedback loop WITH damping:
  // delay -> echoHP -> echoLP -> feedback -> delay
  delay.connect(echoHP);
  echoHP.connect(echoLP);
  echoLP.connect(feedback);
  feedback.connect(delay);

  // wet taps after damping
  echoLP.connect(shaper);
  shaper.connect(wetGain);

  // Width mixer output
  const widthOut = audioCtx.createGain();
  stereoGain.connect(widthOut);
  monoGain.connect(widthOut);
  widthOut.connect(master);

  nodes = {
    master,
    // width
    stereoGain,
    monoGain,
    splitter,
    merger,
    monoSum,
    lHalf,
    rHalf,
    // filters
    highpass,
    lowpass,
    // delay + damping
    delay,
    feedback,
    echoHP,
    echoLP,
    wetGain,
    dryGain,
    shaper,
    // out
    widthOut,
  };

  setWidth(BASE.width);
  startDrift();
  startStressLoop();
}

function buildSource() {
  const s = audioCtx.createBufferSource();
  s.buffer = buffer;
  s.loop = true;
  s.loopStart = 0;
  s.loopEnd = buffer.duration;

  // source -> filters
  s.connect(nodes.highpass);
  nodes.highpass.connect(nodes.lowpass);

  // filtered taps
  nodes.lowpass.connect(nodes.dryGain);
  nodes.lowpass.connect(nodes.delay);

  // dry path into width mixer (stereo + mono)
  nodes.dryGain.connect(nodes.stereoGain);

  nodes.dryGain.connect(nodes.splitter);
  nodes.splitter.connect(nodes.lHalf, 0);
  nodes.splitter.connect(nodes.rHalf, 1);
  nodes.lHalf.connect(nodes.monoSum);
  nodes.rHalf.connect(nodes.monoSum);
  nodes.monoSum.connect(nodes.merger, 0, 0);
  nodes.monoSum.connect(nodes.merger, 0, 1);
  nodes.merger.connect(nodes.monoGain);

  // wet stays stereo (mono derived from dry)
  nodes.wetGain.connect(nodes.stereoGain);

  source = s;
}

function fadeMasterIn() {
  const t0 = audioCtx.currentTime;
  nodes.master.gain.cancelScheduledValues(t0);
  nodes.master.gain.setValueAtTime(0.0001, t0);
  nodes.master.gain.exponentialRampToValueAtTime(BASE.gain, t0 + START_FADE_SECONDS);
}

function fadeMasterOut() {
  const t0 = audioCtx.currentTime;
  nodes.master.gain.cancelScheduledValues(t0);
  nodes.master.gain.setValueAtTime(Math.max(0.0001, nodes.master.gain.value), t0);
  nodes.master.gain.exponentialRampToValueAtTime(0.0001, t0 + STOP_FADE_SECONDS);
}

function togglePlay() {
  if (!isReady) return;

  if (!isPlaying) {
    if (audioCtx.state === "suspended") audioCtx.resume();

    buildSource();

    // ensure master starts silent then fades up
    fadeMasterIn();

    source.start(audioCtx.currentTime + 0.02);

    isPlaying = true;
    playPauseBtn.textContent = "Pause";
    setStatus("RUNNING");
    specEl.innerHTML = specEl.innerHTML.replace(/STATUS:\s*\w+/i, "STATUS: RUNNING");
  } else {
    // fade down before stopping to avoid clicks
    fadeMasterOut();

    const stopDelayMs = Math.ceil(STOP_FADE_SECONDS * 1000) + 30;
    const s = source;
    setTimeout(() => {
      try { s?.stop(); } catch {}
    }, stopDelayMs);

    source = null;

    isPlaying = false;
    playPauseBtn.textContent = "Play";
    setStatus("HOLD");
    specEl.innerHTML = specEl.innerHTML.replace(/STATUS:\s*\w+/i, "STATUS: HOLD");
  }
}

function setWidth(w) {
  nodes.stereoGain.gain.value = clamp01(w);
  nodes.monoGain.gain.value = clamp01(1 - w);
}

// Interaction mapping
function onPointerDown(e) {
  if (!isReady) return;
  operatorEl.setPointerCapture?.(e.pointerId);
  updateStressFromPointer(e);
}
function onPointerMove(e) {
  if (!isReady) return;
  if (e.buttons === 0) return;
  updateStressFromPointer(e);
}
function onPointerUp() {
  stressTarget = 0;
  lastPtr = null;
}

function updateStressFromPointer(e) {
  const rect = operatorEl.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  const dx = (e.clientX - cx) / (rect.width / 2);
  const dy = (e.clientY - cy) / (rect.height / 2);

  const r = Math.sqrt(dx * dx + dy * dy);

  // stronger near center
  const inside = clamp01(1 - r);
  const shaped = Math.pow(inside, 0.65);

  // velocity-based kick
  const now = performance.now();
  if (lastPtr) {
    const dt = Math.max(8, now - lastPtr.t);
    const vx = (e.clientX - lastPtr.x) / dt;
    const vy = (e.clientY - lastPtr.y) / dt;
    const v = Math.sqrt(vx * vx + vy * vy); // px/ms

    const kick = clamp01((v - 0.10) / 0.55);
    motionKick = Math.max(motionKick, kick * STRESS.motionKickMax);
  }
  lastPtr = { x: e.clientX, y: e.clientY, t: now };

  stressTarget = clamp01(shaped + motionKick);

  stateReadoutEl.textContent = (stressTarget > 0.08) ? "PHASE STRESS" : "FIELD STABLE";
}

// Smooth stress loop (visual + audio)
function startStressLoop() {
  if (rafId) cancelAnimationFrame(rafId);

  const step = () => {
    if (!audioCtx || !nodes) return;

    // Smooth approach
    stress += (stressTarget - stress) * 0.10;
    const s = clamp01(stress);

    // decay motionKick over time (shock fades)
    motionKick *= 0.92;
    if (motionKick < 0.001) motionKick = 0;

    // Filters (more dramatic)
    const hp = BASE.highpassHz + STRESS.highpassAddHz * s;
    const lp = Math.max(250, BASE.lowpassHz * (1 - (1 - STRESS.lowpassMul) * s));

    smoothParam(nodes.highpass.frequency, hp);
    smoothParam(nodes.lowpass.frequency, lp);

    // Dampen echo more as stress increases (keeps it controlled + "archival")
    const echoLp = lerp(ECHO_DAMP.lpHzBase, ECHO_DAMP.lpHzMin, s);
    smoothParam(nodes.echoLP.frequency, echoLp);

    // Delay / feedback / wet (bounded)
    smoothParam(nodes.feedback.gain, clamp(BASE.feedback + STRESS.feedbackAdd * s, 0, 0.35));
    smoothParam(nodes.wetGain.gain, clamp(BASE.wet + STRESS.wetAdd * s, 0, 0.55));

    // Delay-time jitter under stress (flutter)
    const jit = (Math.sin(audioCtx.currentTime * 10.7) + Math.sin(audioCtx.currentTime * 6.3)) * 0.5;
    const jitterSec = (jit * STRESS.delayJitterMsMax * s) / 1000;
    const dt = clamp(BASE.delayTime + jitterSec, 0.015, 0.12);
    smoothParam(nodes.delay.delayTime, dt);

    // Drive update (stronger response)
    const drive = BASE.drive + STRESS.driveAdd * s;
    nodes.shaper.curve = makeSoftClipCurve(drive);

    // Width collapse
    const w = lerp(BASE.width, STRESS.widthTarget, s);
    setWidth(w);

    // Pitch wobble (playbackRate) under stress
    if (source) {
      const centsMax = STRESS.pitchCentsMax * s;
      const wob = Math.sin(audioCtx.currentTime * 3.1) * 0.6 + Math.sin(audioCtx.currentTime * 5.0) * 0.4;
      const centsNow = wob * centsMax;
      const rate = Math.pow(2, centsNow / 1200);
      source.playbackRate.setTargetAtTime(rate, audioCtx.currentTime, 0.03);
    }

    // UI sheen
    if (sheenEl) sheenEl.style.opacity = String(STRESS.sheenMax * s);

    rafId = requestAnimationFrame(step);
  };

  rafId = requestAnimationFrame(step);
}

function smoothParam(param, value) {
  const t0 = audioCtx.currentTime;
  param.cancelScheduledValues(t0);
  param.setValueAtTime(param.value, t0);
  param.linearRampToValueAtTime(value, t0 + RAMP);
}

// Autonomous drift
function startDrift() {
  stopDrift();
  const tStart = audioCtx.currentTime;

  const driftTick = () => {
    if (!audioCtx || !nodes) return;

    const t = audioCtx.currentTime - tStart;

    // Lowpass drift (slow)
    const lp = BASE.lowpassHz + Math.sin((2 * Math.PI * t) / DRIFT.lpPeriodSec) * DRIFT.lpDepthHz;

    // Delay warble (idle subtle)
    const warble = (Math.sin((2 * Math.PI * t) / DRIFT.delayWarblePeriodSec) * DRIFT.delayWarbleMs) / 1000;
    const dt = clamp(BASE.delayTime + warble, 0.01, 0.12);

    // Width breathing
    const wb = Math.sin((2 * Math.PI * t) / DRIFT.widthPeriodSec) * DRIFT.widthDepth;
    const width = clamp01(BASE.width + wb);

    smoothParam(nodes.lowpass.frequency, lp);

    // only apply idle warble when not stressed
    if (stress < 0.02) smoothParam(nodes.delay.delayTime, dt);
    if (stress < 0.02) setWidth(width);

    driftTimers = setTimeout(driftTick, 600);
  };

  driftTick();
}

function stopDrift() {
  if (driftTimers) {
    clearTimeout(driftTimers);
    driftTimers = null;
  }
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}
function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}

function makeSoftClipCurve(amount) {
  // amount ~ 0.0..0.25
  const n = 44100;
  const curve = new Float32Array(n);
  const k = Math.max(0.0001, amount * 90);
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

// Default visuals
(function initUI() {
  setStatus("STANDBY");
  stateReadoutEl.textContent = "FIELD STABLE";
})();

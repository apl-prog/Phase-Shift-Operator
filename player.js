// player.js — Phase Shift Operator
// One looped stem (Mass). Subtle autonomous drift + obvious temporary "stress" on interaction.

const FILE = "audio/mass.m4a";

// Timing
const RAMP = 0.06;

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

// Stress tuning (added on top when user interacts)
const STRESS = {
  // At stress=1:
  highpassAddHz: 1200,
  lowpassMul: 0.45,     // reduce LP
  wetAdd: 0.22,
  feedbackAdd: 0.18,
  driveAdd: 0.12,
  widthTarget: 0.12,    // collapse close to mono
  sheenMax: 0.55,       // UI glow
};

// Drift (autonomous)
const DRIFT = {
  lpDepthHz: 700,         // +/- around base
  lpPeriodSec: 52,        // slow sweep
  widthDepth: 0.06,       // small breathing
  widthPeriodSec: 36,
  delayWarbleMs: 6,       // +/- ms
  delayWarblePeriodSec: 11,
};

// State
let audioCtx = null;
let buffer = null;
let source = null;

let isReady = false;
let isPlaying = false;

let nodes = null; // graph nodes
let driftTimers = null;

let stress = 0;          // smoothed current stress 0..1
let stressTarget = 0;    // target stress from pointer
let rafId = null;

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
  master.gain.value = BASE.gain;
  master.connect(audioCtx.destination);

  // Stereo -> Mono crossfade
  // stereoPath: postFX stereo as-is
  const stereoGain = audioCtx.createGain();
  const monoGain = audioCtx.createGain();

  // Split + sum to mono
  const splitter = audioCtx.createChannelSplitter(2);
  const merger = audioCtx.createChannelMerger(2);
  const monoSum = audioCtx.createGain(); // sums inputs

  const lHalf = audioCtx.createGain(); lHalf.gain.value = 0.5;
  const rHalf = audioCtx.createGain(); rHalf.gain.value = 0.5;

  // Route for mono sum:
  // splitter.L -> 0.5 -> monoSum
  // splitter.R -> 0.5 -> monoSum
  // monoSum -> both merger channels
  // Note: a GainNode sums multiple connections automatically.
  // Connections:
  //   src -> splitter
  //   splitter[0] -> lHalf -> monoSum
  //   splitter[1] -> rHalf -> monoSum
  //   monoSum -> merger[0] and merger[1]
  // Done later when source exists.

  // FX chain (shared pre width mix)
  const highpass = audioCtx.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = BASE.highpassHz;
  highpass.Q.value = 0.7;

  const lowpass = audioCtx.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = BASE.lowpassHz;
  lowpass.Q.value = 0.7;

  // Delay send bus (simple)
  const delay = audioCtx.createDelay(1.0);
  delay.delayTime.value = BASE.delayTime;

  const feedback = audioCtx.createGain();
  feedback.gain.value = BASE.feedback;

  const wetGain = audioCtx.createGain();
  wetGain.gain.value = BASE.wet;

  const dryGain = audioCtx.createGain();
  dryGain.gain.value = 1.0;

  // Drive on wet only (keeps it “present but not crunchy”)
  const shaper = audioCtx.createWaveShaper();
  shaper.curve = makeSoftClipCurve(BASE.drive);
  shaper.oversample = "2x";

  // feedback loop
  delay.connect(feedback);
  feedback.connect(delay);

  // Wet chain
  delay.connect(shaper);
  shaper.connect(wetGain);

  // Dry chain
  // (dryGain just passes the filtered signal)
  // Both dry and wet feed the width mixer.
  // We'll connect filtered signal to dryGain and also to delay.

  // Width mixer output
  const widthOut = audioCtx.createGain();

  // stereoGain + monoGain -> widthOut -> master
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
    // delay
    delay,
    feedback,
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

  // Wire: source -> filters -> dry+delay -> (dryGain and wetGain) -> width mixer
  // Pre-FX stage:
  s.connect(nodes.highpass);
  nodes.highpass.connect(nodes.lowpass);

  // filtered signal taps
  nodes.lowpass.connect(nodes.dryGain);
  nodes.lowpass.connect(nodes.delay);

  // dry path into width mixer (stereo + mono)
  // For stereo: dryGain -> stereoGain
  nodes.dryGain.connect(nodes.stereoGain);

  // For mono: dryGain -> splitter -> monoSum -> merger -> monoGain
  nodes.dryGain.connect(nodes.splitter);
  nodes.splitter.connect(nodes.lHalf, 0);
  nodes.splitter.connect(nodes.rHalf, 1);
  nodes.lHalf.connect(nodes.monoSum);
  nodes.rHalf.connect(nodes.monoSum);
  nodes.monoSum.connect(nodes.merger, 0, 0);
  nodes.monoSum.connect(nodes.merger, 0, 1);
  nodes.merger.connect(nodes.monoGain);

  // wet path into width mixer (wet stays stereo; mono will be derived from dry only)
  nodes.wetGain.connect(nodes.stereoGain);

  source = s;
}

function togglePlay() {
  if (!isReady) return;

  if (!isPlaying) {
    if (audioCtx.state === "suspended") audioCtx.resume();

    buildSource();
    source.start(audioCtx.currentTime + 0.02);

    isPlaying = true;
    playPauseBtn.textContent = "Pause";
    setStatus("RUNNING");
    specEl.innerHTML = specEl.innerHTML.replace(/STATUS:\s*\w+/i, "STATUS: RUNNING");
  } else {
    try { source.stop(); } catch {}
    source = null;

    isPlaying = false;
    playPauseBtn.textContent = "Play";
    setStatus("HOLD");
    specEl.innerHTML = specEl.innerHTML.replace(/STATUS:\s*\w+/i, "STATUS: HOLD");
  }
}

function setWidth(w) {
  // Crossfade between stereo (1) and mono (0)
  // keep power-ish consistency (not perfect, but stable)
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
}

function updateStressFromPointer(e) {
  const rect = operatorEl.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  const dx = (e.clientX - cx) / (rect.width / 2);
  const dy = (e.clientY - cy) / (rect.height / 2);

  const r = Math.sqrt(dx*dx + dy*dy);

  // Inside circle: r ~ 0..1. Clamp.
  // Stress is stronger near center (more “dangerous”).
  const inside = clamp01(1 - r);
  const shaped = Math.pow(inside, 0.7);

  stressTarget = shaped;

  // UI readout becomes more explicit under stress
  if (shaped > 0.06) {
    stateReadoutEl.textContent = "PHASE STRESS";
  } else {
    stateReadoutEl.textContent = "FIELD STABLE";
  }
}

// Smooth stress loop (visual + audio)
function startStressLoop() {
  if (rafId) cancelAnimationFrame(rafId);

  const step = () => {
    if (!audioCtx || !nodes) return;

    // Smooth approach
    stress += (stressTarget - stress) * 0.10;

    // Apply stress to parameters
    const s = clamp01(stress);

    // Filters
    const hp = BASE.highpassHz + STRESS.highpassAddHz * s;
    const lp = Math.max(250, BASE.lowpassHz * (1 - (1 - STRESS.lowpassMul) * s));

    smoothParam(nodes.highpass.frequency, hp);
    smoothParam(nodes.lowpass.frequency, lp);

    // Delay / feedback / wet
    smoothParam(nodes.feedback.gain, BASE.feedback + STRESS.feedbackAdd * s);
    smoothParam(nodes.wetGain.gain, BASE.wet + STRESS.wetAdd * s);

    // Drive curve update (cheap enough at this rate because it’s small)
    const drive = BASE.drive + STRESS.driveAdd * s;
    nodes.shaper.curve = makeSoftClipCurve(drive);

    // Width collapse
    const w = lerp(BASE.width, STRESS.widthTarget, s);
    setWidth(w);

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
    // Delay time warble (tiny, in seconds)
    const warble = (Math.sin((2 * Math.PI * t) / DRIFT.delayWarblePeriodSec) * DRIFT.delayWarbleMs) / 1000;
    const dt = clamp(BASE.delayTime + warble, 0.01, 0.12);

    // Width breathing
    const wb = Math.sin((2 * Math.PI * t) / DRIFT.widthPeriodSec) * DRIFT.widthDepth;
    const width = clamp01(BASE.width + wb);

    // Only apply drift gently (stress loop will overwrite with ramps anyway)
    // We set base values via smoothParam to keep movement subtle.
    smoothParam(nodes.lowpass.frequency, lp);
    smoothParam(nodes.delay.delayTime, dt);
    // Width is handled by setWidth directly (no AudioParam)
    if (stress < 0.02) setWidth(width);

    driftTimers = setTimeout(driftTick, 600); // slow control rate
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
  // amount ~ 0.0..0.25 (this design uses ~0.02..0.14)
  const n = 44100;
  const curve = new Float32Array(n);
  const k = Math.max(0.0001, amount * 60);
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

// Default visuals
(function initUI(){
  setStatus("STANDBY");
  stateReadoutEl.textContent = "FIELD STABLE";
})();
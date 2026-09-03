import { WoodcockPuppet, clamp } from './puppet.js';
import puppetManifest from '../../assets/character/puppet-v4/manifest.js';

const desktop = window.meepDesktop;
const STORAGE_KEY = 'meep-bird-timer-v3';
const LEGACY_STORAGE_KEY = 'meep-bird-timer-v2';

// The renderer owns the state; the menu-bar tray is the settings UI.  These
// strings cover the little in-window bits (the chip, the hover hint); the tray
// menu has its own strings in the main process.
const STRINGS = {
  en: {
    ready: 'Ready',
    paused: 'Paused',
    focusing: 'Focus',
    resting: 'Break',
    start: 'Resume',
    pause: 'Pause',
    stop: 'Stop',
    reset: 'Restart the cycle',
    meep: 'Meep!',
    hint: 'Hover for the timer · double-click to start',
    canvasLabel: 'Double-click to start or pause the timer; hold and drag to carry the bird'
  },
  zh: {
    ready: '准备好了',
    paused: '已暂停',
    focusing: '专注中',
    resting: '休息中',
    start: '继续',
    pause: '暂停',
    stop: '停止',
    reset: '重新开始',
    meep: '来一声 meep',
    hint: '悬停看计时 · 双击开始',
    canvasLabel: '双击开始或暂停计时，按住拖动可以把鸟拎走'
  }
};
let language = 'en';
const t = (key) => (STRINGS[language] && STRINGS[language][key]) || STRINGS.en[key] || key;

const defaults = {
  phase: 'focus',
  focusMinutes: 30,
  restMinutes: 5,
  remainingSeconds: 30 * 60,
  running: false,
  endAt: null,
  cyclesCompleted: 0,
  muted: false,
  walkEnabled: true,
  walkIntervalMinutes: 15,
  nextWalkAt: null,
  language: 'en',
  chipPinned: false,
  birdScale: 1,
  birdOpacity: 1
};

function loadState() {
  try {
    let saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!saved) {
      // First run of the cycle-only build: keep the old build's settings, drop
      // its timer state (modes, presets and half-finished countdowns).
      const legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || 'null') || {};
      saved = {
        focusMinutes: legacy.focusMinutes,
        restMinutes: legacy.restMinutes,
        muted: legacy.muted,
        walkEnabled: legacy.walkEnabled,
        walkIntervalMinutes: legacy.walkIntervalMinutes,
        language: legacy.language
      };
    }
    const next = { ...defaults, ...saved };
    next.phase = next.phase === 'rest' ? 'rest' : 'focus';
    next.focusMinutes = clamp(Number(next.focusMinutes) || 30, 1, 180);
    next.restMinutes = clamp(Number(next.restMinutes) || 5, 1, 60);
    next.remainingSeconds = Math.max(0, Number(next.remainingSeconds) || 0);
    if (!next.remainingSeconds) {
      next.remainingSeconds = (next.phase === 'rest' ? next.restMinutes : next.focusMinutes) * 60;
    }
    next.cyclesCompleted = Math.max(0, Number(next.cyclesCompleted) || 0);
    next.running = Boolean(next.running && Number(next.endAt));
    next.endAt = next.running ? Number(next.endAt) : null;
    next.muted = Boolean(next.muted);
    next.walkEnabled = next.walkEnabled !== false;
    next.walkIntervalMinutes = clamp(Number(next.walkIntervalMinutes) || 15, 5, 60);
    next.language = next.language === 'zh' ? 'zh' : 'en';
    next.chipPinned = Boolean(next.chipPinned);
    next.birdScale = clamp(Number(next.birdScale) || 1, 0.7, 1.6);
    next.birdOpacity = clamp(Number(next.birdOpacity) || 1, 0.35, 1);
    const savedWalkTime = Number(next.nextWalkAt);
    if (next.walkEnabled) {
      next.nextWalkAt = savedWalkTime > Date.now()
        ? savedWalkTime
        : Date.now() + next.walkIntervalMinutes * 60_000;
    } else {
      next.nextWalkAt = null;
    }
    return next;
  } catch {
    return {
      ...defaults,
      nextWalkAt: Date.now() + defaults.walkIntervalMinutes * 60_000
    };
  }
}

const state = loadState();
let walking = false;
let walkRequestPending = false;
let dragging = false;
let airborne = false;
let lastRenderedSecond = -1;
let lastTraySignature = '';

const elements = {
  body: document.body,
  timerChip: document.querySelector('#timerChip'),
  chipPause: document.querySelector('#chipPause'),
  chipReset: document.querySelector('#chipReset'),
  chipStop: document.querySelector('#chipStop'),
  chipMeep: document.querySelector('#chipMeep'),
  chipTime: document.querySelector('#chipTime'),
  chipLabel: document.querySelector('#chipLabel'),
  alarmCaption: document.querySelector('#alarmCaption'),
  idleHint: document.querySelector('#idleHint'),
  groundShadow: document.querySelector('.ground-shadow'),
  birdCanvas: document.querySelector('#birdCanvas')
};

// Several takes of the two-note meep; every call picks one at random (never
// the same twice in a row) so the bird doesn't sound like a sample loop.
const MEEP_SOUNDS = ['meep-pair.wav', 'meep-pair-b.wav', 'meep-pair-c.wav'];
const meepPool = MEEP_SOUNDS.map((file) => {
  const audio = new Audio(`../../assets/audio/${file}`);
  audio.preload = 'auto';
  audio.volume = 0.92;
  return audio;
});
let lastMeepIndex = -1;

function playMeepSound() {
  if (state.muted || !meepPool.length) return;
  let index = Math.floor(Math.random() * meepPool.length);
  if (meepPool.length > 1 && index === lastMeepIndex) {
    index = (index + 1) % meepPool.length;
  }
  lastMeepIndex = index;
  const audio = meepPool[index];
  audio.currentTime = 0;
  audio.play().catch(() => {});
}

function totalSecondsForCurrentPhase() {
  return (state.phase === 'rest' ? state.restMinutes : state.focusMinutes) * 60;
}

function formatTime(seconds) {
  const safe = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(safe / 60);
  const remainder = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function currentLabel() {
  return state.phase === 'rest' ? t('resting') : t('focusing');
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function resetRemaining() {
  state.remainingSeconds = totalSecondsForCurrentPhase();
  state.endAt = null;
}

function clearAlarmTimers() {
  for (const timer of alarmTimers) clearTimeout(timer);
  alarmTimers = [];
}

function pauseTimer() {
  if (!state.running) return;
  state.remainingSeconds = Math.max(0, Math.ceil((state.endAt - Date.now()) / 1000));
  state.running = false;
  state.endAt = null;
  if (walking) desktop.cancelWalk();
  persist();
  render();
}

function resumeTimer() {
  if (state.running) return;
  if (state.remainingSeconds <= 0) resetRemaining();
  state.running = true;
  state.endAt = Date.now() + state.remainingSeconds * 1000;
  persist();
  render();
  // Resuming mid-break: pick the walk back up if there is enough time left.
  if (state.phase === 'rest') alarmTimers.push(setTimeout(startBreakWalk, 450));
}

function toggleTimer() {
  if (state.running) pauseTimer();
  else resumeTimer();
}

/** Chip ↺ / tray Restart: back to the top of a fresh focus block. */
function restartCycle() {
  clearAlarmTimers();
  if (walking) desktop.cancelWalk();
  state.phase = 'focus';
  state.cyclesCompleted = 0;
  state.remainingSeconds = state.focusMinutes * 60;
  state.endAt = state.running ? Date.now() + state.remainingSeconds * 1000 : null;
  state.running = Boolean(state.endAt);
  persist();
  render();
}

/** Chip ■ / tray Stop: stop entirely and go back to Ready. */
function stopTimer() {
  clearAlarmTimers();
  if (walking) desktop.cancelWalk();
  state.running = false;
  state.endAt = null;
  state.phase = 'focus';
  state.cyclesCompleted = 0;
  resetRemaining();
  persist();
  render();
}

function setDuration(key, value, minimum, maximum) {
  if (state.running) return;
  state[key] = clamp(Number(value), minimum, maximum);
  resetRemaining();
  persist();
  render();
}

function setLanguage(next) {
  language = next === 'zh' ? 'zh' : 'en';
  state.language = language;
  document.documentElement.lang = language === 'zh' ? 'zh-Hans' : 'en';
  elements.chipReset.title = t('reset');
  elements.chipReset.setAttribute('aria-label', t('reset'));
  elements.chipStop.title = t('stop');
  elements.chipStop.setAttribute('aria-label', t('stop'));
  elements.chipMeep.title = t('meep');
  elements.chipMeep.setAttribute('aria-label', t('meep'));
  elements.idleHint.textContent = t('hint');
  elements.birdCanvas.setAttribute('aria-label', t('canvasLabel'));
  desktop.setLanguage(language);
  lastTraySignature = '';
  persist();
  render();
}

function scheduleNextWalk(delay = state.walkIntervalMinutes * 60_000) {
  state.nextWalkAt = state.walkEnabled ? Date.now() + delay : null;
  persist();
}

function setWalkInterval(value) {
  state.walkIntervalMinutes = clamp(Number(value), 5, 60);
  if (state.walkEnabled) scheduleNextWalk();
  persist();
  render();
}

function setWalkEnabled(enabled) {
  state.walkEnabled = Boolean(enabled);
  if (state.walkEnabled) scheduleNextWalk();
  else state.nextWalkAt = null;
  persist();
  render();
}

async function requestWalk(manual = false) {
  if (walking || walkRequestPending || dragging || airborne || (!manual && !state.walkEnabled)) return false;
  walkRequestPending = true;
  try {
    const started = await desktop.startWalk();
    if (started && state.walkEnabled) scheduleNextWalk();
    if (!started && state.walkEnabled) scheduleNextWalk(60_000);
    return Boolean(started);
  } finally {
    walkRequestPending = false;
    render();
  }
}

function walkScheduleTick() {
  if (!state.walkEnabled || walking || walkRequestPending) return;
  if (!(Number(state.nextWalkAt) > 0) || Date.now() < state.nextWalkAt) return;
  // Wandering is for idle time only.  While a cycle is underway the bird stays
  // put: during focus and while paused it only fidgets, and the break already
  // has its own scheduled outing.
  const cycleActive = state.running || state.remainingSeconds < totalSecondsForCurrentPhase();
  if (cycleActive) {
    state.nextWalkAt = Date.now() + 90_000;
    persist();
    return;
  }
  requestWalk(false);
}

function announceAlarm() {
  elements.alarmCaption.classList.remove('show');
  elements.body.classList.remove('alarming');
  void elements.alarmCaption.offsetWidth;
  elements.alarmCaption.classList.add('show');
  elements.body.classList.add('alarming');
  setTimeout(() => {
    elements.alarmCaption.classList.remove('show');
    elements.body.classList.remove('alarming');
  }, 1650);
}

let birdScene = null;
let alarmTimers = [];

const MEEP_ROUND_MS = 1_720;

/** One or more rounds of the meep-meep call (3 rounds ≈ 5 s at the end of a focus block). */
function triggerAlarm(options = {}) {
  const repeats = clamp(Number(options.repeats) || 1, 1, 4);
  clearAlarmTimers();
  if (walking) {
    walking = false;
    elements.body.classList.remove('walking');
    desktop.cancelWalk();
  }
  desktop.notifyAlarm();
  const round = () => {
    announceAlarm();
    playMeepSound();
    birdScene?.playCall();
  };
  round();
  for (let index = 1; index < repeats; index += 1) {
    alarmTimers.push(setTimeout(round, index * MEEP_ROUND_MS));
  }
  return repeats * MEEP_ROUND_MS;
}

/** The break is spent outside: one round trip paced to fill the remaining rest time. */
function startBreakWalk() {
  if (state.phase !== 'rest' || !state.running) return;
  if (dragging || airborne || walking) return;
  const remaining = (state.endAt || Date.now()) - Date.now();
  if (remaining < 25_000) return;
  desktop.startWalk({ durationMs: remaining - 1_500 });
}

function completeTimer() {
  if (state.phase === 'focus') {
    // Focus done: meep for ~5 s, then spend the break walking out and back.
    state.phase = 'rest';
    state.remainingSeconds = state.restMinutes * 60;
    state.running = true;
    state.endAt = Date.now() + state.remainingSeconds * 1000;
    const meepFor = triggerAlarm({ repeats: 3 });
    alarmTimers.push(setTimeout(startBreakWalk, meepFor + 250));
  } else {
    // Break done: one short meep, back to work.
    state.phase = 'focus';
    state.cyclesCompleted += 1;
    state.remainingSeconds = state.focusMinutes * 60;
    state.running = true;
    state.endAt = Date.now() + state.remainingSeconds * 1000;
    triggerAlarm({ repeats: 1 });
  }
  persist();
  render();
}

function tick() {
  if (!state.running) return;
  const remaining = Math.max(0, Math.ceil((state.endAt - Date.now()) / 1000));
  if (remaining <= 0) {
    state.remainingSeconds = 0;
    completeTimer();
    return;
  }
  state.remainingSeconds = remaining;
  if (remaining !== lastRenderedSecond) {
    lastRenderedSecond = remaining;
    persist();
    render();
  }
}

/** Behaviour events from the puppet (the happy petting meep, pecks…). */
function handlePuppetEvent(event) {
  if (event?.type === 'pet-meep') {
    announceAlarm();
    playMeepSound();
  }
}

/** The chip's little bird-head button: one meep on demand, no window jumping. */
function playMeep() {
  announceAlarm();
  playMeepSound();
  birdScene?.playCall();
}

function render() {
  const total = Math.max(1, totalSecondsForCurrentPhase());
  const displayTime = formatTime(state.remainingSeconds);
  const label = currentLabel();
  const isResting = state.phase === 'rest';
  const pausedMidPhase = !state.running && state.remainingSeconds < total;
  const statusLabel = state.running ? label : pausedMidPhase ? t('paused') : t('ready');

  elements.body.classList.toggle('resting', isResting);
  elements.body.classList.toggle('walking', walking);

  // The chip is the bird's HUD: it fades in on hover, stays when pinned by a
  // single click, and always knows the current countdown (or Ready state).
  const cycleActive = state.running || pausedMidPhase;
  elements.body.classList.toggle('timing', cycleActive);
  elements.body.classList.toggle('chip-pinned', state.chipPinned);
  elements.body.classList.toggle('paused-chip', cycleActive && !state.running);
  elements.chipPause.textContent = state.running ? '⏸' : '▶';
  elements.chipPause.title = state.running ? t('pause') : t('start');
  elements.chipPause.setAttribute('aria-label', state.running ? t('pause') : t('start'));
  elements.chipReset.disabled = !cycleActive;
  elements.chipStop.disabled = !cycleActive;
  elements.chipTime.textContent = displayTime;
  elements.chipLabel.textContent = state.running ? label : pausedMidPhase ? t('paused') : t('ready');

  // Appearance: the bird's on-screen opacity (hover always restores it).
  document.body.style.setProperty('--bird-opacity', String(state.birdOpacity));

  // Everything the tray menu needs to draw itself.
  const trayState = {
    running: state.running,
    paused: pausedMidPhase,
    time: displayTime,
    label: statusLabel,
    focusMinutes: state.focusMinutes,
    restMinutes: state.restMinutes,
    walkEnabled: state.walkEnabled,
    walkIntervalMinutes: state.walkIntervalMinutes,
    muted: state.muted,
    birdScale: state.birdScale,
    birdOpacity: state.birdOpacity
  };
  const signature = JSON.stringify(trayState);
  if (signature !== lastTraySignature) {
    lastTraySignature = signature;
    desktop.updateTimerState(trayState);
  }
}

/**
 * Canvas host for the photo puppet: sizing, pointer interaction (hover, click,
 * drag-to-carry) and the render loop.
 */
class BirdScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d', { alpha: true, desynchronized: true });
    this.width = 1;
    this.height = 1;
    this.pixelRatio = 1;
    this.puppet = new WoodcockPuppet({
      assetRoot: '../../assets/character/puppet-v4',
      manifest: puppetManifest,
      onEvent: handlePuppetEvent
    });
    this.pointerDown = null;
    this.dragActive = false;
    this.lastPointer = null;
    this.pointerVelocity = { x: 0, y: 0 };
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.bindPointerEvents();
    this.resize();
    requestAnimationFrame((time) => this.animate(time));
  }

  get walkActive() {
    return walking;
  }

  playCall() {
    this.puppet.playCall();
  }

  setWalkState(walkState) {
    if (!walkState?.active) {
      this.puppet.setWalkState({ active: false });
      return;
    }
    const layout = this.layout();
    const scale = layout.width / 1600;
    this.puppet.setWalkState({
      active: true,
      direction: walkState.direction,
      motion: walkState.motion,
      speed: (Number(walkState.speed) || 0) / scale
    });
  }

  setDragState(dragState) {
    const phase = dragState?.phase;
    if (phase === 'held') {
      dragging = true;
      airborne = false;
      elements.body.classList.add('held');
      this.puppet.setHeld(true);
    } else if (phase === 'falling') {
      dragging = false;
      airborne = true;
      elements.body.classList.remove('held');
      this.puppet.setFalling(Number(dragState.height) || 0);
    } else if (phase === 'bounce') {
      this.puppet.setLanded(Number(dragState.impact) || 0);
      setTimeout(() => { if (airborne) this.puppet.setFalling(); }, 140);
    } else if (phase === 'landed') {
      dragging = false;
      airborne = false;
      elements.body.classList.remove('held');
      this.puppet.setLanded(Number(dragState.impact) || 800);
    }
    render();
  }

  bindPointerEvents() {
    const canvas = this.canvas;
    canvas.addEventListener('pointermove', (event) => {
      const rect = canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const nx = (px / Math.max(1, rect.width) - 0.5) * 2;
      const ny = (py / Math.max(1, rect.height) - 0.55) * 2;
      const layout = this.layout();
      const scale = layout.width / 1600;
      const mirror = this.puppet.currentFacing >= 0 ? 1 : -1;
      this.puppet.setPointer(nx, ny, true, {
        x: 800 + (px - layout.centerX) / (scale * mirror),
        y: 846 + (py - layout.groundY) / scale
      });
      if (this.pointerDown && !this.dragActive) {
        const distance = Math.hypot(event.screenX - this.pointerDown.screenX, event.screenY - this.pointerDown.screenY);
        if (distance > 6) this.startDrag(event);
      }
      if (this.dragActive) {
        const now = performance.now();
        if (this.lastPointer) {
          const dt = Math.max(1, now - this.lastPointer.time) / 1000;
          this.pointerVelocity = {
            x: this.pointerVelocity.x * 0.5 + ((event.screenX - this.lastPointer.x) / dt) * 0.5,
            y: this.pointerVelocity.y * 0.5 + ((event.screenY - this.lastPointer.y) / dt) * 0.5
          };
          this.puppet.setDragVelocity(this.pointerVelocity);
        }
        this.lastPointer = { x: event.screenX, y: event.screenY, time: now };
        desktop.dragMove({ x: event.screenX, y: event.screenY });
      }
    });
    canvas.addEventListener('pointerleave', () => {
      this.puppet.setPointer(0, 0, false);
    });
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      this.pointerDown = { screenX: event.screenX, screenY: event.screenY, pointerId: event.pointerId };
      this.puppet.touch();
    });
    const release = async (event) => {
      if (!this.pointerDown) return;
      const wasDragging = this.dragActive;
      const start = this.pointerDown;
      this.pointerDown = null;
      if (wasDragging) {
        this.dragActive = false;
        try { canvas.releasePointerCapture(start.pointerId); } catch { /* not captured */ }
        await desktop.dragEnd({ x: this.pointerVelocity.x, y: this.pointerVelocity.y });
        this.lastPointer = null;
        return;
      }
      const distance = Math.hypot(event.screenX - start.screenX, event.screenY - start.screenY);
      if (distance < 7 && event.type === 'pointerup') {
        // A quick second click toggles the timer; a lone click just gets the
        // bird's attention (settings live in the menu bar).
        if (this.pendingClick) {
          clearTimeout(this.pendingClick);
          this.pendingClick = null;
          this.onDoubleClick();
        } else {
          this.pendingClick = setTimeout(() => {
            this.pendingClick = null;
            this.onSingleClick();
          }, 260);
        }
      }
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.onSingleClick();
      } else if (event.key === ' ') {
        event.preventDefault();
        this.onDoubleClick();
      }
    });
  }

  onSingleClick() {
    if (walking) {
      desktop.cancelWalk();
      return;
    }
    if (airborne) return;
    // Single click pins the timer chip (click again to hide it), and the bird
    // acknowledges you with a little head cock.
    state.chipPinned = !state.chipPinned;
    persist();
    render();
    this.puppet.touch();
    if (this.puppet.mode === 'idle' && !this.puppet.action && !this.puppet.peckAction) {
      this.puppet.action = {
        name: 'tilt',
        startedAt: performance.now(),
        duration: 1400,
        data: { side: Math.random() < 0.5 ? -1 : 1 }
      };
    }
  }

  onDoubleClick() {
    if (airborne) return;
    if (walking) desktop.cancelWalk();
    if (state.running) {
      pauseTimer();
      return;
    }
    resumeTimer();
    // A small acknowledging stretch from the bird.
    if (this.puppet.mode === 'idle') {
      this.puppet.cancelAction();
      this.puppet.action = { name: 'wakeup', startedAt: performance.now(), duration: 900 };
    }
  }

  async startDrag(event) {
    if (this.dragActive || airborne) return;
    if (this.pendingClick) {
      clearTimeout(this.pendingClick);
      this.pendingClick = null;
    }
    this.dragActive = true;
    this.pointerVelocity = { x: 0, y: 0 };
    this.lastPointer = { x: event.screenX, y: event.screenY, time: performance.now() };
    try { this.canvas.setPointerCapture(this.pointerDown.pointerId); } catch { /* ignore */ }
    const started = await desktop.dragStart({ x: event.screenX, y: event.screenY });
    if (!started) this.dragActive = false;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, Math.round(rect.width));
    this.height = Math.max(1, Math.round(rect.height));
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * this.pixelRatio);
    this.canvas.height = Math.round(this.height * this.pixelRatio);
    this.context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    this.context.imageSmoothingEnabled = true;
    this.context.imageSmoothingQuality = 'high';
  }

  layout() {
    const width = Math.min(170 * (state.birdScale || 1), this.width * 0.78);
    return {
      width,
      centerX: this.width * 0.51,
      groundY: this.height - 14,
      pixelRatio: this.pixelRatio
    };
  }

  animate(time) {
    this.puppet.update(time);
    this.context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    this.context.clearRect(0, 0, this.width, this.height);
    this.puppet.draw(this.context, this.layout());
    const shadow = this.puppet.p.shadow;
    elements.groundShadow.style.opacity = String(shadow * (walking ? 0.45 : 1) * state.birdOpacity);
    requestAnimationFrame((nextTime) => this.animate(nextTime));
  }
}

elements.chipPause.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleTimer();
});
elements.chipReset.addEventListener('click', (event) => {
  event.stopPropagation();
  restartCycle();
});
elements.chipStop.addEventListener('click', (event) => {
  event.stopPropagation();
  stopTimer();
});
elements.chipMeep.addEventListener('click', (event) => {
  event.stopPropagation();
  playMeep();
});

/** Everything the tray menu can ask for.  Also driven directly by the tests. */
function handleTrayAction(action) {
  const type = typeof action === 'string' ? action : action && action.type;
  const value = action && typeof action === 'object' ? action.value : undefined;
  switch (type) {
    case 'toggle': toggleTimer(); break;
    case 'restart': restartCycle(); break;
    case 'stop':
    case 'reset': stopTimer(); break;
    case 'set-focus': setDuration('focusMinutes', value, 1, 180); break;
    case 'set-rest': setDuration('restMinutes', value, 1, 60); break;
    case 'set-walk-enabled': setWalkEnabled(value); break;
    case 'set-walk-interval': setWalkInterval(value); break;
    case 'walk-now': requestWalk(true); break;
    case 'set-muted':
      state.muted = Boolean(value);
      persist();
      render();
      break;
    case 'set-bird-scale':
      state.birdScale = clamp(Number(value) || 1, 0.7, 1.6);
      persist();
      render();
      break;
    case 'set-bird-opacity':
      state.birdOpacity = clamp(Number(value) || 1, 0.35, 1);
      persist();
      render();
      break;
    case 'set-language': setLanguage(value); break;
    case 'test-alarm': triggerAlarm({ repeats: 1 }); break;
    default: break;
  }
}

desktop.onTrayAction(handleTrayAction);

desktop.onWalkState((nextWalkState) => {
  walking = Boolean(nextWalkState?.active);
  birdScene?.setWalkState(nextWalkState);
  elements.body.classList.toggle('walking', walking);
  render();
});

desktop.onDragState((dragState) => {
  birdScene?.setDragState(dragState);
});

birdScene = new BirdScene(elements.birdCanvas);
window.__meepPuppetReady = () => Boolean(birdScene?.puppet?.ready);
window.__meepTriggerAlarm = () => triggerAlarm({ repeats: 1 });
window.__meepTrayAction = handleTrayAction;
window.__meepForceWalkCheck = () => {
  // Test hook: make the scheduled walk due right now and run one tick.
  state.nextWalkAt = Date.now() - 1;
  walkScheduleTick();
};
setLanguage(state.language);
render();
tick();
setInterval(tick, 250);
setInterval(walkScheduleTick, 2_000);

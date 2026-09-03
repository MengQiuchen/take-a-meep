const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const userDataFolder = process.env.MEEP_SMOKE_TEST
  ? 'Meep Bird Smoke Test'
  : process.defaultApp
    ? 'Meep Bird Desktop Dev'
    : 'Meep Bird Desktop';
app.setPath('userData', path.join(app.getPath('appData'), userDataFolder));

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const fastWalkTest = Boolean(process.env.MEEP_SMOKE_TEST);

// The bird window is always the small stage: the bird, its floating timer
// chip, nothing else.  All settings live in the menu-bar tray.  The whole
// stage scales with the "bird size" setting.
const WINDOW_BASE = { width: 220, height: 172 };
let birdScale = 1;

function windowSize() {
  return {
    width: Math.round(WINDOW_BASE.width * birdScale),
    height: Math.round(WINDOW_BASE.height * birdScale)
  };
}

// A real woodcock walks slowly and stops to rock every few steps.  Speeds are
// window pixels per second; the renderer keeps the feet planted at this speed.
const WALK_SETTINGS = {
  sideMargin: 18,
  bottomMargin: 16,
  speed: fastWalkTest ? 4_000 : 48,
  stepLength: fastWalkTest ? 400 : 25,        // px per step at `speed` (0.52 s per step)
  minimumDistance: 260,
  maximumDistance: 1100,
  screenFraction: 0.45,
  turnPause: fastWalkTest ? 60 : 520,
  rockPause: fastWalkTest ? [60, 80] : [1_400, 3_200],
  stepsPerBout: fastWalkTest ? [1, 1] : [3, 7],
  settlePause: fastWalkTest ? 40 : 700
};

// Budgeting for the timed break walk: the whole break is one out-and-back
// trip that ends at the start point right on time.  A long break means more
// rocking on the way (each pause can stretch) and a farther turn-around
// point; a short break compresses the rocking first and, when that is still
// not enough, shortens the distance.
const TIMED_WALK = {
  rockMinMs: fastWalkTest ? 50 : 1_200,     // a rocking pause can shrink to this…
  rockMaxMs: fastWalkTest ? 120 : 6_500,    // …or stretch to this before foraging absorbs the rest
  forageMinMs: fastWalkTest ? 60 : 2_500,   // always at least a beat at the far end
  minimumDistance: 120,
  screenFraction: 0.55                      // breaks may roam farther than idle walks
};

const FALL_SETTINGS = {
  gravity: 3_400,        // px/s^2
  bounce: 0.28,
  minimumBounceSpeed: 420,
  wallBounce: 0.45,
  drag: 0.985,
  flutterHeight: 130,    // dropped from higher than this, the bird flutters...
  flutterMaxSpeed: 940   // ...capping its fall speed
};

let mainWindow = null;
let tray = null;
let isQuitting = false;
let activeWalk = null;
let walkInterval = null;
let drag = null;
let fall = null;
let fallInterval = null;
let language = 'en';
const TRAY_STRINGS = {
  en: {
    start: 'Start',
    pause: 'Pause',
    resume: 'Resume',
    restart: 'Restart the cycle',
    stop: 'Stop',
    focusLen: 'Focus length',
    breakLen: 'Break length',
    walks: 'Idle walks',
    wander: 'Wander when idle',
    walkNow: 'Take a walk now',
    stopWalk: 'Stop the walk',
    mute: 'Mute',
    birdSize: 'Bird size',
    sizeSmall: 'Small',
    sizeStandard: 'Standard',
    sizeLarge: 'Large',
    sizeHuge: 'Extra large',
    opacity: 'Opacity',
    languageMenu: 'Language',
    show: 'Show the bird',
    hide: 'Hide the bird',
    corner: 'Back to the corner',
    quit: 'Quit Take a Meep'
  },
  zh: {
    start: '开始',
    pause: '暂停',
    resume: '继续',
    restart: '重新开始',
    stop: '停止',
    focusLen: '专注时长',
    breakLen: '休息时长',
    walks: '空闲散步',
    wander: '空闲时随便走走',
    walkNow: '现在走一圈',
    stopWalk: '结束散步',
    mute: '静音',
    birdSize: '鸟的大小',
    sizeSmall: '小',
    sizeStandard: '标准',
    sizeLarge: '大',
    sizeHuge: '超大',
    opacity: '透明度',
    languageMenu: '语言 / Language',
    show: '显示小鸟',
    hide: '隐藏小鸟',
    corner: '回到右下角',
    quit: '退出 Take a Meep'
  }
};
const trayText = (key) => TRAY_STRINGS[language][key];
let timerState = {
  running: false,
  paused: false,
  time: '30:00',
  label: 'Ready',
  focusMinutes: 30,
  restMinutes: 5,
  walkEnabled: true,
  walkIntervalMinutes: 15,
  muted: false,
  birdScale: 1,
  birdOpacity: 1
};

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function randomBetween(minimum, maximum) {
  return minimum + Math.random() * (maximum - minimum);
}

function positionInBottomRight(window, size = windowSize()) {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const workArea = display.workArea;
  window.setBounds({
    x: workArea.x + workArea.width - size.width - 18,
    y: workArea.y + workArea.height - size.height - 16,
    width: size.width,
    height: size.height
  });
}

/** The "bird size" setting scales the whole window, anchored bottom-right. */
function applyBirdScale(nextScale) {
  const scale = clamp(Number(nextScale) || 1, 0.7, 1.6);
  if (Math.abs(scale - birdScale) < 0.001) return;
  birdScale = scale;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (activeWalk) stopWalk('resized');
  const size = windowSize();
  const current = mainWindow.getBounds();
  const display = screen.getDisplayMatching(current);
  const workArea = display.workArea;
  const x = clamp(current.x + current.width - size.width, workArea.x, workArea.x + workArea.width - size.width);
  const y = clamp(current.y + current.height - size.height, workArea.y, workArea.y + workArea.height - size.height);
  mainWindow.setBounds({ x, y, width: size.width, height: size.height }, true);
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const current = mainWindow.getBounds();
  const display = screen.getDisplayMatching(current);
  const workArea = display.workArea;
  const visibleWidth = Math.max(0, Math.min(workArea.x + workArea.width, current.x + current.width) - Math.max(workArea.x, current.x));
  const visibleHeight = Math.max(0, Math.min(workArea.y + workArea.height, current.y + current.height) - Math.max(workArea.y, current.y));
  if (visibleWidth < 80 || visibleHeight < 80) {
    positionInBottomRight(mainWindow, windowSize());
  }
  mainWindow.showInactive();
  mainWindow.moveTop();
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function sendWalkState(active, direction = 'left', reason = '', motion = 'walk', speed = 0) {
  sendToRenderer('walk-state', { active, direction, reason, motion, speed, startedAt: Date.now() });
}

function sendDragState(phase, extra = {}) {
  sendToRenderer('drag-state', { phase, ...extra });
}

// --------------------------------------------------------------------- walking

function buildWalkPlan(homeX, farX, direction, targetDurationMs = 0) {
  const { speed, stepLength, stepsPerBout, rockPause, turnPause, settlePause } = WALK_SETTINGS;
  const segments = [];
  const away = direction;
  const back = direction === 'left' ? 'right' : 'left';

  const addLeg = (fromX, toX, facing) => {
    const total = Math.abs(toX - fromX);
    const sign = Math.sign(toX - fromX);
    let travelled = 0;
    let x = fromX;
    while (travelled < total - 1) {
      const steps = Math.round(randomBetween(stepsPerBout[0], stepsPerBout[1]));
      const length = Math.min(total - travelled, steps * stepLength);
      const nextX = x + sign * length;
      segments.push({ motion: 'walk', direction: facing, speed, fromX: x, toX: nextX, duration: (length / speed) * 1_000 });
      x = nextX;
      travelled += length;
      if (travelled < total - 1) {
        segments.push({ motion: 'rock', direction: facing, speed: 0, fromX: x, toX: x, duration: randomBetween(rockPause[0], rockPause[1]) });
      }
    }
  };

  addLeg(homeX, farX, away);
  const halfway = segments.length;
  segments.push({ motion: 'turn', direction: back, speed: 0, fromX: farX, toX: farX, duration: turnPause });
  addLeg(farX, homeX, back);
  segments.push({ motion: 'settle', direction: back, speed: 0, fromX: homeX, toX: homeX, duration: settlePause });

  // A timed walk (the focus-cycle break) fills exactly targetDurationMs and
  // ends back at the start.  The spare time is spent, in order of preference:
  // longer rocking pauses along the way (a long break = a swaggerier walk),
  // then foraging at the far end; a short break compresses the rocking
  // instead, down to quick token sways.
  if (targetDurationMs > 0) {
    const rocks = segments.filter((segment) => segment.motion === 'rock');
    const sum = () => segments.reduce((total, segment) => total + segment.duration, 0);

    let spare = targetDurationMs - sum() - TIMED_WALK.forageMinMs;
    if (spare < 0 && rocks.length) {
      // Short on time: shrink every rock towards its minimum, proportionally.
      const reducible = rocks.reduce((total, rock) => total + Math.max(0, rock.duration - TIMED_WALK.rockMinMs), 0);
      const cut = Math.min(-spare, reducible);
      if (reducible > 0) {
        for (const rock of rocks) {
          rock.duration -= cut * Math.max(0, rock.duration - TIMED_WALK.rockMinMs) / reducible;
        }
      }
      spare = targetDurationMs - sum() - TIMED_WALK.forageMinMs;
    }
    if (spare > 0 && rocks.length) {
      // Time to spare: let every rocking pause swell towards its maximum.
      const growable = rocks.reduce((total, rock) => total + Math.max(0, TIMED_WALK.rockMaxMs - rock.duration), 0);
      const give = Math.min(spare, growable);
      if (growable > 0) {
        for (const rock of rocks) {
          rock.duration += give * Math.max(0, TIMED_WALK.rockMaxMs - rock.duration) / growable;
        }
      }
    }
    // Whatever is left over becomes foraging at the far end, and the forage
    // segment absorbs any rounding so the total is exact to the millisecond.
    const others = sum();
    segments.splice(halfway, 0, {
      motion: 'forage',
      direction: away,
      speed: 0,
      fromX: farX,
      toX: farX,
      duration: Math.max(TIMED_WALK.forageMinMs * 0.4, targetDurationMs - others)
    });
  }
  return segments;
}

function stopWalk(reason = 'cancelled') {
  if (!activeWalk) return false;
  const walk = activeWalk;
  activeWalk = null;
  if (walkInterval) {
    clearInterval(walkInterval);
    walkInterval = null;
  }
  if (mainWindow && !mainWindow.isDestroyed() && reason !== 'hidden') {
    // A cancelled walk snaps home; a completed one is already there.
    mainWindow.setBounds({ x: walk.homeX, y: walk.y, width: walk.width, height: walk.height });
  }
  sendWalkState(false, walk.direction, reason);
  rebuildTrayMenu();
  return true;
}

function updateWalkPosition() {
  if (!activeWalk || !mainWindow || mainWindow.isDestroyed()) return;
  const now = Date.now();
  const walk = activeWalk;
  const segment = walk.segments[walk.index];
  const progress = clamp((now - walk.segmentStartedAt) / Math.max(1, segment.duration), 0, 1);
  const x = Math.round(segment.fromX + (segment.toX - segment.fromX) * progress);
  if (segment.motion === 'walk') mainWindow.setPosition(x, walk.y, false);
  if (progress >= 1) {
    walk.index += 1;
    if (walk.index >= walk.segments.length) {
      mainWindow.setPosition(walk.homeX, walk.y, false);
      stopWalk('complete');
      return;
    }
    const next = walk.segments[walk.index];
    walk.direction = next.direction;
    walk.segmentStartedAt = now;
    sendWalkState(true, next.direction, next.motion, next.motion, next.speed);
  }
}

function startWalk(options = {}) {
  const targetDurationMs = Math.max(0, Number(options.durationMs) || 0);
  if (!mainWindow || mainWindow.isDestroyed() || activeWalk || drag || fall) return false;
  const bounds = mainWindow.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const workArea = display.workArea;
  const width = windowSize().width;
  const height = windowSize().height;
  const y = workArea.y + workArea.height - height - WALK_SETTINGS.bottomMargin;
  const homeX = clamp(bounds.x, workArea.x + WALK_SETTINGS.sideMargin, workArea.x + workArea.width - width - WALK_SETTINGS.sideMargin);
  const roomLeft = homeX - (workArea.x + WALK_SETTINGS.sideMargin);
  const roomRight = workArea.x + workArea.width - width - WALK_SETTINGS.sideMargin - homeX;
  const preferred = clamp(
    Math.round(workArea.width * (targetDurationMs > 0 ? TIMED_WALK.screenFraction : WALK_SETTINGS.screenFraction)),
    WALK_SETTINGS.minimumDistance,
    WALK_SETTINGS.maximumDistance
  );
  let direction;
  if (roomLeft >= preferred && roomRight >= preferred) direction = Math.random() < 0.5 ? 'left' : 'right';
  else direction = roomLeft >= roomRight ? 'left' : 'right';
  const room = direction === 'left' ? roomLeft : roomRight;
  let distance = Math.min(room, preferred);
  if (targetDurationMs > 0) {
    // Pick the farthest turn-around point whose leanest possible plan (pure
    // walking plus minimum rocking) still fits the break, leaving a little
    // slack for the sways; when the break is short this walks it in closer.
    const budgetMs = targetDurationMs - WALK_SETTINGS.turnPause - WALK_SETTINGS.settlePause - TIMED_WALK.forageMinMs;
    const averageBout = ((WALK_SETTINGS.stepsPerBout[0] + WALK_SETTINGS.stepsPerBout[1]) / 2) * WALK_SETTINGS.stepLength;
    const leanPlanMs = (d) => {
      const rocksPerLeg = Math.max(0, Math.ceil(d / averageBout) - 1);
      return (2 * d / WALK_SETTINGS.speed) * 1_000 + 2 * rocksPerLeg * TIMED_WALK.rockMinMs;
    };
    while (distance > TIMED_WALK.minimumDistance && leanPlanMs(distance) > budgetMs * 0.92) {
      distance = Math.round(distance * 0.85);
    }
    distance = Math.max(TIMED_WALK.minimumDistance, Math.min(distance, room));
  }
  if (distance < (targetDurationMs > 0 ? 100 : 140)) return false;
  const farX = direction === 'left' ? homeX - distance : homeX + distance;

  mainWindow.setBounds({ x: homeX, y, width, height });
  showWindow();
  const segments = buildWalkPlan(homeX, farX, direction, targetDurationMs);
  activeWalk = {
    homeX,
    y,
    width,
    height,
    direction,
    segments,
    index: 0,
    segmentStartedAt: Date.now()
  };
  sendWalkState(true, direction, 'started', segments[0].motion, segments[0].speed);
  walkInterval = setInterval(updateWalkPosition, 16);
  rebuildTrayMenu();
  return true;
}

// --------------------------------------------------------------------- dragging

function beginDrag(point) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (activeWalk) stopWalk('dragged');
  if (fall) endFall(false);
  const bounds = mainWindow.getBounds();
  drag = {
    offsetX: point.x - bounds.x,
    offsetY: point.y - bounds.y,
    lastX: point.x,
    lastY: point.y,
    lastAt: Date.now(),
    velocityX: 0,
    velocityY: 0
  };
  sendDragState('held');
  rebuildTrayMenu();
  return true;
}

function moveDrag(point) {
  if (!drag || !mainWindow || mainWindow.isDestroyed()) return;
  const now = Date.now();
  const dt = Math.max(1, now - drag.lastAt) / 1000;
  const vx = (point.x - drag.lastX) / dt;
  const vy = (point.y - drag.lastY) / dt;
  drag.velocityX = drag.velocityX * 0.6 + vx * 0.4;
  drag.velocityY = drag.velocityY * 0.6 + vy * 0.4;
  drag.lastX = point.x;
  drag.lastY = point.y;
  drag.lastAt = now;
  const bounds = mainWindow.getBounds();
  const display = screen.getDisplayNearestPoint({ x: point.x, y: point.y });
  const workArea = display.workArea;
  const x = clamp(Math.round(point.x - drag.offsetX), workArea.x - bounds.width * 0.35, workArea.x + workArea.width - bounds.width * 0.65);
  const y = clamp(Math.round(point.y - drag.offsetY), workArea.y - 20, workArea.y + workArea.height - bounds.height);
  mainWindow.setPosition(x, y, false);
}

function endDrag() {
  if (!drag) return false;
  const stale = Date.now() - drag.lastAt > 120;
  const velocity = {
    x: stale ? 0 : clamp(drag.velocityX, -2_400, 2_400),
    y: stale ? 0 : clamp(drag.velocityY, -2_400, 2_400)
  };
  drag = null;
  startFall(velocity);
  return true;
}

function startFall(velocity) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const workArea = display.workArea;
  const floorY = workArea.y + workArea.height - bounds.height - WALK_SETTINGS.bottomMargin;
  const height = Math.max(0, floorY - bounds.y);
  fall = {
    x: bounds.x,
    y: bounds.y,
    vx: velocity.x * 0.55,
    vy: velocity.y * 0.35,
    floorY,
    minX: workArea.x + 4,
    maxX: workArea.x + workArea.width - bounds.width - 4,
    lastAt: Date.now(),
    bounced: false,
    flutter: height > FALL_SETTINGS.flutterHeight
  };
  if (fall.y >= floorY - 2 && Math.abs(fall.vx) < 60) {
    fall.y = floorY;
    endFall(true, Math.abs(velocity.y));
    return;
  }
  sendDragState('falling', { height });
  fallInterval = setInterval(updateFall, 16);
  rebuildTrayMenu();
}

function updateFall() {
  if (!fall || !mainWindow || mainWindow.isDestroyed()) return;
  const now = Date.now();
  const dt = clamp((now - fall.lastAt) / 1000, 0.001, 0.05);
  fall.lastAt = now;
  fall.vy += FALL_SETTINGS.gravity * dt;
  if (fall.flutter) fall.vy = Math.min(fall.vy, FALL_SETTINGS.flutterMaxSpeed);
  fall.vx *= FALL_SETTINGS.drag;
  fall.x += fall.vx * dt;
  fall.y += fall.vy * dt;
  if (fall.x < fall.minX) {
    fall.x = fall.minX;
    fall.vx = Math.abs(fall.vx) * FALL_SETTINGS.wallBounce;
  } else if (fall.x > fall.maxX) {
    fall.x = fall.maxX;
    fall.vx = -Math.abs(fall.vx) * FALL_SETTINGS.wallBounce;
  }
  if (fall.y >= fall.floorY) {
    fall.y = fall.floorY;
    if (!fall.bounced && fall.vy > FALL_SETTINGS.minimumBounceSpeed) {
      fall.bounced = true;
      const impact = fall.vy;
      fall.vy = -fall.vy * FALL_SETTINGS.bounce;
      fall.vx *= 0.6;
      sendDragState('bounce', { impact });
    } else {
      mainWindow.setPosition(Math.round(fall.x), Math.round(fall.y), false);
      endFall(true, fall.vy);
      return;
    }
  }
  mainWindow.setPosition(Math.round(fall.x), Math.round(fall.y), false);
}

function endFall(landed, impact = 0) {
  if (fallInterval) {
    clearInterval(fallInterval);
    fallInterval = null;
  }
  fall = null;
  if (landed) sendDragState('landed', { impact });
  rebuildTrayMenu();
}

// ------------------------------------------------------------------------ tray

// The whole settings surface lives in this menu: click the menu-bar bird and
// you get the countdown status, the timer controls and every setting at once.
function rebuildTrayMenu() {
  if (!tray) return;
  const s = timerState;
  const cycleActive = s.running || s.paused;
  const statusKey = s.running ? 'pause' : s.paused ? 'resume' : 'start';
  const minuteLabel = (n) => (language === 'zh' ? `${n} 分钟` : `${n} minutes`);
  const everyLabel = (n) => (language === 'zh' ? `每 ${n} 分钟` : `Every ${n} minutes`);
  const send = (type, value) => () => sendToRenderer('tray-action', { type, value });
  const menu = Menu.buildFromTemplate([
    {
      label: `${s.label} · ${s.time}`,
      enabled: false
    },
    {
      label: trayText(statusKey),
      click: send('toggle')
    },
    {
      label: trayText('restart'),
      enabled: cycleActive,
      click: send('restart')
    },
    {
      label: trayText('stop'),
      enabled: cycleActive,
      click: send('stop')
    },
    { type: 'separator' },
    {
      label: trayText('focusLen'),
      submenu: [15, 25, 30, 45, 60].map((n) => ({
        label: minuteLabel(n),
        type: 'radio',
        checked: s.focusMinutes === n,
        enabled: !s.running,
        click: send('set-focus', n)
      }))
    },
    {
      label: trayText('breakLen'),
      submenu: [5, 10, 15, 20].map((n) => ({
        label: minuteLabel(n),
        type: 'radio',
        checked: s.restMinutes === n,
        enabled: !s.running,
        click: send('set-rest', n)
      }))
    },
    {
      label: trayText('walks'),
      submenu: [
        {
          label: trayText('wander'),
          type: 'checkbox',
          checked: Boolean(s.walkEnabled),
          click: (item) => sendToRenderer('tray-action', { type: 'set-walk-enabled', value: item.checked })
        },
        { type: 'separator' },
        ...[5, 10, 15, 20, 30, 45, 60].map((n) => ({
          label: everyLabel(n),
          type: 'radio',
          checked: s.walkIntervalMinutes === n,
          enabled: Boolean(s.walkEnabled),
          click: send('set-walk-interval', n)
        })),
        { type: 'separator' },
        {
          label: activeWalk ? trayText('stopWalk') : trayText('walkNow'),
          enabled: !drag && !fall,
          click: () => {
            if (activeWalk) stopWalk('tray');
            else {
              showWindow();
              sendToRenderer('tray-action', { type: 'walk-now' });
            }
          }
        }
      ]
    },
    {
      label: trayText('mute'),
      type: 'checkbox',
      checked: Boolean(s.muted),
      click: (item) => sendToRenderer('tray-action', { type: 'set-muted', value: item.checked })
    },
    {
      label: trayText('birdSize'),
      submenu: [[0.85, 'sizeSmall'], [1, 'sizeStandard'], [1.2, 'sizeLarge'], [1.45, 'sizeHuge']].map(([value, key]) => ({
        label: trayText(key),
        type: 'radio',
        checked: Math.abs((s.birdScale || 1) - value) < 0.01,
        click: send('set-bird-scale', value)
      }))
    },
    {
      label: trayText('opacity'),
      submenu: [1, 0.85, 0.7, 0.55].map((value) => ({
        label: `${Math.round(value * 100)}%`,
        type: 'radio',
        checked: Math.abs((s.birdOpacity || 1) - value) < 0.01,
        click: send('set-bird-opacity', value)
      }))
    },
    {
      label: trayText('languageMenu'),
      submenu: [
        {
          label: 'English',
          type: 'radio',
          checked: language !== 'zh',
          click: send('set-language', 'en')
        },
        {
          label: '中文',
          type: 'radio',
          checked: language === 'zh',
          click: send('set-language', 'zh')
        }
      ]
    },
    { type: 'separator' },
    {
      label: mainWindow && mainWindow.isVisible() ? trayText('hide') : trayText('show'),
      click: () => {
        if (mainWindow && mainWindow.isVisible()) {
          if (activeWalk) stopWalk('hidden');
          mainWindow.hide();
        }
        else showWindow();
        rebuildTrayMenu();
      }
    },
    {
      label: trayText('corner'),
      click: () => {
        if (activeWalk) stopWalk('tray');
        if (fall) endFall(false);
        drag = null;
        positionInBottomRight(mainWindow, windowSize());
        showWindow();
      }
    },
    { type: 'separator' },
    {
      label: trayText('quit'),
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`${s.label} · ${s.time}`);
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'character', 'idle-v2.png');
  let icon = nativeImage.createFromPath(iconPath).resize({ height: 19 });
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.on('click', () => {
    if (mainWindow && mainWindow.isVisible()) {
      if (activeWalk) stopWalk('hidden');
      mainWindow.hide();
    }
    else showWindow();
    rebuildTrayMenu();
  });
  rebuildTrayMenu();
}

function createWindow() {
  const initial = windowSize();
  mainWindow = new BrowserWindow({
    width: initial.width,
    height: initial.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: false,
    title: 'Take a Meep',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  positionInBottomRight(mainWindow, initial);
  const loadRenderer = () => mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.env.MEEP_SMOKE_TEST) {
    // Every smoke run starts from factory settings.
    mainWindow.webContents.session.clearStorageData({ storages: ['localstorage'] }).then(loadRenderer, loadRenderer);
  } else {
    loadRenderer();
  }

  mainWindow.webContents.on('did-fail-load', (_event, code, description, validatedURL) => {
    console.error('Renderer failed to load', { code, description, validatedURL });
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process exited', details);
  });
  mainWindow.webContents.on('console-message', (_event, details) => {
    if (details && typeof details === 'object') console.log(`Renderer: ${details.message}`);
  });

  mainWindow.once('ready-to-show', () => {
    showWindow();
    rebuildTrayMenu();
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      if (activeWalk) stopWalk('hidden');
      mainWindow.hide();
      rebuildTrayMenu();
    }
  });

  mainWindow.on('show', rebuildTrayMenu);
  mainWindow.on('hide', rebuildTrayMenu);

  const capturePath = process.env.MEEP_CAPTURE_PATH;
  if (capturePath) {
    if (process.env.MEEP_CAPTURE_ALARM) {
      setTimeout(() => sendToRenderer('tray-action', 'test-alarm'), 3960);
    }
    if (process.env.MEEP_CAPTURE_WALK) {
      setTimeout(() => sendToRenderer('tray-action', 'walk-now'), 2_600);
    }
    setTimeout(async () => {
      try {
        const capture = await mainWindow.webContents.capturePage();
        const absolutePath = path.isAbsolute(capturePath) ? capturePath : path.resolve(app.getAppPath(), capturePath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, capture.toPNG());
        console.log(`Captured preview to ${absolutePath}`);
      } catch (error) {
        console.error('Could not capture preview', error);
      } finally {
        isQuitting = true;
        app.quit();
      }
    }, 4200);
  }

  if (process.env.MEEP_SMOKE_TEST) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const result = await mainWindow.webContents.executeJavaScript(`
            (async () => { try {
              const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
              const canvasNode = document.querySelector('#birdCanvas');
              const canvasClick = () => {
                for (const type of ['pointerdown', 'pointerup']) {
                  canvasNode.dispatchEvent(new PointerEvent(type, {
                    bubbles: true, button: 0, pointerId: 7, screenX: 400, screenY: 700, clientX: 110, clientY: 80
                  }));
                }
              };
              const doubleClick = async () => { canvasClick(); await wait(60); canvasClick(); await wait(150); };
              const chip = document.querySelector('#timerChip');
              const chipTime = () => document.querySelector('#chipTime').textContent;

              // No settings panel exists anywhere in the window any more.
              const noPanel = !document.querySelector('.timer-panel')
                && !document.querySelector('#focusSelect')
                && !document.querySelector('#langToggle');
              // The chip starts invisible (it appears on hover or when pinned).
              const chipHiddenAtLaunch = getComputedStyle(chip).opacity === '0'
                && !document.body.classList.contains('chip-pinned');

              // A single click pins the chip; it shows the Ready state.
              canvasClick();
              await wait(520);
              const singleClickPinsChip = document.body.classList.contains('chip-pinned')
                && getComputedStyle(chip).opacity === '1'
                && document.querySelector('#chipLabel').textContent === 'Ready';

              // The little bird-head button on the chip meeps on demand.
              document.querySelector('#chipMeep').click();
              await wait(200);
              const meepButtonMeeps = document.body.classList.contains('alarming');
              await wait(1900);

              // Durations come from the tray menu now: set 25/10 while idle.
              window.__meepTrayAction({ type: 'set-focus', value: 25 });
              window.__meepTrayAction({ type: 'set-rest', value: 10 });
              await wait(80);

              // Double-click starts the cycle with the tray-set focus length.
              await doubleClick();
              const doubleClickStarted = document.body.classList.contains('timing')
                && document.querySelector('#chipPause').textContent === '⏸';
              await wait(1150);
              const chipCounting = chipTime() === '24:59';

              // The chip is a slim pill (buttons in a row) floating centred
              // above the bird, not overlapping it.
              const chipRect = chip.getBoundingClientRect();
              const stageBox = canvasNode.getBoundingClientRect();
              const chipRowLayout = getComputedStyle(document.querySelector('.chip-controls')).flexDirection === 'row'
                && chipRect.height <= 34;
              const chipAboveBird = chipRect.bottom <= stageBox.top + 56
                && Math.abs((chipRect.left + chipRect.right) / 2 - window.innerWidth / 2) <= 40
                && chipRect.width <= window.innerWidth - 10;

              // During FOCUS a due scheduled walk must not send the bird out.
              window.__meepForceWalkCheck();
              await wait(450);
              const noWalkDuringFocus = !document.body.classList.contains('walking');

              // Double-click again pauses; the chip stays with a play button.
              await doubleClick();
              const doubleClickPaused = document.body.classList.contains('paused-chip')
                && document.querySelector('#chipPause').textContent === '▶';

              // While paused it must not walk either.
              window.__meepForceWalkCheck();
              await wait(450);
              const noWalkWhilePaused = !document.body.classList.contains('walking');

              // Chip buttons: resume, restart the cycle, stop.
              document.querySelector('#chipPause').click();
              await wait(120);
              const chipResumed = !document.body.classList.contains('paused-chip');
              document.querySelector('#chipReset').click();
              await wait(120);
              const chipRestarted = chipTime() === '25:00' && document.body.classList.contains('timing');
              document.querySelector('#chipStop').click();
              await wait(120);
              const chipStopped = !document.body.classList.contains('timing')
                && document.querySelector('#chipLabel').textContent === 'Ready';

              // The tray can drive the timer too.
              window.__meepTrayAction({ type: 'toggle' });
              await wait(120);
              const trayStarted = document.body.classList.contains('timing');
              window.__meepTrayAction({ type: 'stop' });
              await wait(120);
              const trayStopped = !document.body.classList.contains('timing');

              // Language switching now comes from the tray menu.
              window.__meepTrayAction({ type: 'set-language', value: 'zh' });
              await wait(60);
              const chinese = document.querySelector('#idleHint').textContent.indexOf('悬停') === 0;
              window.__meepTrayAction({ type: 'set-language', value: 'en' });
              await wait(60);
              const englishBack = document.querySelector('#idleHint').textContent.indexOf('Hover') === 0;

              // Appearance from the tray: bird size rescales the whole window…
              window.__meepTrayAction({ type: 'set-bird-scale', value: 1.2 });
              await wait(650);
              const birdScaled = window.innerWidth >= 250;
              window.__meepTrayAction({ type: 'set-bird-scale', value: 1 });
              await wait(650);
              const birdScaleBack = window.innerWidth <= 240;
              // …and opacity ghosts the canvas (hover would restore it).
              window.__meepTrayAction({ type: 'set-bird-opacity', value: 0.7 });
              await wait(300);
              const birdDimmed = getComputedStyle(canvasNode).opacity === '0.7';
              window.__meepTrayAction({ type: 'set-bird-opacity', value: 1 });
              await wait(120);

              // While idle, the wander schedule is allowed to fire...
              const walkStates = [];
              const removeWalkListener = window.meepDesktop.onWalkState((walkState) => walkStates.push(walkState));
              window.__meepForceWalkCheck();
              await wait(1750);
              const idleWalkStarted = walkStates.some((walkState) => walkState.active);
              const walkTurned = walkStates.some((walkState) => walkState.active && walkState.motion === 'turn');
              const walkCompleted = walkStates.some((walkState) => !walkState.active && walkState.reason === 'complete');

              // ...and the tray's "walk now" works even mid-focus, with the chip
              // ticking along; a single click on the bird calls it home.
              await doubleClick();
              window.__meepTrayAction({ type: 'walk-now' });
              await wait(1750);
              const timerDuringWalk = /^24:5[0-9]$/.test(chipTime());
              window.__meepTrayAction({ type: 'walk-now' });
              await wait(300);
              canvasClick();
              await wait(500);
              const walkStopped = !document.body.classList.contains('walking');
              removeWalkListener();

              const dragStates = [];
              const removeDragListener = window.meepDesktop.onDragState((dragState) => dragStates.push(dragState.phase));
              await window.meepDesktop.dragStart({ x: 300, y: 300 });
              window.meepDesktop.dragMove({ x: 320, y: 260 });
              await wait(60);
              await window.meepDesktop.dragEnd({});
              await wait(900);
              removeDragListener();
              const dragWorked = dragStates.includes('held') && dragStates.includes('landed');

              window.__meepTriggerAlarm();
              await wait(180);
              const alarmStarted = document.body.classList.contains('alarming');
              document.querySelector('#chipStop').click();

              // A second single click toggles the pin off again.
              const pinnedBefore = document.body.classList.contains('chip-pinned');
              canvasClick();
              await wait(520);
              const singleClickUnpins = document.body.classList.contains('chip-pinned') === !pinnedBefore;

              // Rub the bird back and forth for a few seconds: it should get so
              // happy it lets out its double meep (the alarming caption appears
              // without the alarm being triggered).
              await wait(2200);
              const stageRect = canvasNode.getBoundingClientRect();
              const rubY = stageRect.top + stageRect.height - 60;
              const rubX = stageRect.left + stageRect.width * 0.51;
              let petMeeped = false;
              let flip = 1;
              const rubStart = Date.now();
              while (Date.now() - rubStart < 7000 && !petMeeped) {
                flip = -flip;
                canvasNode.dispatchEvent(new PointerEvent('pointermove', {
                  bubbles: true, pointerId: 9,
                  clientX: rubX + flip * 22, clientY: rubY,
                  screenX: 500 + flip * 22, screenY: 900
                }));
                await wait(85);
                if (document.body.classList.contains('alarming')) petMeeped = true;
              }

              const puppetReady = Boolean(window.__meepPuppetReady && window.__meepPuppetReady());
              return {
                noPanel,
                chipHiddenAtLaunch,
                singleClickPinsChip,
                meepButtonMeeps,
                doubleClickStarted,
                chipCounting,
                chipRowLayout,
                chipAboveBird,
                noWalkDuringFocus,
                doubleClickPaused,
                noWalkWhilePaused,
                chipResumed,
                chipRestarted,
                chipStopped,
                trayStarted,
                trayStopped,
                chinese,
                englishBack,
                birdScaled,
                birdScaleBack,
                birdDimmed,
                idleWalkStarted,
                walkTurned,
                walkCompleted,
                timerDuringWalk,
                walkStopped,
                dragWorked,
                alarmStarted,
                singleClickUnpins,
                petMeeped,
                puppetReady
              };
            } catch (error) { return { failed: String((error && error.stack) || error) }; } })()
          `);
          if (result && result.failed) {
            console.error('Smoke test in-page failure:', result.failed);
            isQuitting = true;
            app.exit(1);
            return;
          }
          const passed = Object.values(result).every(Boolean);
          console.log(`Smoke test ${passed ? 'passed' : 'failed'}: ${JSON.stringify(result)}`);
          isQuitting = true;
          app.exit(passed ? 0 : 1);
        } catch (error) {
          console.error('Smoke test failed with an exception', error);
          isQuitting = true;
          app.exit(1);
        }
      }, 900);
    });
  }
}

ipcMain.handle('start-walk', (_event, options) => startWalk(options || {}));

ipcMain.handle('cancel-walk', () => stopWalk('renderer'));

ipcMain.handle('drag-start', (_event, point) => beginDrag({ x: Number(point?.x) || 0, y: Number(point?.y) || 0 }));

ipcMain.on('drag-move', (_event, point) => moveDrag({ x: Number(point?.x) || 0, y: Number(point?.y) || 0 }));

ipcMain.handle('drag-end', () => endDrag());

ipcMain.on('timer-state', (_event, nextState) => {
  const next = nextState && typeof nextState === 'object' ? nextState : {};
  timerState = {
    running: Boolean(next.running),
    paused: Boolean(next.paused),
    time: String(next.time || '00:00'),
    label: String(next.label || ''),
    focusMinutes: Number(next.focusMinutes) || timerState.focusMinutes,
    restMinutes: Number(next.restMinutes) || timerState.restMinutes,
    walkEnabled: next.walkEnabled !== undefined ? Boolean(next.walkEnabled) : timerState.walkEnabled,
    walkIntervalMinutes: Number(next.walkIntervalMinutes) || timerState.walkIntervalMinutes,
    muted: next.muted !== undefined ? Boolean(next.muted) : timerState.muted,
    birdScale: Number(next.birdScale) || timerState.birdScale,
    birdOpacity: Number(next.birdOpacity) || timerState.birdOpacity
  };
  applyBirdScale(timerState.birdScale);
  rebuildTrayMenu();
});

ipcMain.on('ui-language', (_event, lang) => {
  language = lang === 'zh' ? 'zh' : 'en';
  rebuildTrayMenu();
});

ipcMain.on('alarm', () => {
  if (activeWalk) stopWalk('alarm');
  showWindow();
  if (mainWindow) {
    mainWindow.setAlwaysOnTop(true, 'pop-up-menu');
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(true, 'floating');
    }, 1900);
  }
});

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock.hide();
  createWindow();
  createTray();
});

app.on('activate', showWindow);
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  isQuitting = true;
});

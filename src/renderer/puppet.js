// Photo-driven 2.5D woodcock puppet (v3).
//
// Every layer is a slice of one public-domain USFWS photograph (see
// tools/make_photo_puppet_v3.py).  This module knows how the slices fit
// together: pivots, a two-bone leg chain, the jaw, the neck, the tail fan, and a
// small library of behaviours (idle fidgets, the meep call, the woodcock walk and
// rock, being carried, falling and landing).
//
// All rig maths happens in "master" pixels (the 1600x893 photo, bird facing left).
// `draw()` maps master space onto the canvas and mirrors it when facing right.

const TAU = Math.PI * 2;

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(Math.max(value, minimum), maximum);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(edge0, edge1, value) {
  const t = clamp((value - edge0) / Math.max(1e-6, edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Bell-shaped pulse: 0 -> 1 -> 0 between start and end, with separate attack / release. */
function pulse(t, start, attack, hold, release) {
  const local = t - start;
  if (local <= 0) return 0;
  if (local < attack) return smoothstep(0, attack, local);
  if (local < attack + hold) return 1;
  return 1 - smoothstep(attack + hold, attack + hold + release, local);
}

function expSmooth(current, target, rate, dt) {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

// --- 2D affine helpers (canvas convention: x' = a*x + c*y + e, y' = b*x + d*y + f)
class Mat {
  constructor(a = 1, b = 0, c = 0, d = 1, e = 0, f = 0) {
    this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f;
  }

  static translation(x, y) { return new Mat(1, 0, 0, 1, x, y); }

  static rotation(angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return new Mat(cos, sin, -sin, cos, 0, 0);
  }

  static scaling(sx, sy) { return new Mat(sx, 0, 0, sy, 0, 0); }

  multiply(other) {
    // this * other (apply `other` first, then this)
    return new Mat(
      this.a * other.a + this.c * other.b,
      this.b * other.a + this.d * other.b,
      this.a * other.c + this.c * other.d,
      this.b * other.c + this.d * other.d,
      this.a * other.e + this.c * other.f + this.e,
      this.b * other.e + this.d * other.f + this.f
    );
  }

  apply(x, y) {
    return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f };
  }

  rotateAbout(px, py, angle) {
    return this.multiply(Mat.translation(px, py)).multiply(Mat.rotation(angle)).multiply(Mat.translation(-px, -py));
  }

  scaleAbout(px, py, sx, sy) {
    return this.multiply(Mat.translation(px, py)).multiply(Mat.scaling(sx, sy)).multiply(Mat.translation(-px, -py));
  }
}

/**
 * Map a rest segment (from -> to) onto a target segment, stretching along the
 * segment axis only.  Used for the tarsi so the same photo strip can be any
 * length between the knee and the foot.
 */
function segmentTransform(restFrom, restTo, targetFrom, targetTo) {
  const restDx = restTo.x - restFrom.x;
  const restDy = restTo.y - restFrom.y;
  const restLength = Math.hypot(restDx, restDy);
  const restAngle = Math.atan2(restDy, restDx);
  const targetDx = targetTo.x - targetFrom.x;
  const targetDy = targetTo.y - targetFrom.y;
  const targetLength = Math.hypot(targetDx, targetDy);
  const targetAngle = Math.atan2(targetDy, targetDx);
  return Mat.translation(targetFrom.x, targetFrom.y)
    .multiply(Mat.rotation(targetAngle))
    .multiply(Mat.scaling(targetLength / restLength, 1))
    .multiply(Mat.rotation(-restAngle))
    .multiply(Mat.translation(-restFrom.x, -restFrom.y));
}

// Rest positions of the feet (metatarsal joints) when standing; forward = -x.
const STAND = {
  a: { x: 640, y: 802 },
  b: { x: 812, y: 800 }
};
const THIGH = 58;          // hidden thigh length, hip -> knee
const TARSUS = 176;        // drawn tarsus length at scale 1
const STEP_PERIOD = 0.52;  // seconds per step (one foot), from the USFWS clip
const DUTY = 0.62;         // fraction of the cycle each foot spends on the ground
const SWING_DURATION = 0.4;
const ROCK_HZ = 2.1;       // in-place rocking rate

const IDLE_ACTIONS = ['look', 'look', 'look', 'rock', 'rock', 'preen', 'probe', 'stretch', 'shake', 'tilt'];

export class WoodcockPuppet {
  constructor(options) {
    this.assetRoot = options.assetRoot;
    this.onEvent = options.onEvent || (() => {});
    this.ready = false;
    this.layers = {};
    this.manifest = options.manifest;
    this.facing = 1;              // 1 = faces left (as photographed), -1 = faces right
    this.currentFacing = 1;
    this.mode = 'idle';           // idle | walk | call | held | falling | landed
    this.walk = null;             // { speed (master px/s), motion, startedAt }
    this.action = null;           // current idle action { name, startedAt, duration, data }
    this.nextActionAt = 0;
    this.lastInteractionAt = performance.now();
    this.dozing = false;
    this.pointer = { x: 0, y: 0, inside: false };   // normalised -1..1 relative to the bird
    this.blinkAt = performance.now() + 2500;
    this.blinkUntil = 0;
    this.callStartedAt = null;
    this.lastTime = performance.now();
    this.rockPhase = 0;
    this.walkClock = 0;
    this.travel = 0;
    this.heldSince = 0;
    this.fallSince = 0;
    this.landedAt = 0;
    this.landImpact = 0;
    this.holdVelocity = { x: 0, y: 0 };
    this.holdSway = 0;
    this.holdSwayVelocity = 0;
    this.fallHigh = false;
    // Petting (rubbing the bird with the pointer) and pecking at a still pointer.
    this.petLevel = 0;
    this.petStrokes = [];
    this.petLastDx = 0;
    this.petTravel = 0;
    this.pointerMaster = null;
    this.pointerStillSince = 0;
    this.peckAction = null;
    this.peckCooldownUntil = 0;
    this.petHappyClock = 0;          // seconds of sustained petting
    this.petMeepCooldownUntil = 0;   // don't meep from petting again before this
    this.hearts = [];
    this.nextHeartAt = 0;
    this.random = Math.random;

    // Smoothed rig parameters (master units / radians).
    this.p = this.restParameters();
    this.target = this.restParameters();
    this.legs = {
      a: { mode: 'stance', x: STAND.a.x, lift: 0, swingFrom: 0, swingTo: 0, swingT: 0, footRot: 0 },
      b: { mode: 'stance', x: STAND.b.x, lift: 0, swingFrom: 0, swingTo: 0, swingT: 0, footRot: 0 }
    };
    this.load();
  }

  restParameters() {
    return {
      bodyX: 0, bodyY: 0, pitch: 0, puffX: 1, puffY: 1,
      headX: 0, headY: 0, headRot: 0, headFollow: 0.28,
      upperRot: 0, lowerRot: 0,
      tailFan: 0.5, tailRot: 0,
      wingRot: 0,
      eyeClose: 0,
      gx: 0, gy: 0, gRot: 0,
      shadow: 1
    };
  }

  async load() {
    const names = Object.keys(this.manifest.layers);
    await Promise.all(names.map((name) => new Promise((resolve) => {
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => { this.layers[name] = image; resolve(); };
      image.onerror = () => resolve();
      image.src = `${this.assetRoot}/${name}.png`;
    })));
    this.ready = names.every((name) => this.layers[name]);
    this.shaded = {};
    this.hip = this.vec(this.manifest.pivots.hip);
    this.pivots = this.manifest.pivots;
    this.legRest = {
      a: { knee: this.vec(this.manifest.legs.a.knee), ankle: this.vec(this.manifest.legs.a.ankle) },
      b: { knee: this.vec(this.manifest.legs.b.knee), ankle: this.vec(this.manifest.legs.b.ankle) }
    };
  }

  vec(pair) { return { x: pair[0], y: pair[1] }; }

  // ------------------------------------------------------------------ inputs

  setFacing(direction, immediate = false) {
    this.facing = direction === 'right' ? -1 : 1;
    if (immediate) this.currentFacing = this.facing;
  }

  /**
   * @param master pointer position in master pixels (bird-facing-left frame), or null.
   */
  setPointer(normalizedX, normalizedY, inside, master = null) {
    const now = performance.now();
    const previous = this.pointerMaster;
    this.pointer = { x: clamp(normalizedX, -1, 1), y: clamp(normalizedY, -1, 1), inside };
    this.pointerMaster = inside ? master : null;
    if (inside) this.touch();

    if (inside && master && previous) {
      const dx = master.x - previous.x;
      const dy = master.y - previous.y;
      const overBody = master.x > 330 && master.x < 1540 && master.y > 40 && master.y < 820;
      // Rubbing: sideways strokes with direction reversals over the feathers.
      if (overBody && this.mode === 'idle' && !this.peckAction) {
        this.petTravel += Math.abs(dx);
        if (Math.sign(dx) !== 0 && Math.sign(dx) === -Math.sign(this.petLastDx) && this.petTravel > 55) {
          this.petStrokes.push(now);
          this.petTravel = 0;
        }
        if (dx !== 0) this.petLastDx = dx;
      }
      // Stillness (for pecking): any real movement resets the clock.
      if (Math.hypot(dx, dy) > 5) this.pointerStillSince = now;
    } else {
      this.pointerStillSince = now;
      this.petTravel = 0;
    }
  }

  /** Any user activity: cancels dozing and resets the idle timer. */
  touch() {
    this.lastInteractionAt = performance.now();
    if (this.dozing) this.wake();
  }

  wake() {
    if (!this.dozing) return;
    this.dozing = false;
    this.action = { name: 'wakeup', startedAt: performance.now(), duration: 900 };
    this.nextActionAt = performance.now() + 2500;
  }

  /** Called from the walk-state IPC. speed is in master px/s (already scaled). */
  setWalkState(state) {
    if (!state || !state.active) {
      if (this.mode === 'walk') {
        this.mode = 'idle';
        this.walk = null;
        this.nextActionAt = performance.now() + 3200;
      }
      return;
    }
    this.cancelAction();
    this.dozing = false;
    this.lastInteractionAt = performance.now();
    this.mode = 'walk';
    const previous = this.walk;
    this.walk = {
      speed: state.motion === 'walk' ? state.speed : 0,
      motion: state.motion,
      startedAt: performance.now()
    };
    this.setFacing(state.direction);
    if (state.motion === 'walk') this.cancelAction();
    if (state.motion === 'turn') {
      this.resetLegs();
    } else if (!previous) {
      this.resetLegs();
      this.walkClock = 0;
    }
  }

  playCall() {
    if (this.mode === 'held' || this.mode === 'falling') return;
    this.cancelAction();
    this.dozing = false;
    this.callStartedAt = performance.now();
    this.mode = 'call';
    this.touch();
  }

  /** Drag lifecycle from the pointer handlers / main process. */
  setHeld(held, velocity = { x: 0, y: 0 }) {
    this.touch();
    if (held) {
      if (this.mode === 'held') return;
      this.fallHigh = false;
      this.peckAction = null;
      this.cancelAction();
      this.callStartedAt = null;
      this.walk = null;
      this.mode = 'held';
      this.heldSince = performance.now();
      this.holdSway = 0;
      this.holdSwayVelocity = 0;
    } else if (this.mode === 'held') {
      this.mode = 'falling';
      this.fallSince = performance.now();
      this.holdVelocity = velocity;
    }
  }

  setDragVelocity(velocity) {
    this.holdVelocity = velocity;
  }

  setFalling(height = 0) {
    if (this.mode !== 'falling') {
      this.mode = 'falling';
      this.fallSince = performance.now();
    }
    if (height > 130) this.fallHigh = true;
  }

  setLanded(impact = 0) {
    this.lastInteractionAt = performance.now();
    this.fallHigh = false;
    this.mode = 'landed';
    this.landedAt = performance.now();
    this.landImpact = clamp(impact / 1400, 0.25, 1);
    this.resetLegs();
    this.nextActionAt = performance.now() + 2600;
  }

  cancelAction() {
    this.action = null;
  }

  resetLegs() {
    this.legs.a = { mode: 'stance', x: STAND.a.x, lift: 0, swingFrom: 0, swingTo: 0, swingT: 0, footRot: 0 };
    this.legs.b = { mode: 'stance', x: STAND.b.x, lift: 0, swingFrom: 0, swingTo: 0, swingT: 0, footRot: 0 };
  }

  // ---------------------------------------------------------------- update

  update(time) {
    const dt = clamp((time - this.lastTime) / 1000, 0.001, 0.05);
    this.lastTime = time;
    const target = this.restParameters();

    const facingRate = 1 - Math.exp(-dt * 11);
    this.currentFacing += (this.facing - this.currentFacing) * facingRate;

    // Blinking (suppressed while held / falling: eyes wide).
    if (time > this.blinkAt) {
      this.blinkUntil = time + 130;
      this.blinkAt = time + 2200 + this.random() * 4200;
    }
    const blink = this.blinkUntil > time ? Math.sin(((this.blinkUntil - time) / 130) * Math.PI) : 0;

    // Petting level: recent rub strokes raise it, time decays it.
    this.petStrokes = this.petStrokes.filter((at) => time - at < 2000);
    const petTarget = this.mode === 'idle' && this.pointer.inside
      ? clamp(this.petStrokes.length / 4)
      : 0;
    this.petLevel = expSmooth(this.petLevel, petTarget, petTarget > this.petLevel ? 5 : 1.6, dt);

    // Keep the strokes coming and the bird gets so pleased it lets out a happy
    // double meep (the same two-note call as the alarm, reported to the app so
    // it can play the sound).
    if (this.mode === 'idle' && this.petLevel > 0.6 && time > this.petMeepCooldownUntil) {
      this.petHappyClock += dt;
      if (this.petHappyClock > 4.2) {
        this.petHappyClock = 0;
        this.petMeepCooldownUntil = time + 14_000;
        this.onEvent({ type: 'pet-meep' });
        this.playCall();
      }
    } else if (this.petLevel < 0.25) {
      this.petHappyClock = Math.max(0, this.petHappyClock - dt * 1.5);
    }

    if (this.mode === 'call') this.updateCall(time, target);
    else if (this.mode === 'held') this.updateHeld(time, dt, target);
    else if (this.mode === 'falling') this.updateFalling(time, dt, target);
    else if (this.mode === 'landed') this.updateLanded(time, target);
    else if (this.mode === 'walk') this.updateWalk(time, dt, target);
    else this.updateIdle(time, dt, target);

    // Floating hearts while thoroughly petted.
    for (const heart of this.hearts) heart.age += dt;
    this.hearts = this.hearts.filter((heart) => heart.age < 1.6);
    if (this.petLevel > 0.65 && time > this.nextHeartAt && this.hearts.length < 3) {
      this.hearts.push({
        x: 420 + this.random() * 280,
        y: 20 + this.random() * 50,
        drift: (this.random() - 0.5) * 70,
        size: 62 + this.random() * 34,
        age: 0
      });
      this.nextHeartAt = time + 480 + this.random() * 420;
    }

    if (this.mode !== 'held' && this.mode !== 'falling') {
      target.eyeClose = Math.max(target.eyeClose, blink);
    }

    // Blend towards targets.  Legs are handled separately (exact, unsmoothed).
    const rates = {
      bodyX: 14, bodyY: 14, pitch: 14, puffX: 12, puffY: 12,
      headX: 16, headY: 16, headRot: 16, headFollow: 6,
      upperRot: 26, lowerRot: 26, tailFan: 6, tailRot: 10, wingRot: 26, eyeClose: 30,
      gx: 18, gy: 18, gRot: 12, shadow: 8
    };
    for (const key of Object.keys(target)) {
      this.p[key] = expSmooth(this.p[key], target[key], rates[key] || 12, dt);
    }
  }

  // -------------------------------------------------------------- behaviours

  updateIdle(time, dt, target) {
    const idleFor = time - this.lastInteractionAt;
    if (!this.dozing && idleFor > 240_000 && !this.action) {
      this.dozing = true;
      this.action = null;
    }
    if (this.dozing) {
      this.breathe(time, target, 1.4);
      const settle = smoothstep(0, 2600, time - this.lastInteractionAt - 240_000);
      target.eyeClose = 0.92 * settle;
      target.headY = 42 * settle;
      target.headX = 26 * settle;
      target.headRot = 0.08 * settle;
      target.puffX = 1 + 0.03 * settle;
      target.puffY = 1 + 0.04 * settle;
      target.tailFan = 0.25;
      this.settleLegs(dt);
      return;
    }

    this.breathe(time, target, 1);

    if (this.peckAction) {
      this.applyPeck(time, dt, target);
      return;
    }
    if (this.petLevel > 0.06) {
      this.applyPetting(time, dt, target);
      if (this.petLevel > 0.3) return;   // fully absorbed in being petted
    }
    this.lookAtPointer(target);
    this.maybeStartPeck(time);

    if (!this.action && time > this.nextActionAt) this.startIdleAction(time);
    if (this.action) this.applyIdleAction(time, dt, target);
    else this.settleLegs(dt);
  }

  /** Content, leaning into the stroking hand: eyes half closed, fluffed, tail wag. */
  applyPetting(time, dt, target) {
    const level = clamp(this.petLevel);
    const wag = Math.sin(time / 1000 * TAU * 2.6);
    const nuzzle = Math.sin(time / 1000 * TAU * 0.9);
    const towards = this.pointerMaster
      ? clamp((this.pointerMaster.x - 700) / 500, -1, 1)
      : 0;
    target.eyeClose = Math.max(target.eyeClose, (0.45 + 0.25 * Math.max(0, nuzzle)) * level);
    target.puffX = 1 + 0.035 * level;
    target.puffY = 1 + 0.05 * level;
    target.bodyX += towards * 26 * level;
    target.bodyY += -4 * level;
    target.pitch += 0.03 * level * nuzzle;
    target.headRot += (0.16 + 0.08 * nuzzle) * level;
    target.headX += (14 + towards * 22) * level;
    target.headY += (16 - 10 * nuzzle) * level;
    target.tailFan = 0.5 + 0.42 * level;
    target.tailRot += wag * 0.1 * level;
    target.wingRot += Math.max(0, wag) * 0.05 * level;
    this.settleLegs(dt);
  }

  /** A still pointer in front of the bill invites an inquisitive peck. */
  maybeStartPeck(time) {
    if (!this.pointer.inside || !this.pointerMaster || this.action || this.dozing) return;
    if (time < this.peckCooldownUntil || this.petLevel > 0.2) return;
    const point = this.pointerMaster;
    const inFrontZone = point.x < 560 && point.x > -160 && point.y > 210 && point.y < 900;
    if (!inFrontZone) return;
    if (time - this.pointerStillSince < 850) return;
    this.peckAction = {
      startedAt: time,
      target: { x: point.x, y: point.y },
      pecks: 1 + (this.random() < 0.4 ? 1 : 0)
    };
    this.peckCooldownUntil = time + 4500 + this.random() * 4500;
    this.onEvent({ type: 'peck' });
  }

  applyPeck(time, dt, target) {
    const peck = this.peckAction;
    const perPeck = 0.62;
    const total = 0.18 + peck.pecks * perPeck + 0.2;
    const t = (time - peck.startedAt) / 1000;
    if (t >= total) {
      this.peckAction = null;
      this.nextActionAt = time + 1800 + this.random() * 2600;
      return;
    }
    // Aim the bill tip at the target by shifting the neck top and rotating the head.
    const ntRest = this.vec(this.pivots.neckTop);
    const tip = this.vec(this.pivots.billTip);
    const restOffset = { x: tip.x - ntRest.x, y: tip.y - ntRest.y };
    const restAngle = Math.atan2(restOffset.y, restOffset.x);
    const restLength = Math.hypot(restOffset.x, restOffset.y);

    let strike = 0;
    for (let index = 0; index < peck.pecks; index += 1) {
      const start = 0.18 + index * perPeck;
      strike = Math.max(strike, pulse(t, start, 0.11, 0.1, 0.3));
    }
    const windup = pulse(t, 0.02, 0.12, 0.06 + peck.pecks * perPeck - 0.1, 0.24);

    const toTarget = { x: peck.target.x - ntRest.x, y: peck.target.y - ntRest.y };
    const distance = Math.hypot(toTarget.x, toTarget.y);
    const reach = clamp((distance - restLength) , -160, 150);
    const direction = { x: toTarget.x / Math.max(1, distance), y: toTarget.y / Math.max(1, distance) };
    const desired = Math.atan2(toTarget.y, toTarget.x);
    let rot = desired - restAngle;
    while (rot > Math.PI) rot -= TAU;
    while (rot < -Math.PI) rot += TAU;
    rot = clamp(rot, -0.85, 0.8);

    target.headFollow = 0.75;
    target.headRot = rot * (0.35 * windup + 0.65 * strike) - 0.05 * windup;
    target.headX = direction.x * (26 * windup + Math.max(0, reach) * 0.85 * strike) - 12 * windup;
    target.headY = direction.y * (26 * windup + Math.max(0, reach) * 0.85 * strike) - 8 * windup;
    target.bodyX += direction.x * 22 * strike;
    target.bodyY += Math.max(0, direction.y) * 14 * strike - 4 * windup;
    target.pitch += (direction.y > 0 ? -0.05 : 0.03) * strike;
    target.lowerRot = -0.14 * strike;
    target.upperRot = 0.03 * strike;
    target.eyeClose = 0.25 * strike;
    target.tailRot += 0.05 * strike;
    this.settleLegs(dt);
  }

  breathe(time, target, slow = 1) {
    const breath = Math.sin(time / (720 * slow));
    target.bodyY = -breath * 3.5;
    target.puffY = 1 + breath * 0.008;
    target.headY = -breath * 2.2;
    target.tailRot = breath * 0.012;
  }

  lookAtPointer(target) {
    if (!this.pointer.inside) return;
    // Tilt the bill slightly towards the pointer and lean into it a little.
    const forward = this.pointer.x * this.currentFacing;   // -1 = towards the bill side
    target.headRot += -this.pointer.y * 0.12;
    target.headX += -forward * 18;
    target.headY += this.pointer.y * 10;
    target.bodyX += -forward * 6;
  }

  startIdleAction(time) {
    let name = IDLE_ACTIONS[Math.floor(this.random() * IDLE_ACTIONS.length)];
    if (name === 'tilt' && !this.pointer.inside) name = 'look';
    const durations = { look: 2600, rock: 1900 + this.random() * 1600, preen: 2800, probe: 2900, stretch: 2300, shake: 900, tilt: 1800 };
    this.action = {
      name,
      startedAt: time,
      duration: durations[name],
      data: {
        side: this.random() < 0.5 ? -1 : 1,
        pokes: 3 + Math.floor(this.random() * 3),
        cycles: 4 + Math.floor(this.random() * 5),
        leg: this.random() < 0.5 ? 'a' : 'b'
      }
    };
    this.onEvent({ type: 'idle-action', name });
  }

  applyIdleAction(time, dt, target) {
    const action = this.action;
    const t = (time - action.startedAt) / 1000;
    const total = action.duration / 1000;
    if (t >= total) {
      this.action = null;
      this.nextActionAt = time + 2800 + this.random() * 5200;
      return;
    }
    const envelope = pulse(t, 0, 0.35, Math.max(0, total - 0.8), 0.45);
    switch (action.name) {
      case 'look': {
        // Two quick glances: bill down-and-forward, then up-and-back.
        const glance1 = pulse(t, 0.1, 0.22, 0.6, 0.3);
        const glance2 = pulse(t, 1.35, 0.22, 0.55, 0.35);
        target.headRot += -0.24 * glance1 + 0.3 * glance2;
        target.headX += -22 * glance1 + 26 * glance2;
        target.headY += 12 * glance1 - 24 * glance2;
        target.tailFan = 0.5 + 0.15 * glance2;
        this.settleLegs(dt);
        break;
      }
      case 'tilt': {
        // Cock the head towards the pointer.
        target.headRot += 0.24 * action.data.side * envelope;
        target.headY += -12 * envelope;
        target.headX += 10 * envelope;
        this.settleLegs(dt);
        break;
      }
      case 'rock': {
        // The woodcock's signature: the body rocks back and forth over planted
        // feet while the head stays level.
        this.rockPhase += TAU * ROCK_HZ * dt;
        this.applyRock(target, envelope, 1);
        this.settleLegs(dt);
        break;
      }
      case 'preen': {
        // Bill down into the breast feathers, nibbling.
        const down = envelope;
        const nibble = Math.max(0, Math.sin(t * TAU * 5.5)) * down;
        target.headRot += -0.95 * down + nibble * 0.06;
        target.headX += 34 * down;
        target.headY += 58 * down;
        target.lowerRot += -0.16 * nibble;
        target.upperRot += 0.03 * nibble;
        target.pitch += 0.03 * down;
        target.eyeClose = Math.max(target.eyeClose, 0.35 * down);
        this.settleLegs(dt);
        break;
      }
      case 'probe': {
        // Lean down and push the bill into the ground a few times.
        const down = envelope;
        const pokeCount = action.data.pokes;
        const pokePhase = clamp((t - 0.5) / Math.max(0.1, total - 1.3));
        const poke = down * Math.max(0, Math.sin(pokePhase * Math.PI * pokeCount)) ** 2;
        target.pitch += -0.14 * down - 0.05 * poke;
        target.bodyY += 24 * down + 10 * poke;
        target.headRot += -1.02 * down - 0.1 * poke;
        target.headX += -26 * down - 10 * poke;
        target.headY += 160 * down + 26 * poke;
        target.headFollow = 0.6;
        target.tailRot += 0.12 * down;
        target.tailFan = 0.5 + 0.3 * down;
        target.eyeClose = Math.max(target.eyeClose, 0.25 * poke);
        this.settleLegs(dt);
        break;
      }
      case 'stretch': {
        // One leg stretched straight back, toes pointing, body leaning forward.
        const stretch = pulse(t, 0.1, 0.5, Math.max(0, total - 1.4), 0.6);
        const leg = this.legs[action.data.leg];
        const other = this.legs[action.data.leg === 'a' ? 'b' : 'a'];
        const rest = STAND[action.data.leg];
        leg.mode = 'stance';
        leg.x = lerp(rest.x, rest.x + 330, stretch);
        leg.lift = 26 * stretch;
        leg.footRot = -0.55 * stretch;
        other.mode = 'stance';
        other.x = expSmooth(other.x, STAND[action.data.leg === 'a' ? 'b' : 'a'].x, 10, dt);
        other.lift = 0;
        other.footRot = 0;
        target.pitch += -0.1 * stretch;
        target.bodyX += -16 * stretch;
        target.bodyY += 6 * stretch;
        target.headRot += 0.08 * stretch;
        target.headX += -12 * stretch;
        target.tailFan = 0.5 + 0.35 * stretch;
        target.tailRot += -0.08 * stretch;
        break;
      }
      case 'shake': {
        // Quick feather shake: body wobble and head shake.
        const shake = pulse(t, 0, 0.12, 0.45, 0.25);
        const wobble = Math.sin(t * TAU * 11) * shake;
        target.puffX = 1 + 0.05 * shake + wobble * 0.03;
        target.puffY = 1 + 0.06 * shake - wobble * 0.02;
        target.wingRot += -0.1 * shake + wobble * 0.08;
        target.headRot += wobble * 0.09;
        target.headX += wobble * 8;
        target.tailFan = 0.5 + 0.5 * shake;
        target.tailRot += wobble * 0.08;
        target.pitch += wobble * 0.025;
        target.eyeClose = Math.max(target.eyeClose, 0.8 * shake);
        this.settleLegs(dt);
        break;
      }
      case 'wakeup': {
        const stretch = pulse(t, 0, 0.25, 0.3, 0.3);
        target.headY += -18 * stretch;
        target.puffY = 1 + 0.03 * stretch;
        target.tailFan = 0.5 + 0.3 * stretch;
        this.settleLegs(dt);
        break;
      }
      default:
        this.settleLegs(dt);
    }
  }

  /** Standing rock over planted feet: body sways, head stays nearly level. */
  applyRock(target, amount, headLock = 1) {
    const sway = Math.sin(this.rockPhase);
    const pitch = Math.sin(this.rockPhase + 0.9);
    target.pitch += pitch * 0.085 * amount;
    target.bodyX += -sway * 46 * amount;
    target.bodyY += -Math.abs(sway) * 7 * amount;
    target.tailRot += -pitch * 0.1 * amount;
    target.tailFan = 0.5 + 0.22 * amount;
    // The head keeps its place in the world while the body rocks underneath.
    target.headFollow = lerp(0.28, 0.12, amount * headLock);
    target.headY += -Math.abs(sway) * 6 * amount;
  }

  /** Legs drift back to the standing pose, one at a time, with a small step. */
  settleLegs(dt) {
    let stepping = null;
    for (const key of ['a', 'b']) {
      const leg = this.legs[key];
      if (leg.mode === 'swing') stepping = key;
    }
    for (const key of ['a', 'b']) {
      const leg = this.legs[key];
      const rest = STAND[key];
      if (leg.mode === 'swing') {
        this.advanceSwing(leg, dt);
        continue;
      }
      const error = rest.x - leg.x;
      if (Math.abs(error) > 36 && !stepping) {
        this.beginSwing(leg, rest.x, 0.34);
        stepping = key;
      } else if (Math.abs(error) <= 36) {
        leg.x = expSmooth(leg.x, rest.x, 6, dt);
        leg.lift = expSmooth(leg.lift, 0, 10, dt);
        leg.footRot = expSmooth(leg.footRot, 0, 10, dt);
      }
    }
  }

  beginSwing(leg, toX, duration) {
    leg.mode = 'swing';
    leg.swingFrom = leg.x;
    leg.swingTo = toX;
    leg.swingT = 0;
    leg.swingDuration = duration;
  }

  advanceSwing(leg, dt) {
    leg.swingT += dt;
    const progress = clamp(leg.swingT / leg.swingDuration);
    const eased = smoothstep(0, 1, progress);
    leg.x = lerp(leg.swingFrom, leg.swingTo, eased);
    const distance = Math.abs(leg.swingTo - leg.swingFrom);
    leg.lift = Math.sin(progress * Math.PI) * clamp(22 + distance * 0.16, 22, 74);
    // Toes hang a little mid-swing, flatten before touchdown.
    leg.footRot = -Math.sin(progress * Math.PI) * 0.14;
    if (progress >= 1) {
      leg.mode = 'stance';
      leg.lift = 0;
      leg.footRot = 0;
      leg.x = leg.swingTo;
    }
  }

  updateWalk(time, dt, target) {
    const walk = this.walk;
    const speed = walk ? walk.speed : 0;   // master px/s, positive = feet move tail-ward
    this.breathe(time, target, 1);

    if (walk && walk.motion === 'turn') {
      const t = (time - walk.startedAt) / 1000;
      const crouch = Math.sin(clamp(t / 0.44) * Math.PI);
      target.bodyY += 12 * crouch;
      target.pitch += -0.05 * crouch;
      target.headY += 6 * crouch;
      this.settleLegs(dt);
      return;
    }

    if (speed > 0) {
      this.walkClock += dt;
      this.travel += speed * dt;
      this.rockPhase += TAU * dt / STEP_PERIOD;
      const stanceLength = speed * DUTY * STEP_PERIOD * 2;   // distance a foot travels under the body
      const centre = 730;                                     // track centre in master x
      const legsArray = ['a', 'b'].map((key) => this.legs[key]);
      for (const leg of legsArray) {
        if (leg.mode === 'stance') {
          leg.x += speed * dt;
          leg.lift = expSmooth(leg.lift, 0, 14, dt);
          leg.footRot = expSmooth(leg.footRot, 0, 14, dt);
        } else {
          this.advanceSwing(leg, dt);
        }
      }
      const bothOnGround = legsArray.every((leg) => leg.mode === 'stance');
      // In the USFWS footage the feet only step while the body surges forward
      // (sin(rockPhase) > 0 side of the sway), never during the backward rock.
      const surging = Math.sin(this.rockPhase) > -0.15;
      if (bothOnGround && surging) {
        const rear = legsArray[0].x > legsArray[1].x ? legsArray[0] : legsArray[1];
        const front = rear === legsArray[0] ? legsArray[1] : legsArray[0];
        const half = stanceLength / 2;
        if (rear.x > centre + half * 0.98 || rear.x - front.x > stanceLength * 1.05) {
          this.beginSwing(rear, centre - half + (this.random() - 0.5) * 18, SWING_DURATION);
        }
      }
      // Rocking gait measured from the USFWS clip: the whole bird sways fore-aft
      // (about 13% of body length peak to peak), pitching nose-down as it surges
      // forward; the head rides along with ~85% of the sway and bobs vertically,
      // dipping on the surge -- the neck layer stretches to absorb the rest.
      const ramp = smoothstep(0, 0.45, this.walkClock);
      const sway = Math.sin(this.rockPhase);
      const surge = Math.sin(this.rockPhase + 0.55);
      target.bodyX += -sway * 88 * ramp;
      target.pitch += -surge * 0.075 * ramp - 0.02 * ramp;
      target.bodyY += -Math.abs(sway) * 10 * ramp;
      target.headFollow = lerp(0.28, 0.85, ramp);
      target.headX += sway * 30 * ramp - 8 * ramp;      // neck absorbs ~15% of the sway
      target.headY += -sway * 40 * ramp + 8 * ramp;     // head dips as the body surges forward
      target.headRot += surge * 0.05 * ramp;
      target.tailRot += -surge * 0.1 * ramp;
      target.tailFan = 0.5 + 0.2 * ramp;
    } else if (walk && walk.motion === 'forage') {
      // A long break at the far end of the walk: rock a little, then behave
      // like an idle bird (probing, preening, looking about) until it is time
      // to head home.
      this.walkClock = 0;
      const t = (time - walk.startedAt) / 1000;
      if (t < 3.2 && !this.action) {
        this.rockPhase += TAU * ROCK_HZ * dt;
        this.applyRock(target, pulse(t, 0, 0.45, 2.2, 0.5), 1);
        this.settleLegs(dt);
        return;
      }
      if (!this.action && time > this.nextActionAt) this.startIdleAction(time);
      if (this.action) this.applyIdleAction(time, dt, target);
      else this.settleLegs(dt);
    } else {
      // Paused mid-walk: the standing rock (only for 'rock' segments), then continue.
      this.walkClock = 0;
      this.rockPhase += TAU * ROCK_HZ * dt;
      const t = walk ? (time - walk.startedAt) / 1000 : 0;
      const amount = walk && walk.motion === 'rock' ? pulse(t, 0, 0.45, 8, 0.5) : 0;
      this.applyRock(target, amount, 1);
      for (const leg of ['a', 'b'].map((key) => this.legs[key])) {
        if (leg.mode === 'swing') this.advanceSwing(leg, dt);
        else {
          leg.lift = expSmooth(leg.lift, 0, 14, dt);
          leg.footRot = expSmooth(leg.footRot, 0, 14, dt);
        }
      }
    }
  }

  updateCall(time, target) {
    const t = (time - this.callStartedAt) / 1000;
    if (t > 1.62) {
      this.mode = 'idle';
      this.callStartedAt = null;
      this.nextActionAt = time + 3000;
      return;
    }
    // Two meeps: onsets matched to assets/audio/meep-pair.wav.
    const onsets = [0.1, 0.78];
    let open = 0;
    let throwBack = 0;
    let anticipation = 0;
    for (const onset of onsets) {
      open = Math.max(open, pulse(t, onset, 0.09, 0.2, 0.17));
      throwBack = Math.max(throwBack, pulse(t, onset - 0.02, 0.13, 0.24, 0.3));
      anticipation = Math.max(anticipation, pulse(t, onset - 0.12, 0.07, 0.03, 0.09));
    }
    const carry = 0.35 * pulse(t, 0.3, 0.1, 0.5, 0.3);   // stays half-up between meeps
    const back = Math.max(throwBack, carry);

    target.headRot = 0.62 * back - 0.06 * anticipation;
    target.headX = 34 * back - 10 * anticipation;
    target.headY = -52 * back + 12 * anticipation;
    target.headFollow = 0.35;
    target.upperRot = 0.11 * open;
    target.lowerRot = -0.5 * open;
    target.pitch = 0.11 * back - 0.03 * anticipation;
    target.bodyX = 12 * back;
    target.bodyY = -10 * back + 8 * anticipation;
    target.puffX = 1 - 0.02 * back;
    target.puffY = 1 + 0.06 * back;
    target.tailFan = 0.5 + 0.5 * back;
    target.tailRot = 0.1 * back;
    target.eyeClose = 0.35 * open;
    this.settleLegs(1 / 60);
  }

  updateHeld(time, dt, target) {
    const t = (time - this.heldSince) / 1000;
    // Pendulum sway driven by drag velocity (the bird trails the hand).
    const drive = clamp(-this.holdVelocity.x / 900, -1, 1) * this.currentFacing;
    this.holdSwayVelocity += (drive * 0.35 - this.holdSway) * 26 * dt - this.holdSwayVelocity * 5 * dt;
    this.holdSway += this.holdSwayVelocity * dt;
    const struggle = Math.max(0, 1 - t / 2.2) * (0.5 + 0.5 * Math.max(0, Math.sin(t * TAU * 0.35)));
    const kick = Math.sin(t * TAU * 4.2);

    target.gRot = this.holdSway * 0.9 + kick * 0.03 * struggle;
    target.gy = -18;
    target.pitch = 0.18 + kick * 0.02 * struggle;
    target.headRot = 0.32 - kick * 0.04 * struggle + this.holdSway * 0.4;
    target.headX = 12;
    target.headY = -14;
    target.headFollow = 0.9;
    target.puffX = 1.02;
    target.puffY = 0.97;
    target.tailFan = 1;
    target.tailRot = 0.18;
    target.eyeClose = 0;
    target.shadow = 0.15;
    // Legs dangle straight down and paddle while struggling.
    this.dangleLegs(dt, kick * struggle, 1);
  }

  updateFalling(time, dt, target) {
    const t = (time - this.fallSince) / 1000;
    if (this.fallHigh) {
      // Dropped from a height: rapid shallow wingbeats, the woodcock's whirring
      // flutter (their short rounded wings beat fast rather than deep).
      const beat = Math.sin(t * TAU * 9.5);
      const beatLag = Math.sin(t * TAU * 9.5 - 0.9);
      target.wingRot = -0.3 + beat * 0.42;
      target.gy = -10 + beatLag * 5;
      target.gRot = -0.06 * this.currentFacing + beat * 0.022;
      target.pitch = -0.16 + beatLag * 0.02;
      target.puffY = 1.03;
      target.headRot = 0.1;
      target.headX = -14;
      target.headY = -6;
      target.headFollow = 0.9;
      target.tailFan = 1;
      target.tailRot = -0.14;
      target.eyeClose = 0;
      target.shadow = 0.25;
      this.dangleLegs(dt, beat * 0.4, 0.35);
      return;
    }
    const flail = Math.sin(t * TAU * 6);
    target.gRot = -0.12 * this.currentFacing + flail * 0.04;
    target.gy = -6;
    target.pitch = -0.12;
    target.headRot = -0.15;
    target.headX = -20;
    target.headY = 16;
    target.headFollow = 0.9;
    target.tailFan = 1;
    target.tailRot = -0.2;
    target.puffX = 0.98;
    target.puffY = 1.03;
    target.eyeClose = 0;
    target.shadow = 0.25;
    this.dangleLegs(dt, flail, 0.5);
  }

  updateLanded(time, target) {
    const t = (time - this.landedAt) / 1000;
    if (t > 1.5) {
      this.mode = 'idle';
      return;
    }
    const impact = this.landImpact;
    const squash = pulse(t, 0, 0.05, 0.08, 0.32) * impact;
    const rebound = pulse(t, 0.36, 0.12, 0.05, 0.3) * impact * 0.5;
    const ruffle = pulse(t, 0.55, 0.1, 0.35, 0.25) * impact;
    const wobble = Math.sin(t * TAU * 10) * ruffle;
    target.wingRot = pulse(t, 0.3, 0.14, 0.1, 0.4) * -0.22 + wobble * 0.05;
    target.puffX = 1 + 0.12 * squash - 0.04 * rebound + wobble * 0.02;
    target.puffY = 1 - 0.16 * squash + 0.05 * rebound - wobble * 0.015;
    target.bodyY = 18 * squash - 8 * rebound;
    target.pitch = -0.06 * squash + wobble * 0.02;
    target.headY = 22 * squash - 10 * rebound;
    target.headRot = -0.12 * squash + wobble * 0.05;
    target.tailFan = 0.5 + 0.45 * Math.max(squash, ruffle);
    target.eyeClose = 0.9 * squash + 0.5 * ruffle;
    for (const key of ['a', 'b']) {
      const leg = this.legs[key];
      leg.mode = 'stance';
      leg.x = expSmooth(leg.x, STAND[key].x, 12, 1 / 60);
      leg.lift = 0;
      leg.footRot = 0;
    }
  }

  dangleLegs(dt, paddle, amount) {
    for (const [index, key] of ['a', 'b'].entries()) {
      const leg = this.legs[key];
      const sign = index === 0 ? 1 : -1;
      leg.mode = 'stance';
      leg.x = expSmooth(leg.x, this.hip.x - 40 + sign * 34 + paddle * sign * 40 * amount, 12, dt);
      leg.lift = expSmooth(leg.lift, -92 + paddle * sign * 22 * amount, 12, dt);
      leg.footRot = expSmooth(leg.footRot, -0.8 + paddle * sign * 0.25, 12, dt);
    }
  }

  // ------------------------------------------------------------------ draw

  /**
   * @param ctx CanvasRenderingContext2D
   * @param layout { centerX, groundY, width, pixelRatio } in CSS pixels; width = full master width on screen
   */
  draw(ctx, layout) {
    if (!this.ready) return;
    const p = this.p;
    const m = this.manifest;
    const scale = layout.width / m.master.width;
    const facing = this.currentFacing;

    // Canvas base: master -> screen (CSS px * devicePixelRatio), mirrored around
    // centerX when facing right.  drawLayer() uses absolute transforms, so the
    // device pixel ratio has to be part of this matrix.
    const dpr = layout.pixelRatio || 1;
    const base = Mat.scaling(dpr, dpr)
      .multiply(Mat.translation(layout.centerX, layout.groundY))
      .multiply(Mat.scaling(scale * facing, scale))
      .multiply(Mat.translation(-m.master.width / 2, -m.ground));

    // World (whole bird) offset + rotation about the body pivot, e.g. when carried.
    const bp = this.vec(m.pivots.body);
    const world = Mat.translation(p.gx, p.gy).rotateAbout(bp.x, bp.y, p.gRot);

    // Body: rock (pitch) about its pivot, sway, puff.
    const body = world
      .multiply(Mat.translation(p.bodyX, p.bodyY))
      .rotateAbout(bp.x, bp.y, p.pitch)
      .scaleAbout(bp.x, bp.y + 120, p.puffX, p.puffY);

    // Neck chain: the neck base rides the body; the neck top (which carries the
    // head) is stabilised in the world and offset by the behaviours.  The neck
    // layer stretches and bends between the two, so nothing pops at the seam.
    const nbRest = this.vec(m.pivots.neckBase);
    const ntRest = this.vec(m.pivots.neckTop);
    const neckBase = body.apply(nbRest.x, nbRest.y);
    const ntOnBody = body.apply(ntRest.x, ntRest.y);
    const ntOnWorld = world.apply(ntRest.x, ntRest.y);
    const neckTop = {
      x: lerp(ntOnWorld.x, ntOnBody.x, p.headFollow) + p.headX,
      y: lerp(ntOnWorld.y, ntOnBody.y, p.headFollow) + p.headY
    };
    // Keep the neck within its physical range so the texture never over-stretches.
    const restNeck = { x: ntRest.x - nbRest.x, y: ntRest.y - nbRest.y };
    const restNeckLength = Math.hypot(restNeck.x, restNeck.y);
    const neckVec = { x: neckTop.x - neckBase.x, y: neckTop.y - neckBase.y };
    const neckLength = Math.max(1, Math.hypot(neckVec.x, neckVec.y));
    const clampedLength = clamp(neckLength, restNeckLength * 0.72, restNeckLength * 1.3);
    if (clampedLength !== neckLength) {
      neckTop.x = neckBase.x + (neckVec.x / neckLength) * clampedLength;
      neckTop.y = neckBase.y + (neckVec.y / neckLength) * clampedLength;
    }
    const neck = segmentTransform(nbRest, ntRest, neckBase, neckTop);
    const worldRotation = Math.atan2(world.b, world.a);
    const restNeckAngle = Math.atan2(restNeck.y, restNeck.x);
    let neckBend = Math.atan2(neckTop.y - neckBase.y, neckTop.x - neckBase.x) - restNeckAngle - worldRotation;
    while (neckBend > Math.PI) neckBend -= TAU;
    while (neckBend < -Math.PI) neckBend += TAU;
    // The skull hangs off the neck top and inherits part of the neck's bend.
    const head = Mat.translation(neckTop.x - ntRest.x, neckTop.y - ntRest.y)
      .rotateAbout(ntRest.x, ntRest.y, worldRotation + p.headRot + neckBend * 0.45 + p.pitch * p.headFollow * 0.4);
    const up = this.vec(m.pivots.upperBill);
    const lo = this.vec(m.pivots.lowerBill);
    const upperBill = head.rotateAbout(up.x, up.y, p.upperRot);
    const lowerBill = head.rotateAbout(lo.x, lo.y, p.lowerRot);

    // Legs: two-bone chain from the hip (on the body) to the foot (on the ground).
    const hipWorld = body.apply(this.hip.x, this.hip.y);
    const legMats = {};
    for (const key of ['a', 'b']) {
      const leg = this.legs[key];
      const groundY = STAND[key].y;
      const foot = world.apply(leg.x, groundY - leg.lift);
      const rest = this.legRest[key];
      const chain = this.solveLeg(hipWorld, foot);
      const tarsus = segmentTransform(rest.knee, rest.ankle, chain.knee, foot);
      const footMat = Mat.translation(foot.x - rest.ankle.x, foot.y - rest.ankle.y)
        .rotateAbout(rest.ankle.x, rest.ankle.y, leg.footRot + worldRotation);
      legMats[key] = { tarsus, foot: footMat };
    }

    const tp = this.vec(m.pivots.tail);
    const fanAngles = [0, 0.12, 0.24, 0.36];

    ctx.save();
    // Tail fan (behind everything).
    fanAngles.slice().reverse().forEach((angle, index) => {
      const feather = body.rotateAbout(tp.x, tp.y, angle * p.tailFan + p.tailRot);
      const depth = 1 - (fanAngles.length - 1 - index) * 0.16;
      this.drawLayer(ctx, base, feather, 'tail-feather', depth);
    });
    this.drawLayer(ctx, base, legMats.b.tarsus, 'leg-b-tarsus', 0.92);
    this.drawLayer(ctx, base, legMats.b.foot, 'leg-b-foot', 0.92);
    this.drawLayer(ctx, base, legMats.a.tarsus, 'leg-a-tarsus');
    this.drawLayer(ctx, base, legMats.a.foot, 'leg-a-foot');
    this.drawLayer(ctx, base, body, 'body');
    if (Math.abs(p.wingRot) > 0.004) {
      const wp = this.vec(m.pivots.wing);
      this.drawLayer(ctx, base, body.rotateAbout(wp.x, wp.y, p.wingRot), 'wing');
    }
    this.drawLayer(ctx, base, neck, 'neck');
    this.drawLayer(ctx, base, head, 'head');
    this.drawLayer(ctx, base, lowerBill, 'bill-lower');
    this.drawLayer(ctx, base, upperBill, 'bill-upper');
    if (p.eyeClose > 0.03) this.drawEyelid(ctx, base, head, p.eyeClose);
    this.drawHearts(ctx, base);
    ctx.restore();
  }

  /** Little hearts floating up while the bird is being petted. */
  drawHearts(ctx, base) {
    if (!this.hearts.length) return;
    for (const heart of this.hearts) {
      const t = heart.age / 1.6;
      const x = heart.x + heart.drift * t;
      const y = heart.y - 150 * t;
      const alpha = Math.sin(Math.min(1, t / 0.15) * Math.PI / 2) * (1 - smoothstep(0.55, 1, t));
      const size = heart.size * (0.8 + 0.3 * t);
      const mat = base.multiply(Mat.translation(x, y));
      ctx.setTransform(mat.a, mat.b, mat.c, mat.d, mat.e, mat.f);
      ctx.globalAlpha = alpha * 0.9;
      ctx.fillStyle = '#f2788f';
      ctx.font = `${size}px "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('\u2665', 0, 0);
      ctx.globalAlpha = 1;
    }
  }

  /** Two-bone IK: hip -> knee -> foot, knee bent towards the tail (+x side). */
  solveLeg(hip, foot) {
    const dx = foot.x - hip.x;
    const dy = foot.y - hip.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const reach = THIGH + TARSUS;
    let tarsus = TARSUS;
    let thigh = THIGH;
    if (distance > reach) {
      const stretch = distance / reach;
      tarsus *= Math.min(1.32, stretch);
      thigh *= Math.min(1.32, stretch);
    }
    const total = thigh + tarsus;
    const d = Math.min(distance, total - 0.5);
    const cosA = clamp((thigh * thigh + d * d - tarsus * tarsus) / (2 * thigh * d), -1, 1);
    const angle = Math.acos(cosA);
    const ux = dx / distance;
    const uy = dy / distance;
    // Perpendicular pointing tail-ward (+x in master space).
    let nx = -uy;
    let ny = ux;
    if (nx < 0) { nx = -nx; ny = -ny; }
    const knee = {
      x: hip.x + thigh * (ux * Math.cos(angle) + nx * Math.sin(angle)),
      y: hip.y + thigh * (uy * Math.cos(angle) + ny * Math.sin(angle))
    };
    return { knee };
  }

  /** Pre-shaded copy of a layer (darker feathers behind others), baked once. */
  shadedLayer(name, brightness) {
    const key = `${name}@${brightness.toFixed(2)}`;
    if (this.shaded[key]) return this.shaded[key];
    const image = this.layers[name];
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    context.filter = `brightness(${brightness})`;
    context.drawImage(image, 0, 0);
    this.shaded[key] = canvas;
    return canvas;
  }

  drawLayer(ctx, base, local, name, brightness = 1) {
    const image = brightness === 1 ? this.layers[name] : this.shadedLayer(name, brightness);
    const box = this.manifest.layers[name];
    if (!image) return;
    const mat = base.multiply(local);
    ctx.setTransform(mat.a, mat.b, mat.c, mat.d, mat.e, mat.f);
    ctx.drawImage(image, box.x, box.y, box.w, box.h);
  }

  drawEyelid(ctx, base, head, amount) {
    const image = this.layers.eyelid;
    const box = this.manifest.layers.eyelid;
    const eye = this.vec(this.manifest.pivots.eye);
    const radius = this.manifest.pivots.eyeRadius + 8;
    const mat = base.multiply(head);
    ctx.save();
    ctx.setTransform(mat.a, mat.b, mat.c, mat.d, mat.e, mat.f);
    ctx.beginPath();
    // The lid closes from the top: reveal the patch down to a moving horizon.
    const horizon = eye.y - radius + amount * radius * 2;
    ctx.rect(eye.x - radius, eye.y - radius, radius * 2, horizon - (eye.y - radius));
    ctx.clip();
    ctx.drawImage(image, box.x, box.y, box.w, box.h);
    ctx.restore();
  }
}

export { clamp, lerp, smoothstep };

import * as THREE from '../../node_modules/three/build/three.module.js';

const TAU = Math.PI * 2;

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(Math.max(value, minimum), maximum);
}

function smoothstep(value) {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
}

function smoothPulse(value, riseStart, riseEnd, fallStart, fallEnd) {
  const rise = smoothstep((value - riseStart) / Math.max(0.0001, riseEnd - riseStart));
  const fall = 1 - smoothstep((value - fallStart) / Math.max(0.0001, fallEnd - fallStart));
  return clamp(Math.min(rise, fall));
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function makeRod(length, radius, material, radialSegments = 10) {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius * 0.86, length, radialSegments, 1),
    material
  );
  mesh.castShadow = true;
  return mesh;
}

function makeTaperedBill(length, baseRadius, tipRadius, material) {
  const geometry = new THREE.CylinderGeometry(tipRadius, baseRadius, length, 18, 1);
  geometry.rotateZ(Math.PI / 2);
  geometry.translate(-length / 2, 0, 0);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  return mesh;
}

/**
 * A lightweight articulated American woodcock used for motion blocking.
 * The shape is procedural, while its colour/feather variation is sampled
 * from the user's licensed idle photograph at runtime.
 */
export class WoodcockRig {
  constructor(renderer) {
    this.renderer = renderer;
    this.group = new THREE.Group();
    this.hoverGroup = new THREE.Group();
    this.directionGroup = new THREE.Group();
    this.character = new THREE.Group();
    this.group.add(this.hoverGroup);
    this.hoverGroup.add(this.directionGroup);
    this.directionGroup.add(this.character);

    this.currentYaw = 0;
    this.targetYaw = 0;
    this.currentFacingYaw = 0;
    this.targetFacingYaw = 0;
    this.lastTime = performance.now();
    this.direction = 'left';

    this.sphereGeometry = new THREE.SphereGeometry(1, 46, 32);
    this.smallSphereGeometry = new THREE.SphereGeometry(1, 28, 20);
    this.materials = this.createMaterials();
    this.buildCharacter();
    this.loadPhotoDetail();
  }

  createFeatherTexture(kind, sourceImage = null) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext('2d');
    const palettes = {
      body: ['#655d59', '#4e4948', '#847873', '#a18f82', '#302e2e'],
      head: ['#958a84', '#706864', '#b1a49b', '#433f3e', '#d0c2b5'],
      wing: ['#403d3d', '#272729', '#625b58', '#8b7e75', '#bbb0a4']
    };
    const palette = palettes[kind] || palettes.body;
    const gradient = context.createLinearGradient(0, 0, 512, 512);
    gradient.addColorStop(0, palette[2]);
    gradient.addColorStop(0.45, palette[0]);
    gradient.addColorStop(1, palette[1]);
    context.fillStyle = gradient;
    context.fillRect(0, 0, 512, 512);

    if (sourceImage) {
      const crop = kind === 'head'
        ? { x: 274, y: 0, width: 250, height: 205 }
        : kind === 'wing'
          ? { x: 82, y: 150, width: 382, height: 304 }
          : { x: 68, y: 108, width: 444, height: 360 };
      context.save();
      context.globalAlpha = kind === 'head' ? 0.72 : 0.62;
      context.filter = 'saturate(0.78) contrast(1.08)';
      context.drawImage(
        sourceImage,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        0,
        0,
        512,
        512
      );
      context.globalAlpha = 0.25;
      context.translate(512, 0);
      context.scale(-1, 1);
      context.drawImage(
        sourceImage,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        0,
        0,
        512,
        512
      );
      context.restore();
    }

    const random = seededRandom(kind === 'body' ? 1729 : kind === 'head' ? 2603 : 4099);
    context.globalCompositeOperation = 'soft-light';
    if (kind === 'head') {
      for (let stripe = 0; stripe < 4; stripe += 1) {
        const y = 74 + stripe * 93;
        context.strokeStyle = stripe % 2 ? 'rgba(31, 29, 29, 0.78)' : 'rgba(224, 210, 195, 0.55)';
        context.lineWidth = stripe % 2 ? 31 : 18;
        context.beginPath();
        context.moveTo(-30, y + 22);
        context.bezierCurveTo(150, y - 30, 355, y + 34, 550, y - 12);
        context.stroke();
      }
    } else {
      const rowHeight = kind === 'wing' ? 57 : 68;
      for (let row = 0; row < 9; row += 1) {
        const y = 24 + row * rowHeight;
        const offset = row % 2 ? -34 : 0;
        for (let column = 0; column < 9; column += 1) {
          const x = offset + column * 68 + (random() - 0.5) * 11;
          const width = (kind === 'wing' ? 49 : 58) * (0.88 + random() * 0.22);
          const height = (kind === 'wing' ? 30 : 36) * (0.86 + random() * 0.22);
          context.fillStyle = `rgba(25, 24, 25, ${0.28 + random() * 0.24})`;
          context.strokeStyle = `rgba(218, 202, 188, ${0.18 + random() * 0.25})`;
          context.lineWidth = 4 + random() * 3;
          context.beginPath();
          context.ellipse(x, y, width, height, (random() - 0.5) * 0.24, 0, Math.PI);
          context.fill();
          context.stroke();
        }
      }
    }

    context.globalCompositeOperation = 'overlay';
    for (let index = 0; index < 1100; index += 1) {
      const value = random() > 0.5 ? 255 : 15;
      context.fillStyle = `rgba(${value}, ${value}, ${value}, ${0.015 + random() * 0.035})`;
      context.fillRect(random() * 512, random() * 512, 1 + random() * 2, 1 + random() * 2);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    texture.needsUpdate = true;
    return texture;
  }

  makeFeatherMaterial(kind, sourceImage = null) {
    const texture = this.createFeatherTexture(kind, sourceImage);
    return new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: texture,
      bumpMap: texture,
      bumpScale: kind === 'wing' ? 0.026 : 0.018,
      roughness: 0.93,
      metalness: 0
    });
  }

  createMaterials() {
    return {
      body: this.makeFeatherMaterial('body'),
      head: this.makeFeatherMaterial('head'),
      wing: this.makeFeatherMaterial('wing'),
      breast: new THREE.MeshStandardMaterial({ color: 0x9b7764, roughness: 0.96 }),
      darkFeather: new THREE.MeshStandardMaterial({ color: 0x302d2f, roughness: 0.94 }),
      paleFeather: new THREE.MeshStandardMaterial({ color: 0xb9aaa0, roughness: 0.95 }),
      bill: new THREE.MeshStandardMaterial({ color: 0xa47f86, roughness: 0.72 }),
      billTip: new THREE.MeshStandardMaterial({ color: 0x4a3c42, roughness: 0.77 }),
      mouth: new THREE.MeshStandardMaterial({
        color: 0x381c25,
        roughness: 0.86,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide
      }),
      leg: new THREE.MeshStandardMaterial({ color: 0xa28a79, roughness: 0.9 }),
      eye: new THREE.MeshPhysicalMaterial({
        color: 0x100e12,
        roughness: 0.08,
        metalness: 0,
        clearcoat: 1,
        clearcoatRoughness: 0.08
      }),
      highlight: new THREE.MeshBasicMaterial({ color: 0xfffbec })
    };
  }

  replacePhotoMaterials(sourceImage) {
    ['body', 'head', 'wing'].forEach((kind) => {
      const material = this.materials[kind];
      const previousMap = material.map;
      const nextMap = this.createFeatherTexture(kind, sourceImage);
      material.map = nextMap;
      material.bumpMap = nextMap;
      material.needsUpdate = true;
      previousMap?.dispose();
    });
  }

  loadPhotoDetail() {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => this.replacePhotoMaterials(image);
    image.onerror = () => {};
    image.src = '../../assets/character/idle.png';
  }

  makeEllipsoid(scale, material, geometry = this.sphereGeometry) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.scale.copy(scale);
    mesh.castShadow = true;
    return mesh;
  }

  buildCharacter() {
    this.character.position.set(0.08, 0.03, 0);

    this.bodyRig = new THREE.Group();
    this.character.add(this.bodyRig);
    const body = this.makeEllipsoid(new THREE.Vector3(1.22, 0.86, 0.72), this.materials.body);
    body.position.set(0.22, 0.02, 0);
    this.bodyRig.add(body);

    const breast = this.makeEllipsoid(new THREE.Vector3(0.73, 0.7, 0.66), this.materials.breast);
    breast.position.set(-0.55, -0.16, 0);
    this.bodyRig.add(breast);

    this.wingBackRig = this.createWing(-0.58, false);
    this.wingFrontRig = this.createWing(0.59, true);
    this.bodyRig.add(this.wingBackRig, this.wingFrontRig);

    this.tailRig = new THREE.Group();
    this.tailRig.position.set(1.24, -0.04, 0);
    this.bodyRig.add(this.tailRig);
    [-0.16, 0, 0.16].forEach((z, index) => {
      const feather = new THREE.Mesh(
        new THREE.ConeGeometry(0.16 - index * 0.012, 0.92 + index * 0.08, 10, 1),
        index === 1 ? this.materials.paleFeather : this.materials.darkFeather
      );
      feather.rotation.z = -Math.PI / 2;
      feather.position.set(0.42 + index * 0.035, -0.04 - Math.abs(index - 1) * 0.035, z);
      feather.castShadow = true;
      this.tailRig.add(feather);
    });

    this.neck = this.makeEllipsoid(new THREE.Vector3(0.59, 0.65, 0.57), this.materials.breast);
    this.neck.position.set(-0.69, 0.28, 0);
    this.character.add(this.neck);

    this.headBase = new THREE.Vector3(-0.83, 0.57, 0);
    this.headRig = new THREE.Group();
    this.headRig.position.copy(this.headBase);
    this.character.add(this.headRig);
    const head = this.makeEllipsoid(new THREE.Vector3(0.55, 0.51, 0.51), this.materials.head);
    this.headRig.add(head);

    const crownBack = this.makeEllipsoid(
      new THREE.Vector3(0.47, 0.055, 0.515),
      this.materials.darkFeather,
      this.smallSphereGeometry
    );
    crownBack.position.set(0.09, 0.33, 0);
    crownBack.rotation.z = -0.12;
    this.headRig.add(crownBack);
    const crownFront = crownBack.clone();
    crownFront.scale.set(0.43, 0.043, 0.52);
    crownFront.position.set(-0.05, 0.16, 0);
    crownFront.rotation.z = -0.16;
    this.headRig.add(crownFront);

    this.eyeNear = this.createEye(0.465, true);
    this.eyeFar = this.createEye(-0.465, false);
    this.headRig.add(this.eyeFar, this.eyeNear);

    const eyebrow = this.makeEllipsoid(
      new THREE.Vector3(0.25, 0.045, 0.065),
      this.materials.paleFeather,
      this.smallSphereGeometry
    );
    eyebrow.position.set(-0.18, 0.22, 0.47);
    eyebrow.rotation.z = -0.18;
    this.headRig.add(eyebrow);

    this.billRig = new THREE.Group();
    this.billRig.position.set(-0.47, -0.035, 0);
    this.billRig.rotation.z = 0.035;
    this.headRig.add(this.billRig);
    this.upperBill = new THREE.Group();
    this.lowerBill = new THREE.Group();
    this.billRig.add(this.upperBill, this.lowerBill);
    const upper = makeTaperedBill(1.48, 0.082, 0.029, this.materials.bill);
    upper.scale.z = 0.72;
    upper.position.y = 0.028;
    this.upperBill.add(upper);
    const lower = makeTaperedBill(1.43, 0.068, 0.025, this.materials.bill);
    lower.scale.z = 0.64;
    lower.position.y = -0.032;
    this.lowerBill.add(lower);
    const upperTip = makeTaperedBill(0.25, 0.034, 0.023, this.materials.billTip);
    upperTip.position.set(-1.24, 0.027, 0);
    upperTip.scale.z = 0.72;
    this.upperBill.add(upperTip);
    const lowerTip = makeTaperedBill(0.23, 0.03, 0.021, this.materials.billTip);
    lowerTip.position.set(-1.2, -0.03, 0);
    lowerTip.scale.z = 0.62;
    this.lowerBill.add(lowerTip);
    this.mouthInterior = new THREE.Mesh(
      new THREE.PlaneGeometry(1.32, 0.1),
      this.materials.mouth
    );
    this.mouthInterior.position.set(-0.66, -0.012, 0.004);
    this.mouthInterior.scale.y = 0.001;
    this.billRig.add(this.mouthInterior);

    this.legs = [
      this.createLeg(-0.17, 0.29),
      this.createLeg(0.18, -0.29)
    ];
    this.legs.forEach((leg) => this.character.add(leg.root));
  }

  createWing(z, isFront) {
    const group = new THREE.Group();
    group.position.set(0.3, 0.04, z);
    group.rotation.z = -0.18;
    const wing = this.makeEllipsoid(new THREE.Vector3(0.96, 0.54, 0.115), this.materials.wing);
    group.add(wing);

    if (isFront) {
      const featherLayout = [
        [-0.45, 0.13, 0.23, 0.11],
        [-0.12, 0.2, 0.27, 0.12],
        [0.25, 0.17, 0.29, 0.12],
        [0.57, 0.07, 0.25, 0.105],
        [-0.32, -0.08, 0.27, 0.12],
        [0.03, -0.03, 0.3, 0.13],
        [0.39, -0.1, 0.29, 0.12],
        [-0.14, -0.28, 0.28, 0.115],
        [0.22, -0.27, 0.3, 0.12]
      ];
      featherLayout.forEach(([x, y, width, height], index) => {
        const feather = this.makeEllipsoid(
          new THREE.Vector3(width, height, 0.025),
          index % 3 === 0 ? this.materials.paleFeather : this.materials.darkFeather,
          this.smallSphereGeometry
        );
        feather.position.set(x, y, 0.115);
        feather.rotation.z = -0.16 + (index % 3) * 0.07;
        group.add(feather);
      });
    }
    return group;
  }

  createEye(z, near) {
    const rig = new THREE.Group();
    rig.position.set(-0.19, 0.13, z);
    const eye = this.makeEllipsoid(
      new THREE.Vector3(0.135, 0.138, 0.062),
      this.materials.eye,
      this.smallSphereGeometry
    );
    rig.add(eye);
    if (near) {
      const highlight = this.makeEllipsoid(
        new THREE.Vector3(0.028, 0.032, 0.014),
        this.materials.highlight,
        this.smallSphereGeometry
      );
      highlight.position.set(-0.035, 0.043, 0.058);
      rig.add(highlight);
    }
    return rig;
  }

  createLeg(x, z) {
    const root = new THREE.Group();
    root.position.set(x, -0.57, z);
    const upper = makeRod(0.43, 0.045, this.materials.leg);
    upper.position.y = -0.215;
    root.add(upper);
    const knee = new THREE.Group();
    knee.position.y = -0.42;
    root.add(knee);
    const lower = makeRod(0.34, 0.038, this.materials.leg);
    lower.position.y = -0.17;
    knee.add(lower);
    const foot = new THREE.Group();
    foot.position.y = -0.34;
    knee.add(foot);

    const addToe = (length, angle, radius = 0.022) => {
      const toe = makeRod(length, radius, this.materials.leg, 8);
      toe.rotation.z = Math.PI / 2;
      toe.rotation.y = angle;
      const direction = new THREE.Vector3(-Math.cos(angle), 0, Math.sin(angle));
      toe.position.copy(direction.multiplyScalar(length / 2));
      toe.position.y = -0.018;
      foot.add(toe);
    };
    addToe(0.5, 0);
    addToe(0.42, 0.42, 0.019);
    addToe(0.4, -0.42, 0.019);
    addToe(0.3, Math.PI, 0.018);
    return {
      root,
      knee,
      foot,
      basePosition: root.position.clone()
    };
  }

  setTargetYaw(yaw) {
    this.targetYaw = clamp(yaw, -0.18, 0.18);
  }

  setDirection(direction, immediate = false) {
    this.direction = direction === 'right' ? 'right' : 'left';
    this.targetFacingYaw = this.direction === 'right' ? Math.PI : 0;
    if (immediate) this.currentFacingYaw = this.targetFacingYaw;
  }

  resetPose(time) {
    this.character.position.set(0.08, 0.03, 0);
    this.character.rotation.set(0, 0, 0);
    this.character.scale.set(1, 1, 1);
    this.bodyRig.position.set(0, 0, 0);
    this.bodyRig.rotation.set(0, 0, 0);
    this.bodyRig.scale.set(1, 1, 1);
    this.neck.position.set(-0.69, 0.28, 0);
    this.neck.rotation.set(0, 0, 0);
    this.neck.scale.set(0.59, 0.65, 0.57);
    this.headRig.position.copy(this.headBase);
    this.headRig.rotation.set(0, 0, 0);
    this.headRig.scale.set(1, 1, 1);
    this.billRig.rotation.set(0, 0, 0.035);
    this.upperBill.rotation.set(0, 0, 0);
    this.lowerBill.rotation.set(0, 0, 0);
    this.mouthInterior.scale.set(1, 0.001, 1);
    this.materials.mouth.opacity = 0;
    this.tailRig.rotation.set(0, 0, 0);
    this.wingFrontRig.rotation.set(0, 0, -0.18);
    this.wingBackRig.rotation.set(0, 0, -0.18);
    this.legs.forEach((leg) => {
      leg.root.position.copy(leg.basePosition);
      leg.root.rotation.set(0, 0, 0);
      leg.knee.rotation.set(0, 0, 0);
      leg.foot.rotation.set(0, 0, 0);
    });

    const blinkPhase = time % 4_650;
    const blink = blinkPhase < 95
      ? Math.max(0.07, Math.abs(blinkPhase - 47.5) / 47.5)
      : 1;
    this.eyeNear.scale.set(1, blink, 1);
    this.eyeFar.scale.set(1, blink, 1);
  }

  applyIdle(time) {
    const breath = Math.sin(time * 0.00205);
    const watch = Math.sin(time * 0.00073 + 0.9);
    this.bodyRig.position.y = breath * 0.018;
    this.bodyRig.scale.y = 1 + breath * 0.008;
    this.neck.position.y += breath * 0.012;
    this.headRig.position.y += breath * 0.013;
    this.headRig.rotation.z = watch * 0.012;
    this.tailRig.rotation.z = -breath * 0.012;
  }

  applyWalk(time, startedAt) {
    const phase = ((time - startedAt) / 1_036) * TAU;
    const sway = Math.sin(phase);
    const settle = Math.sin(phase * 2);
    const rise = Math.abs(Math.sin(phase));

    this.character.position.x += settle * 0.025;
    this.bodyRig.position.y = 0.015 + rise * 0.045;
    this.bodyRig.rotation.z = sway * 0.062;
    this.bodyRig.rotation.x = settle * 0.025;
    this.neck.position.x += -sway * 0.025;
    this.neck.position.y += rise * 0.025;
    this.headRig.position.x += -sway * 0.075 + settle * 0.025;
    this.headRig.position.y += rise * 0.055;
    this.headRig.rotation.z = -sway * 0.074 + settle * 0.018;
    this.tailRig.rotation.z = -sway * 0.045;
    this.wingFrontRig.rotation.z = -0.18 + sway * 0.025;
    this.wingBackRig.rotation.z = -0.18 + sway * 0.018;

    this.legs.forEach((leg, index) => {
      const legPhase = phase + index * Math.PI;
      const swing = Math.sin(legPhase);
      const lift = Math.max(0, Math.sin(legPhase));
      leg.root.position.x = leg.basePosition.x + swing * 0.1;
      leg.root.position.y = leg.basePosition.y + lift * 0.13;
      leg.root.rotation.z = swing * 0.26;
      leg.knee.rotation.z = -Math.max(0, swing) * 0.28 + Math.min(0, swing) * 0.08;
      leg.foot.rotation.z = -swing * 0.18 - lift * 0.08;
    });
  }

  applyTurn(time, startedAt) {
    const phase = clamp((time - startedAt) / 460);
    const crouch = Math.sin(phase * Math.PI);
    this.bodyRig.position.y = -0.025 * crouch;
    this.headRig.position.y += 0.035 * crouch;
    this.headRig.rotation.z = -0.035 * crouch;
    this.tailRig.rotation.z = 0.025 * crouch;
  }

  applyCall(localTime) {
    let openness = 0;
    let anticipation = 0;
    let blink = 1;
    [0, 0.76].forEach((start) => {
      const progress = (localTime - start) / 0.56;
      if (progress < 0 || progress > 1) return;
      openness = Math.max(openness, smoothPulse(progress, 0.17, 0.34, 0.7, 0.98));
      anticipation = Math.max(anticipation, smoothPulse(progress, 0, 0.1, 0.19, 0.36));
      blink = Math.min(blink, 1 - 0.88 * smoothPulse(progress, 0, 0.055, 0.1, 0.18));
    });

    this.character.position.y -= anticipation * 0.035;
    this.bodyRig.position.y = -anticipation * 0.035 + openness * 0.028;
    this.bodyRig.rotation.z = anticipation * 0.045 + openness * 0.055;
    this.bodyRig.scale.set(1 - openness * 0.028, 1 + openness * 0.055, 1 + openness * 0.025);
    this.neck.position.x += anticipation * -0.055 + openness * 0.085;
    this.neck.position.y += anticipation * -0.05 + openness * 0.12;
    this.neck.scale.y = 0.65 * (1 + openness * 0.1);
    this.headRig.position.x += anticipation * -0.07 + openness * 0.12;
    this.headRig.position.y += anticipation * -0.055 + openness * 0.18;
    this.headRig.rotation.z = anticipation * 0.085 - openness * 0.39;
    this.upperBill.rotation.z = -openness * 0.052;
    this.lowerBill.rotation.z = openness * 0.34;
    this.mouthInterior.scale.y = 0.02 + openness * 1.55;
    this.materials.mouth.opacity = openness * 0.94;
    this.wingFrontRig.rotation.z = -0.18 - openness * 0.055;
    this.wingBackRig.rotation.z = -0.18 + openness * 0.035;
    this.tailRig.rotation.z = openness * 0.04;
    this.eyeNear.scale.y = Math.min(this.eyeNear.scale.y, Math.max(0.08, blink));
    this.eyeFar.scale.y = Math.min(this.eyeFar.scale.y, Math.max(0.08, blink));
  }

  update(time, action) {
    const deltaSeconds = Math.min(0.05, Math.max(0.001, (time - this.lastTime) / 1000));
    this.lastTime = time;
    this.resetPose(time);

    const yawResponse = 1 - Math.exp(-8 * deltaSeconds);
    this.currentYaw = THREE.MathUtils.lerp(this.currentYaw, this.targetYaw, yawResponse);
    this.hoverGroup.rotation.y = this.currentYaw;

    const facingDelta = Math.atan2(
      Math.sin(this.targetFacingYaw - this.currentFacingYaw),
      Math.cos(this.targetFacingYaw - this.currentFacingYaw)
    );
    this.currentFacingYaw += facingDelta * (1 - Math.exp(-9.5 * deltaSeconds));
    this.directionGroup.rotation.y = this.currentFacingYaw;

    if (action.type === 'walk') this.applyWalk(time, action.startedAt);
    else if (action.type === 'turn') this.applyTurn(time, action.startedAt);
    else if (action.type === 'call') this.applyCall((time - action.startedAt) / 1000);
    else this.applyIdle(time);
  }
}

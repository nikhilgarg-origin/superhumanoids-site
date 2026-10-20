// Live physics section. Loaded only after the visitor asks for it.
// Physics runs in WebAssembly; rendering builds meshes from our visual packs.
import * as THREE from 'three';
import { RoomEnvironment } from './vendor/three/RoomEnvironment.js';
import loadMujoco from './vendor/mujoco/mujoco.js';

const Z_UP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);

const MATERIALS = {
  white_paint: { color: 0xc9cacb, roughness: 0.38, metalness: 0, clearcoat: 0.25, clearcoatRoughness: 0.2 },
  grey_shell: { color: 0x6c7076, roughness: 0.34, metalness: 0, clearcoat: 0.3, clearcoatRoughness: 0.15 },
  black_plastic: { color: 0x0b0b0c, roughness: 0.5, metalness: 0 },
  dark_anodized: { color: 0x1a1b1d, roughness: 0.38, metalness: 0.85 },
  aluminium: { color: 0xb4b7ba, roughness: 0.4, metalness: 1 },
  led: { color: 0x2a8fd0, roughness: 0.3, metalness: 0, emissive: 0x1d6fa8, emissiveIntensity: 1.2 },
};

// Each body: how to stage it, how to drive it, what the visitor does to it.
const BODIES = {
  quadruped: {
    camera: { pos: [1.35, 0.95, 1.2], target: [0, 0.16, 0] },
    hint: 'Drag the robot to shove it, or focus the scene and use the arrow keys. It holds its stance until you push too hard.',
  },
  arm: {
    camera: { pos: [1.5, 1.15, 1.35], target: [0.3, 0.26, 0] },
    hint: 'Drag the ring, or use the arrow keys and Page Up/Down, and the arm follows. Knock the cubes around, or press G to close the gripper on one.',
  },
};

export async function startSim(root, { onProgress = () => {} } = {}) {
  const canvas = root.querySelector('canvas');
  const status = root.querySelector('[data-sim-status]');
  const hint = root.querySelector('[data-sim-hint]');
  const clock = root.querySelector('[data-sim-clock]');
  const gripBtn = root.querySelector('[data-sim-grip]');

  // ---------- load everything in parallel, report bytes ----------
  const files = {
    // pre-gzipped so every static host serves them small; inflated below
    wasm: 'vendor/mujoco/mujoco.wasm.gz',
    quadruped: 'assets/sim/quadruped.mjb.gz', quadrupedvis: 'assets/sim/quadruped.vis.bin.gz',
    arm: 'assets/sim/arm.mjb.gz', armvis: 'assets/sim/arm.vis.bin.gz',
  };
  const loaded = {}, total = {};
  const report = () => {
    const l = Object.values(loaded).reduce((a, b) => a + b, 0);
    const t = Object.values(total).reduce((a, b) => a + b, 0) || 1;
    onProgress(Math.min(0.99, l / Math.max(t, 5.2e6)));
  };
  async function fetchBytes(key, url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    total[key] = +res.headers.get('content-length') || 0;
    const reader = res.body.getReader(); const chunks = []; loaded[key] = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); loaded[key] += value.length; report();
    }
    const blob = new Blob(chunks);
    const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    if (head[0] !== 0x1f || head[1] !== 0x8b) return new Uint8Array(await blob.arrayBuffer()); // host already inflated it
    const plain = await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    return new Uint8Array(plain);
  }
  const bytes = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([k, u]) => [k, await fetchBytes(k, u)])));
  const mj = await loadMujoco({ wasmBinary: bytes.wasm.buffer });
  onProgress(1);

  // ---------- three.js stage ----------
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, matchMedia('(pointer: coarse)').matches ? 1.5 : 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const ground = new THREE.Color('#1d1e1f');
  scene.background = ground;
  scene.fog = new THREE.Fog(ground, 3.2, 7.5);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;

  const key = new THREE.DirectionalLight(0xfff4ea, 2.6);
  key.position.set(-2.2, 3.6, 2.4);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -1.6, right: 1.6, top: 1.6, bottom: -1.6, near: 0.5, far: 9 });
  key.shadow.radius = 6; key.shadow.bias = -0.0002; key.shadow.normalBias = 0.025;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 1.4); rim.position.set(1.5, 2.2, -2.6); scene.add(rim);

  const tex = new THREE.TextureLoader().load('assets/sim/concrete.jpg');
  tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(6, 6);
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(16, 16),
    new THREE.MeshStandardMaterial({ map: tex, color: 0x8a8b8c, roughness: 0.62 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);

  const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 40);
  const camTarget = new THREE.Vector3();

  // ---------- robots ----------
  const world = new THREE.Group(); world.quaternion.copy(Z_UP); scene.add(world);
  const mats = Object.fromEntries(Object.entries(MATERIALS).map(([k, v]) => [k, new THREE.MeshPhysicalMaterial(v)]));
  // inner dark parts overlap the painted shells in the decimated meshes; let the shells win the depth test
  for (const k of ['black_plastic', 'dark_anodized']) Object.assign(mats[k], { polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4 });

  function buildVisuals(bin) {
    const dv = new DataView(bin.buffer, bin.byteOffset);
    const hlen = dv.getUint32(0, true);
    const head = JSON.parse(new TextDecoder().decode(bin.subarray(4, 4 + hlen)));
    const base = 4 + hlen;
    return head.geoms.map(g => {
      const verts = new Float32Array(bin.buffer.slice(bin.byteOffset + base + g.v[0], bin.byteOffset + base + g.v[0] + g.v[1] * 12));
      const fBytes = g.f[1] * 3 * g.f[2];
      const fbuf = bin.buffer.slice(bin.byteOffset + base + g.f[0], bin.byteOffset + base + g.f[0] + fBytes);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
      geo.setIndex(new THREE.BufferAttribute(g.f[2] === 2 ? new Uint16Array(fbuf) : new Uint32Array(fbuf), 1));
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, mats[g.mat] || mats.black_plastic);
      mesh.position.fromArray(g.pos);
      mesh.quaternion.set(g.quat[1], g.quat[2], g.quat[3], g.quat[0]);
      mesh.castShadow = mesh.receiveShadow = true;
      return { body: g.body, mesh };
    });
  }

  function makeRobot(name) {
    const vfs = new mj.MjVFS();
    vfs.addBuffer(`${name}.mjb`, bytes[name]);
    const model = mj.MjModel.mj_loadModel(`${name}.mjb`, vfs);
    const data = new mj.MjData(model);
    const group = new THREE.Group(); group.visible = false; world.add(group);
    const bodies = [];
    for (let b = 0; b < model.nbody; b++) { const o = new THREE.Group(); o.userData.body = b; group.add(o); bodies.push(o); }
    for (const { body, mesh } of buildVisuals(bytes[name + 'vis'])) {
      const id = mj.mj_name2id(model, mj.mjtObj.mjOBJ_BODY.value, body);
      if (id >= 0) { mesh.userData.body = id; bodies[id].add(mesh); }
    }
    // primitive geoms that only exist in the physics model (the props)
    for (let g = 0; g < model.ngeom; g++) {
      if (model.geom_type[g] !== mj.mjtGeom.mjGEOM_BOX.value || model.geom_group[g] !== 0) continue;
      const s = model.geom_size.slice(g * 3, g * 3 + 3);
      const rgba = model.geom_rgba.slice(g * 4, g * 4 + 4);
      const m = new THREE.Mesh(new THREE.BoxGeometry(s[0] * 2, s[1] * 2, s[2] * 2),
        new THREE.MeshPhysicalMaterial({ color: new THREE.Color(rgba[0], rgba[1], rgba[2]), metalness: 0.85, roughness: 0.32 }));
      m.castShadow = m.receiveShadow = true; m.userData.body = model.geom_bodyid[g];
      bodies[model.geom_bodyid[g]].add(m);
    }
    const r = { name, model, data, group, bodies, meshes: [] };
    group.traverse(o => o.isMesh && r.meshes.push(o));
    reset(r);
    return r;
  }

  function reset(r) {
    mj.mj_resetDataKeyframe(r.model, r.data, 0);
    if (r.model.nkey) r.data.ctrl.set(r.model.key_ctrl.slice(0, r.model.nu));
    mj.mj_forward(r.model, r.data);
    r.fallen = 0;
  }

  const robots = { quadruped: makeRobot('quadruped'), arm: makeRobot('arm') };

  // ---------- controllers ----------
  const quadrupedStand = robots.quadruped.model.key_qpos.slice(7, 19);
  function controlQuadruped(r) {
    const q = r.data.qpos, v = r.data.qvel, c = r.data.ctrl;
    for (let j = 0; j < 12; j++) c[j] = 60 * (quadrupedStand[j] - q[7 + j]) - 3 * v[6 + j];
  }

  const arm = robots.arm;
  const hand = mj.mj_name2id(arm.model, mj.mjtObj.mjOBJ_BODY.value, 'hand');
  const JP = new mj.DoubleBuffer(3 * arm.model.nv), JR = new mj.DoubleBuffer(3 * arm.model.nv);
  const armGoal = new THREE.Vector3(0.45, 0, 0.32);            // MuJoCo frame, fingertip target
  let grip = 255;
  const qCmd = new Float64Array(7);
  function controlArm(r) {
    const d = r.data, m = r.model;
    if (!r.qInit) { for (let i = 0; i < 7; i++) qCmd[i] = d.qpos[i]; r.qInit = true; }
    // one damped-least-squares step per physics step on the commanded posture
    const R = d.xmat.slice(hand * 9, hand * 9 + 9);
    const tip = [d.xpos[hand * 3] + R[2] * 0.105, d.xpos[hand * 3 + 1] + R[5] * 0.105, d.xpos[hand * 3 + 2] + R[8] * 0.105];
    mj.mj_jac(m, d, JP, JR, tip, hand);
    const jp = JP.GetView(), jr = JR.GetView();
    const nv = m.nv;
    // position error + keep the gripper pointing down (z axis of hand -> world -z)
    const e = [armGoal.x - tip[0], armGoal.y - tip[1], armGoal.z - tip[2]];
    const zx = R[2], zy = R[5], zz = R[8];
    const er = [zy * -1 - zz * 0, zz * 0 - zx * -1, 0]; // z_hand x (0,0,-1)
    const err = [e[0], e[1], e[2], er[0] * 0.5, er[1] * 0.5, er[2] * 0.5];
    const J = [];
    for (let row = 0; row < 3; row++) J.push(Array.from(jp.slice(row * nv, row * nv + 7)));
    for (let row = 0; row < 3; row++) J.push(Array.from(jr.slice(row * nv, row * nv + 7)).map(x => x * 0.5));
    // dq = J^T (J J^T + λI)^-1 e   (6x6 solve)
    const A = [...Array(6)].map((_, i) => [...Array(6)].map((_, k) => J[i].reduce((s, x, n) => s + x * J[k][n], 0) + (i === k ? 2e-3 : 0)));
    const y = solve6(A, err);
    for (let n = 0; n < 7; n++) {
      let dq = 0; for (let i = 0; i < 6; i++) dq += J[i][n] * y[i];
      qCmd[n] += Math.max(-0.004, Math.min(0.004, dq * 0.6));
      const lo = m.jnt_range[n * 2], hi = m.jnt_range[n * 2 + 1];
      qCmd[n] = Math.min(hi, Math.max(lo, qCmd[n]));
      d.ctrl[n] = qCmd[n];
    }
    d.ctrl[7] = grip;
  }
  function solve6(A, b) {
    const n = 6, M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
    return x;
  }

  // drag target for the arm
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.006, 16, 48),
    new THREE.MeshStandardMaterial({ color: 0x5479ea, emissive: 0x2a46b0, emissiveIntensity: 0.9, roughness: 0.3 }));
  ring.rotation.x = Math.PI / 2; scene.add(ring);
  const ringHit = new THREE.Mesh(new THREE.SphereGeometry(0.09), new THREE.MeshBasicMaterial({ visible: false }));
  ring.add(ringHit);

  // ---------- interaction ----------
  let active = null;
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const dragPlane = new THREE.Plane(), hitW = new THREE.Vector3(), cursorW = new THREE.Vector3();
  let grab = null; // { body, local: Vector3 (body frame, MuJoCo), kind }
  const tether = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    new THREE.LineBasicMaterial({ color: 0x5479ea, transparent: true, opacity: 0.9, depthTest: false }));
  tether.renderOrder = 10;
  tether.visible = false; scene.add(tether);

  const toMj = v => new THREE.Vector3(v.x, -v.z, v.y);     // three (Y-up) -> MuJoCo (Z-up)
  const toThree = (x, y, z, out = new THREE.Vector3()) => out.set(x, z, -y);

  function pick(ev) {
    const rect = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    if (active.name === 'arm') {
      const h = ray.intersectObject(ringHit)[0];
      if (h) return { kind: 'ring', point: ring.position.clone() };
    }
    const h = ray.intersectObjects(active.meshes, false)[0];
    if (!h) return null;
    const b = h.object.userData.body;
    return { kind: 'body', body: b, point: h.point.clone() };
  }
  function bodyPose(r, b) {
    const d = r.data;
    const p = toThree(d.xpos[b * 3], d.xpos[b * 3 + 1], d.xpos[b * 3 + 2]);
    const q = new THREE.Quaternion(d.xquat[b * 4 + 1], d.xquat[b * 4 + 2], d.xquat[b * 4 + 3], d.xquat[b * 4]).premultiply(Z_UP);
    return { p, q };
  }
  function onDown(ev) {
    if (!active) return;
    const hit = pick(ev);
    if (!hit) return;
    ev.preventDefault();
    canvas.setPointerCapture?.(ev.pointerId);
    if (hit.kind === 'body') {
      // arm base and static bodies have no dofs; only grab free bodies or the quadruped
      if (active.name === 'arm' && active.model.body_dofnum[hit.body] === 0) return;
      const { p, q } = bodyPose(active, hit.body);
      hit.local = hit.point.clone().sub(p).applyQuaternion(q.clone().invert());
    }
    grab = hit;
    dragPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()).negate(), hit.point);
    cursorW.copy(hit.point);
    root.classList.add('is-dragging');
    root.dataset.grab = hit.kind === 'ring' ? 'ring' : hit.body;
  }
  function onMove(ev) {
    if (!grab) {
      if (active && ev.pointerType === 'mouse') canvas.style.cursor = pick(ev) ? 'grab' : '';
      return;
    }
    const rect = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    ray.ray.intersectPlane(dragPlane, cursorW);
    if (grab.kind === 'ring') {
      const g = toMj(cursorW);
      const rxy = Math.hypot(g.x, g.y);
      const k = rxy > 0.78 ? 0.78 / rxy : 1;                  // keep the goal inside the arm's reach
      armGoal.set(Math.max(0.12, g.x * k), g.y * k, Math.min(0.75, Math.max(0.03, g.z)));
    }
  }
  function onUp() { grab = null; tether.visible = false; root.classList.remove('is-dragging'); delete root.dataset.grab; }
  canvas.addEventListener('pointerdown', onDown);
  addEventListener('pointermove', onMove, { passive: true });
  addEventListener('pointerup', onUp); addEventListener('pointercancel', onUp);
  // on touch, only claim the gesture when it starts on the robot or the ring, so the page still scrolls
  canvas.addEventListener('touchstart', ev => {
    const t = ev.touches[0]; if (t && pick(t)) ev.preventDefault();
  }, { passive: false });

  // keyboard alternative to dragging
  const keyPush = { x: 0, y: 0, until: 0 };
  canvas.addEventListener('keydown', ev => {
    const dir = { ArrowLeft: [0, 1], ArrowRight: [0, -1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[ev.key];
    if (active.name === 'arm') {
      if (dir) armGoal.set(Math.max(0.12, armGoal.x + dir[0] * 0.03), armGoal.y + dir[1] * 0.03, armGoal.z);
      else if (ev.key === 'PageUp') armGoal.z = Math.min(0.75, armGoal.z + 0.03);
      else if (ev.key === 'PageDown') armGoal.z = Math.max(0.03, armGoal.z - 0.03);
      else if (ev.key === 'g' || ev.key === 'G') gripBtn.click();
      else return;
    } else if (dir) {
      Object.assign(keyPush, { x: dir[0], y: dir[1], until: performance.now() + 180 });
    } else return;
    ev.preventDefault();
  });

  function applyDrag(r) {
    r.data.xfrc_applied.fill(0);
    if (r.name === 'quadruped' && performance.now() < keyPush.until) {
      const m = r.model.body_subtreemass[1] * 3;
      r.data.xfrc_applied[6] = keyPush.x * m; r.data.xfrc_applied[7] = keyPush.y * m;
    }
    if (!grab || grab.kind !== 'body') return;
    const b = grab.body, d = r.data;
    const { p, q } = bodyPose(r, b);
    hitW.copy(grab.local).applyQuaternion(q).add(p);
    const f = cursorW.clone().sub(hitW);
    const mass = r.model.body_subtreemass[b] || 1;
    f.multiplyScalar(mass * 20).clampLength(0, mass * 3);   // roughly a hand shove (~45 N on the quadruped)
    const F = toMj(f), P = toMj(hitW);
    if (r.name === 'quadruped') F.z = Math.min(F.z, 0);              // a shove pushes sideways; it never lifts
    const c = [d.xipos[b * 3], d.xipos[b * 3 + 1], d.xipos[b * 3 + 2]];
    const rx = P.x - c[0], ry = P.y - c[1], rz = P.z - c[2];
    const o = b * 6;
    d.xfrc_applied[o] = F.x; d.xfrc_applied[o + 1] = F.y; d.xfrc_applied[o + 2] = F.z;
    d.xfrc_applied[o + 3] = ry * F.z - rz * F.y; d.xfrc_applied[o + 4] = rz * F.x - rx * F.z; d.xfrc_applied[o + 5] = rx * F.y - ry * F.x;
    tether.geometry.setFromPoints([hitW, cursorW]); tether.visible = true;
  }

  // ---------- switching ----------
  function show(name) {
    for (const r of Object.values(robots)) r.group.visible = r.name === name;
    active = robots[name];
    ring.visible = name === 'arm';
    gripBtn.hidden = name !== 'arm';
    hint.textContent = BODIES[name].hint;
    placeCamera();
    onUp();
  }
  root.querySelectorAll('[data-sim-body]').forEach(btn => btn.addEventListener('click', () => {
    root.querySelectorAll('[data-sim-body]').forEach(b => b.setAttribute('aria-pressed', b === btn));
    show(btn.dataset.simBody);
  }));
  root.querySelector('[data-sim-reset]').addEventListener('click', () => {
    reset(active);
    if (active.name === 'arm') { armGoal.set(0.45, 0, 0.32); arm.qInit = false; grip = 255; gripBtn.setAttribute('aria-pressed', 'false'); gripBtn.textContent = 'Close gripper'; }
  });
  gripBtn.addEventListener('click', () => {
    grip = grip > 0 ? 0 : 255;
    const closed = grip === 0;
    gripBtn.setAttribute('aria-pressed', String(closed));
    gripBtn.textContent = closed ? 'Open gripper' : 'Close gripper';
  });

  // ---------- loop ----------
  // portrait screens look down more steeply so the floor, not the void, fills the frame
  function placeCamera() {
    if (!active) return;
    const c = BODIES[active.name].camera;
    camTarget.fromArray(c.target);
    camera.position.fromArray(c.pos);
    if (camera.aspect < 1) camera.position.sub(camTarget).multiplyScalar(1.12).add(camTarget).setY(c.pos[1] * 1.7);
    camera.lookAt(camTarget);
  }
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h;
    camera.fov = w < h ? 46 : 32;
    camera.updateProjectionMatrix();
    placeCamera();
  }
  new ResizeObserver(resize).observe(canvas); resize();

  let visible = true, last = performance.now(), simBudget = 0;
  // adaptive quality: if frames run long for a sustained stretch (a slower GPU), step the render
  // resolution and shadow detail down until the scene holds its frame rate
  let slow = 0, tier = 0, prevFrame = 0;
  const tiers = [
    () => renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)),
    () => { renderer.setPixelRatio(1); key.shadow.mapSize.set(1024, 1024); key.shadow.map?.dispose(); key.shadow.map = null; },
    () => { renderer.setPixelRatio(0.8); key.shadow.radius = 2; },
  ];
  function adapt(now) {
    const dt = prevFrame ? now - prevFrame : 16; prevFrame = now;
    if (dt > 100) return;                       // tab switch or first frame: not a performance signal
    slow = dt > 22 ? slow + 1 : Math.max(0, slow - 2);
    if (slow > 45 && tier < tiers.length) { tiers[tier++](); resize(); slow = 0; }
  }
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; last = performance.now(); }).observe(root);
  document.addEventListener('visibilitychange', () => { last = performance.now(); });

  const tmpQ = new THREE.Quaternion();
  function frame(now) {
    requestAnimationFrame(frame);
    if (!visible || document.hidden || !active) return;
    const r = active, m = r.model, d = r.data, dt = m.opt.timestep;
    simBudget = Math.min(simBudget + (now - last) / 1000, 1 / 20);
    last = now;
    while (simBudget >= dt) {
      if (r.name === 'quadruped') controlQuadruped(r); else controlArm(r);
      applyDrag(r);
      mj.mj_step(m, d);
      simBudget -= dt;
    }
    for (let b = 1; b < m.nbody; b++) {
      const o = r.bodies[b];
      // bodies live inside `world` (already Z-up), so MuJoCo coordinates go in directly
      o.position.set(d.xpos[b * 3], d.xpos[b * 3 + 1], d.xpos[b * 3 + 2]);
      o.quaternion.set(d.xquat[b * 4 + 1], d.xquat[b * 4 + 2], d.xquat[b * 4 + 3], d.xquat[b * 4]);
    }
    if (r.name === 'arm') toThree(armGoal.x, armGoal.y, armGoal.z, ring.position);
    if (r.name === 'quadruped') {
      const up = 1 - 2 * (d.qpos[4] ** 2 + d.qpos[5] ** 2);
      r.fallen = up < 0.5 ? r.fallen + 1 : 0;
      status.textContent = r.fallen > 30 ? 'It went over. Press Reset to stand it back up.' : '';
    } else status.textContent = '';
    clock.textContent = `t ${d.time.toFixed(1)} s`;
    renderer.render(scene, camera);
    adapt(now);
  }

  show('quadruped');
  requestAnimationFrame(frame);
}

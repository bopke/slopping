import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

const radiusOf = (m) => 0.4 + 0.35 * Math.sqrt(m);
const INTERP = 0.1; // seconds of interpolation delay for remote entities

const FLOOR_VS = `varying vec3 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.); vW=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }`;
const FLOOR_FS = `
varying vec3 vW; uniform float uR, uV, uT;
float grid(vec2 p, float s, float w){ vec2 g=abs(fract(p/s-.5)-.5)/fwidth(p/s); return 1.-min(min(g.x,g.y)/w,1.); }
void main(){
  float d = length(vW.xz);
  vec3 col = mix(vec3(.02,.03,.09), vec3(.04,.07,.17), smoothstep(uR,0.,d));
  float g1 = grid(vW.xz, 4., 1.2), g2 = grid(vW.xz, 20., 1.6);
  col += vec3(.1,.35,.6)*g1*.35 + vec3(.2,.5,.9)*g2*.35;
  float rings = .5+.5*sin(d*.35 - uT*.8); col += vec3(.0,.05,.1)*rings*smoothstep(uR,0.,d);
  float edge = smoothstep(1.2,0.,abs(d-uR)); col += vec3(.15,.6,.8)*edge*0.9;
  if(uV < uR - .5){
    float out_ = smoothstep(uV-.4,uV+.4,d);
    float pulse = .6+.4*sin(uT*5.);
    col = mix(col, vec3(.3,.02,.08)*pulse + col*.3, out_*.8);
    col += vec3(.9,.12,.25)*smoothstep(.8,0.,abs(d-uV))*.9;
  }
  float a = 1. - smoothstep(uR+.2, uR+2., d);
  gl_FragColor = vec4(col, a);
}`;

export class World {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x03040c);
    this.scene.fog = new THREE.FogExp2(0x03040c, 0.0065);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.5, 600);
    this.camTarget = new THREE.Vector3();
    this.camZoom = 1;
    this.shake = 0;

    this.scene.add(new THREE.HemisphereLight(0x88aaff, 0x110022, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(20, 40, 10); this.scene.add(sun);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.5, 0.8);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.floorMat = new THREE.ShaderMaterial({
      vertexShader: FLOOR_VS, fragmentShader: FLOOR_FS, transparent: true,
      uniforms: { uR: { value: 70 }, uV: { value: 70 }, uT: { value: 0 } },
    });
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(1000, 1000).rotateX(-Math.PI / 2), this.floorMat);
    this.scene.add(this.floor);
    this.buildStars();
    this.buildShards();
    this.buildParticles();
    this.powerups = new Map();

    this.players = new Map(); // id -> entity
    this.selfId = null;
    this.serverOffset = null;
    this.labels = document.getElementById('labels');
    addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  setArena(r) { this.floorMat.uniforms.uR.value = r; this.arenaR = r; }

  buildStars() {
    const n = 900, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.283, d = 140 + Math.random() * 200;
      pos[i * 3] = Math.cos(a) * d; pos[i * 3 + 1] = 10 + Math.random() * 90; pos[i * 3 + 2] = Math.sin(a) * d;
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.scene.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 1.6, color: 0x8fb0ff, fog: false })));
  }

  // ---------- shards ----------
  buildShards() {
    this.maxShards = 800;
    const geo = new THREE.OctahedronGeometry(0.55);
    this.shardMesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), this.maxShards);
    this.shardMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.maxShards * 3), 3);
    this.shardMesh.frustumCulled = false;
    this.shardMesh.count = 0;
    this.scene.add(this.shardMesh);
    this.shards = new Map();
    this.tmpM = new THREE.Matrix4(); this.tmpQ = new THREE.Quaternion(); this.tmpP = new THREE.Vector3(); this.tmpS = new THREE.Vector3(); this.tmpC = new THREE.Color();
  }
  reset() { for (const id of [...this.players.keys()]) this.removePlayer(id); for (const id of [...this.powerups.keys()]) this.removePowerup(id); this.shards.clear(); this.voidR = undefined; }
  setShards(list) { this.shards.clear(); list.forEach((s) => this.addShard(s)); }
  addShard([id, x, z, k]) { this.shards.set(id, { x, z, k, born: performance.now() / 1000 }); }
  removeShard(id, by) {
    const s = this.shards.get(id);
    if (s) { this.burst(s.x, 0.5, s.z, s.k ? 0xffd23d : 0x35f0ff, 4, 4); this.shards.delete(id); }
  }
  updateShards(t) {
    let i = 0;
    for (const [id, s] of this.shards) {
      if (i >= this.maxShards) break;
      const grow = Math.min(1, (t - s.born) * 4);
      const sc = (s.k ? 1.6 : 1) * grow;
      this.tmpP.set(s.x, 0.9 + Math.sin(t * 2 + id) * 0.2, s.z);
      this.tmpQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t * 1.5 + id);
      this.tmpS.set(sc, sc * 1.4, sc);
      this.shardMesh.setMatrixAt(i, this.tmpM.compose(this.tmpP, this.tmpQ, this.tmpS));
      this.shardMesh.setColorAt(i, this.tmpC.set(s.k ? 0xffc928 : 0x35f0ff));
      i++;
    }
    this.shardMesh.count = i;
    this.shardMesh.instanceMatrix.needsUpdate = true;
    if (this.shardMesh.instanceColor) this.shardMesh.instanceColor.needsUpdate = true;
  }

  // ---------- powerups ----------
  static PU_COLOR = { speed: 0xb6ff3d, shield: 0x35f0ff, magnet: 0xb44dff };
  addPowerup([id, x, z, type]) {
    if (this.powerups.has(id)) return;
    const c = World.PU_COLOR[type] ?? 0xffffff;
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.9, 0), new THREE.MeshBasicMaterial({ color: c, toneMapped: false })));
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.08, 8, 40), new THREE.MeshBasicMaterial({ color: c, toneMapped: false }));
    ring.rotation.x = Math.PI / 2; g.add(ring);
    g.position.set(x, 1.6, z); this.scene.add(g);
    this.powerups.set(id, { g, ring, x, z, color: c });
  }
  removePowerup(id) {
    const u = this.powerups.get(id); if (!u) return;
    this.burst(u.x, 1.5, u.z, u.color, 30, 9, 0.7, 0.9);
    this.scene.remove(u.g); this.powerups.delete(id);
  }
  setPowerups(list) { for (const id of [...this.powerups.keys()]) this.removePowerup(id); list.forEach((u) => this.addPowerup(u)); }
  setHue(id, hue) {
    const p = this.players.get(id); if (!p) return;
    p.meta.hue = hue; p.color.setHSL(hue / 360, 0.85, 0.55);
    p.body.material.color.copy(p.color); p.body.material.emissive.copy(p.color);
    p.el.style.color = `hsl(${hue} 90% 75%)`;
  }

  // ---------- particles ----------
  buildParticles() {
    const N = (this.pN = 2500);
    this.pPos = new Float32Array(N * 3); this.pCol = new Float32Array(N * 3); this.pSize = new Float32Array(N);
    this.pVel = new Float32Array(N * 3); this.pLife = new Float32Array(N); this.pMax = new Float32Array(N); this.pBase = new Float32Array(N);
    this.pHead = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    g.setAttribute('size', new THREE.BufferAttribute(this.pSize, 1));
    const m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true,
      uniforms: { uScale: { value: innerHeight / 2 } },
      vertexShader: `attribute float size; varying vec3 vC; uniform float uScale; void main(){ vC=color; vec4 mv=modelViewMatrix*vec4(position,1.); gl_PointSize=size*uScale/-mv.z; gl_Position=projectionMatrix*mv; }`,
      fragmentShader: `varying vec3 vC; void main(){ float d=length(gl_PointCoord-.5); if(d>.5) discard; gl_FragColor=vec4(vC*(1.-d*2.)*1.6,1.); }`,
    });
    this.particles = new THREE.Points(g, m); this.particles.frustumCulled = false; this.scene.add(this.particles);
    this.pMat = m;
  }
  burst(x, y, z, color, n = 12, speed = 6, size = 0.5, life = 0.7) {
    const c = this.tmpC.set(color);
    for (let k = 0; k < n; k++) {
      const i = this.pHead++ % this.pN, a = Math.random() * 6.283, s = Math.random() * speed;
      this.pPos.set([x, y, z], i * 3);
      this.pVel[i * 3] = Math.cos(a) * s; this.pVel[i * 3 + 1] = Math.random() * speed * 0.5; this.pVel[i * 3 + 2] = Math.sin(a) * s;
      this.pCol.set([c.r, c.g, c.b], i * 3);
      this.pMax[i] = this.pLife[i] = life * (0.5 + Math.random() * 0.7); this.pBase[i] = size * (0.5 + Math.random());
    }
  }
  updateParticles(dt) {
    for (let i = 0; i < this.pN; i++) {
      if (this.pLife[i] <= 0) { this.pSize[i] = 0; continue; }
      this.pLife[i] -= dt;
      const k = i * 3, drag = Math.exp(-2.5 * dt);
      this.pVel[k] *= drag; this.pVel[k + 1] = this.pVel[k + 1] * drag - 3 * dt; this.pVel[k + 2] *= drag;
      this.pPos[k] += this.pVel[k] * dt; this.pPos[k + 1] = Math.max(0.1, this.pPos[k + 1] + this.pVel[k + 1] * dt); this.pPos[k + 2] += this.pVel[k + 2] * dt;
      this.pSize[i] = this.pBase[i] * Math.max(0, this.pLife[i] / this.pMax[i]);
    }
    const a = this.particles.geometry.attributes;
    a.position.needsUpdate = a.color.needsUpdate = a.size.needsUpdate = true;
    this.pMat.uniforms.uScale.value = innerHeight / 2;
  }

  // ---------- players ----------
  addPlayer(meta) {
    if (this.players.has(meta.id)) return;
    const color = new THREE.Color().setHSL(meta.hue / 360, 0.85, 0.55);
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 24),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.55, roughness: 0.25, metalness: 0.2 }),
    );
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.55, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 }));
    const shield = new THREE.Mesh(new THREE.SphereGeometry(1.25, 24, 16), new THREE.MeshBasicMaterial({ color: 0x9ff, transparent: true, opacity: 0.25, depthWrite: false }));
    shield.visible = false;
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(1.1, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4, depthWrite: false }));
    shadow.position.y = 0.02;
    group.add(body, core, shield); this.scene.add(group, shadow);
    const el = document.createElement('div');
    el.className = 'label' + (meta.admin ? ' admin' : '') + (meta.bot ? ' bot' : '');
    el.textContent = meta.name; el.style.color = `hsl(${meta.hue} 90% 75%)`;
    this.labels.appendChild(el);
    this.players.set(meta.id, { meta, color, group, body, core, shield, shadow, el, buf: [], alive: false, mass: 10, x: 0, z: 0, vx: 0, vz: 0, flags: 0, trail: 0 });
  }
  removePlayer(id) {
    const p = this.players.get(id); if (!p) return;
    this.scene.remove(p.group, p.shadow); p.el.remove(); this.players.delete(id);
  }
  applySnapshot(msg) {
    const now = performance.now() / 1000;
    const seen = new Set();
    for (const [id, x, z, m, vx, vz, flags] of msg.p) {
      const p = this.players.get(id); if (!p) continue;
      seen.add(id);
      if (!p.alive) { p.buf.length = 0; p.x = x; p.z = z; }
      p.alive = true; p.flags = flags; p.mass = m; p.vx = vx; p.vz = vz;
      p.buf.push({ t: now, x, z, m });
      if (p.buf.length > 8) p.buf.shift();
      p.last = { t: now, x, z, vx, vz };
    }
    for (const [id, p] of this.players) if (!seen.has(id)) p.alive = false;
    this.voidTarget = msg.v;
    if (this.voidR === undefined) this.voidR = msg.v;
  }

  entityPos(p, now, self, dt) {
    if (self && p.last) {
      // light prediction: extrapolate from the last server state
      const dtS = Math.min(0.12, now - p.last.t);
      const tx = p.last.x + p.last.vx * dtS, tz = p.last.z + p.last.vz * dtS;
      const k = 1 - Math.exp(-dt * 18);
      if (p.dx === undefined) { p.dx = tx; p.dz = tz; }
      p.dx += (tx - p.dx) * k; p.dz += (tz - p.dz) * k;
      return [p.dx, p.dz];
    }
    const rt = now - INTERP, b = p.buf;
    if (!b.length) return [p.x, p.z];
    if (rt <= b[0].t) return [b[0].x, b[0].z];
    for (let i = b.length - 1; i > 0; i--) {
      if (b[i - 1].t <= rt) {
        const a = b[i - 1], c = b[i], f = Math.min(1, (rt - a.t) / Math.max(0.001, c.t - a.t));
        return [a.x + (c.x - a.x) * f, a.z + (c.z - a.z) * f];
      }
    }
    const l = b[b.length - 1];
    return [l.x + p.vx * Math.min(0.15, rt - l.t), l.z + p.vz * Math.min(0.15, rt - l.t)];
  }

  frame(dt, t) {
    this.floorMat.uniforms.uT.value = t;
    if (this.voidTarget !== undefined) { this.voidR += (this.voidTarget - this.voidR) * (1 - Math.exp(-dt * 10)); this.floorMat.uniforms.uV.value = this.voidR; }
    this.updateShards(t);
    this.updateParticles(dt);
    for (const [id, u] of this.powerups) { u.g.position.y = 1.6 + Math.sin(t * 2 + id) * 0.3; u.g.rotation.y = t * 1.5; u.ring.rotation.z = t * 2; }
    const now = performance.now() / 1000;
    const camP = this.camera.position;
    let me = null;

    for (const [id, p] of this.players) {
      const vis = p.alive;
      p.group.visible = p.shadow.visible = vis; p.el.style.display = vis ? '' : 'none';
      if (!vis) continue;
      const self = id === this.selfId;
      const [x, z] = this.entityPos(p, now, self, dt);
      p.x = x; p.z = z;
      const target = radiusOf(p.mass);
      p.r = p.r === undefined ? target : p.r + (target - p.r) * (1 - Math.exp(-dt * 10));
      const pulse = 1 + Math.sin(t * 4 + id) * 0.025;
      p.group.position.set(x, p.r, z); p.group.scale.setScalar(p.r * pulse);
      p.shadow.position.set(x, 0.03, z); p.shadow.scale.setScalar(p.r * 1.15);
      p.body.material.emissiveIntensity = (p.flags & 2 ? 1.8 : 0.55);
      p.shield.visible = !!(p.flags & 16) || !!(p.flags & 4);
      p.shield.material.color.set(p.flags & 4 ? 0xffd23d : 0x99ffff);
      p.group.rotation.y += dt;
      if (p.flags & 64 && Math.random() < dt * 20) this.burst(x + (Math.random() - 0.5) * 14, 0.5, z + (Math.random() - 0.5) * 14, 0xb44dff, 1, 0.2, 0.5, 0.5);
      // trail
      p.trail -= dt;
      const sp = Math.hypot(p.vx, p.vz);
      if (p.trail <= 0 && sp > 2) {
        p.trail = p.flags & 2 ? 0.01 : p.flags & 32 ? 0.015 : 0.05;
        this.burst(x - (p.vx / sp) * p.r, p.r * 0.5, z - (p.vz / sp) * p.r, p.flags & 32 ? 0xb6ff3d : p.color.getHex(), p.flags & 2 ? 3 : p.flags & 32 ? 2 : 1, 0.6, p.r * 0.45, 0.5);
      }
      if (self) me = p;
      // label
      const v = new THREE.Vector3(x, p.r * 2 + 0.6, z).project(this.camera);
      p.el.style.transform = `translate(${(v.x * 0.5 + 0.5) * innerWidth}px,${(-v.y * 0.5 + 0.5) * innerHeight}px) translate(-50%,-100%)`;
      p.el.style.fontSize = Math.max(11, Math.min(18, 10 + p.r * 0.9)) + 'px';
    }

    // camera follows self
    if (me) { this.camTarget.lerp(new THREE.Vector3(me.x, 0, me.z), 1 - Math.exp(-dt * 6)); this.camZoom += ((1 + Math.sqrt(me.mass) * 0.06) - this.camZoom) * (1 - Math.exp(-dt * 2)); }
    const h = 30 * this.camZoom, back = 18 * this.camZoom;
    this.shake *= Math.exp(-dt * 6);
    camP.set(this.camTarget.x + (Math.random() - 0.5) * this.shake, h, this.camTarget.z + back + (Math.random() - 0.5) * this.shake);
    this.camera.lookAt(this.camTarget.x, 0, this.camTarget.z);
    this.composer.render();
    return me;
  }

  groundPoint(clientX, clientY) {
    const ndc = new THREE.Vector2((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
    const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit) ? hit : null;
  }
}

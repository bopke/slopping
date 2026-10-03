import { Accounts } from './db.js';
import { config } from './config.js';

const BOT_NAMES = ['Zorp', 'Blinky', 'Nova', 'Quasar', 'Pixel', 'Muffin', 'Glitch', 'Orbit', 'Wobble', 'Sprocket', 'Comet', 'Bleep'];
const START_MASS = 10;
const MAX_MASS = 500;

export const DEFAULT_SETTINGS = {
  arenaRadius: 70,
  maxShards: 160,
  speed: 13,
  dashPower: 38,
  dashCooldown: 2.5,
  pulseCooldown: 5,
  absorbRatio: 1.15,
  pvp: true,
  voidEnabled: true,
  voidInterval: 75,
  minPlayers: 6, // bots fill the arena up to this many players
  massDecay: 0.015,
  shardRate: 1, // shard spawn speed multiplier
  powerupMax: 4,
  rushInterval: 150, // seconds between Golden Rush events (0 = off)
};

const PU_TYPES = ['speed', 'shield', 'magnet'];
const PU_TIME = { speed: 8, shield: 6, magnet: 12 };
const rnd = (a, b) => a + Math.random() * (b - a);
const radiusOf = (m) => 0.4 + 0.35 * Math.sqrt(m);
const safe = (p) => p.prot > 0 || p.fx.shield > 0;
const r2 = (n) => Math.round(n * 100) / 100;

export class Game {
  constructor() {
    this.players = new Map(); // id -> player
    this.byKey = new Map(); // nickname key -> human player
    this.shards = new Map();
    this.powerups = new Map();
    this.nextPu = 1; this.puAdds = []; this.puRems = [];
    this.rush = { t: 0, next: 150 }; this.puTimer = 3;
    this.settings = { ...DEFAULT_SETTINGS };
    this.nextId = 1;
    this.nextShard = 1;
    this.tickNo = 0;
    this.shardAdds = [];
    this.shardRems = [];
    this.events = [];
    this.voidRadius = this.settings.arenaRadius;
    this.void = { phase: 'idle', t: 0, next: this.settings.voidInterval };
    this.startedAt = Date.now();
    this.lbTimer = 0;
    this.botTimer = 0;
  }

  // ---------- lifecycle ----------
  hue(name) {
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
    return h;
  }

  addPlayer({ name, ws, admin, ip, bot = false, hue = null }) {
    const p = {
      id: this.nextId++, name, ws, ip, bot, admin: !!admin,
      hue: hue ?? this.hue(name), fx: { speed: 0, shield: 0, magnet: 0 }, x: 0, z: 0, vx: 0, vz: 0, mass: START_MASS, score: 0,
      alive: false, ix: 0, iz: 0, dashT: 0, dashCd: 0, pulseCd: 0, prot: 0,
      respawnAt: 0, god: false, frozen: false, muted: false,
      kills: 0, peak: START_MASS, dashHits: new Set(), ai: { tx: 0, tz: 0, t: 0 },
      lastChat: 0, joinedAt: Date.now(), ping: 0,
    };
    this.players.set(p.id, p);
    if (!bot) this.byKey.set(name.toLowerCase(), p);
    this.spawn(p);
    this.broadcast({ t: 'join', p: this.meta(p) });
    return p;
  }

  meta(p) {
    return { id: p.id, name: p.name, hue: p.hue, bot: p.bot, admin: p.admin };
  }

  removePlayer(p, reason) {
    if (!this.players.delete(p.id)) return;
    if (!p.bot) {
      this.byKey.delete(p.name.toLowerCase());
      this.persist(p, 0);
    }
    if (p.alive) this.dropShards(p.x, p.z, p.mass * 0.5);
    this.broadcast({ t: 'leave', id: p.id });
    if (!p.bot) this.system(`${p.name} ${reason || 'left the arena'}`);
  }

  persist(p, deaths) {
    if (p.bot) return;
    try { Accounts.addStats(p.name, p.peak, p.kills, deaths); } catch {}
    p.kills = 0; p.peak = p.mass;
  }

  spawn(p) {
    const a = Math.random() * Math.PI * 2;
    const d = Math.sqrt(Math.random()) * this.voidRadius * 0.75;
    p.x = Math.cos(a) * d; p.z = Math.sin(a) * d;
    p.vx = p.vz = 0;
    p.mass = START_MASS; p.score = 0; p.alive = true; p.prot = 2.5; p.dashT = 0;
    p.fx.speed = p.fx.shield = p.fx.magnet = 0; p.dashCd = 0; p.pulseCd = 0; p.peak = Math.max(p.peak, START_MASS);
    this.events.push({ k: 'spawn', id: p.id, x: r2(p.x), z: r2(p.z) });
  }

  kill(victim, killer, how = 'eaten') {
    if (!victim.alive) return;
    victim.alive = false;
    victim.respawnAt = Date.now() + 2500;
    this.dropShards(victim.x, victim.z, victim.mass * 0.6);
    this.events.push({ k: 'death', id: victim.id, x: r2(victim.x), z: r2(victim.z), hue: victim.hue, r: r2(radiusOf(victim.mass)) });
    this.persist(victim, 1);
    if (killer && killer !== victim) {
      killer.kills++;
      this.broadcast({ t: 'kill', killer: killer.name, victim: victim.name, how });
    } else {
      this.broadcast({ t: 'kill', killer: null, victim: victim.name, how });
    }
  }

  // ---------- shards ----------
  addShard(x, z, kind = null) {
    const id = this.nextShard++;
    const k = kind ?? (Math.random() < 0.06 ? 1 : 0);
    const s = { id, x, z, k };
    this.shards.set(id, s);
    this.shardAdds.push([id, r2(x), r2(z), k]);
    return s;
  }

  removeShard(id) {
    if (this.shards.delete(id)) this.shardRems.push(id);
  }

  randomPoint(rad = this.voidRadius * 0.95) {
    const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * rad;
    return [Math.cos(a) * d, Math.sin(a) * d];
  }

  dropShards(x, z, mass) {
    const n = Math.min(24, Math.max(2, Math.floor(mass / 3)));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.283, d = Math.random() * 3;
      this.addShard(x + Math.cos(a) * d, z + Math.sin(a) * d, i % 6 === 0 ? 1 : 0);
    }
  }

  // ---------- input ----------
  handle(p, msg) {
    switch (msg.t) {
      case 'input': {
        let x = +msg.x || 0, z = +msg.z || 0;
        const l = Math.hypot(x, z);
        if (l > 1) { x /= l; z /= l; }
        p.ix = x; p.iz = z;
        break;
      }
      case 'dash': return this.dash(p);
      case 'pulse': return this.pulse(p);
      case 'chat': return this.chat(p, msg.text);
      case 'hue': {
        const h = Math.round(+msg.hue);
        if (!(h >= 0 && h < 360) || p.bot) return;
        p.hue = h; Accounts.setHue(p.name, h);
        this.broadcast({ t: 'meta', p: this.meta(p) });
        break;
      }
      case 'ping': p.ws?.send(JSON.stringify({ t: 'pong', c: msg.c })); break;
    }
  }

  dash(p) {
    if (!p.alive || p.frozen || p.dashCd > 0) return;
    let dx = p.ix, dz = p.iz;
    if (!dx && !dz) { const l = Math.hypot(p.vx, p.vz) || 1; dx = p.vx / l; dz = p.vz / l; }
    if (!dx && !dz) return;
    p.vx += dx * this.settings.dashPower; p.vz += dz * this.settings.dashPower;
    p.dashT = 0.3; p.dashCd = this.settings.dashCooldown; p.dashHits.clear();
    this.events.push({ k: 'dash', id: p.id });
  }

  pulse(p) {
    if (!p.alive || p.frozen || p.pulseCd > 0 || p.mass < 12) return;
    p.pulseCd = this.settings.pulseCooldown;
    p.mass -= p.mass * 0.03;
    const R = 14 + radiusOf(p.mass);
    for (const o of this.players.values()) {
      if (o === p || !o.alive || safe(o) || !this.settings.pvp) continue;
      const dx = o.x - p.x, dz = o.z - p.z, d = Math.hypot(dx, dz) || 0.01;
      if (d < R) {
        const f = (1 - d / R) * 55 * Math.min(2, Math.sqrt(START_MASS / o.mass) * 1.5);
        o.vx += (dx / d) * f; o.vz += (dz / d) * f;
      }
    }
    this.events.push({ k: 'pulse', id: p.id, x: r2(p.x), z: r2(p.z), r: R });
  }

  chat(p, text) {
    if (typeof text !== 'string') return;
    text = text.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 140);
    if (!text) return;
    const now = Date.now();
    if (p.muted) return this.tell(p, 'You are muted.');
    if (now - p.lastChat < 700) return;
    p.lastChat = now;
    this.broadcast({ t: 'chat', id: p.id, name: p.name, admin: p.admin, text });
  }

  // ---------- messaging ----------
  tell(p, text) { this.send(p, { t: 'sys', text }); }
  system(text) { this.broadcast({ t: 'sys', text }); }
  send(p, obj) { if (!p.bot && p.ws?.readyState === 1) p.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); }
  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const p of this.players.values()) this.send(p, s);
  }

  // ---------- simulation ----------
  tick(dt) {
    this.tickNo++;
    const S = this.settings;
    this.updateVoid(dt);
    const now = Date.now();
    const humans = [...this.players.values()].filter((p) => !p.bot).length;

    // bots fill up the arena
    this.botTimer -= dt;
    if (this.botTimer <= 0) {
      this.botTimer = 1;
      const bots = [...this.players.values()].filter((p) => p.bot);
      const want = Math.max(0, S.minPlayers - humans);
      if (bots.length < want) {
        const used = new Set([...this.players.values()].map((p) => p.name));
        const name = BOT_NAMES.find((n) => !used.has(n)) || `Bot${this.nextId}`;
        this.addPlayer({ name, bot: true });
      } else if (bots.length > want) this.removePlayer(bots[0]);
    }

    // shards
    const deficit = S.maxShards - this.shards.size;
    if (deficit > 0) {
      const n = Math.min(deficit, Math.ceil(dt * 6 * S.shardRate + Math.random()));
      for (let i = 0; i < n; i++) { const [x, z] = this.randomPoint(); this.addShard(x, z); }
    }

    this.updatePowerups(dt);
    this.updateRush(dt);

    const list = [...this.players.values()];
    for (const p of list) {
      if (!p.alive) {
        if (now >= p.respawnAt && (p.bot || p.ws)) this.spawn(p);
        continue;
      }
      if (p.bot) this.think(p, dt, list);
      this.move(p, dt);
    }
    this.collide(list);

    // pickups
    for (const p of list) {
      if (!p.alive) continue;
      const r = radiusOf(p.mass) + 0.7 + (p.fx.magnet > 0 ? 9 : 0);
      for (const s of this.shards.values()) {
        const dx = s.x - p.x, dz = s.z - p.z;
        if (dx * dx + dz * dz < r * r) {
          const gain = s.k ? 5 : 1;
          p.mass = Math.min(MAX_MASS, p.mass + gain);
          p.score += gain * 10;
          this.removeShard(s.id);
          this.events.push({ k: 'pick', id: p.id, sk: s.k });
        }
      }
      for (const u of this.powerups.values()) {
        const dx = u.x - p.x, dz = u.z - p.z, rr = radiusOf(p.mass) + 1.2;
        if (dx * dx + dz * dz < rr * rr) {
          this.giveFx(p, u.type);
          this.removePowerup(u.id);
          this.events.push({ k: 'pu', id: p.id, type: u.type });
        }
      }
      if (p.mass > p.peak) p.peak = p.mass;
    }

    this.broadcastSnapshot(dt);
  }

  giveFx(p, type) {
    p.fx[type] = PU_TIME[type];
    if (!p.bot) this.tell(p, `${type.toUpperCase()} activated (${PU_TIME[type]}s)`);
  }

  addPowerup(x, z, type = PU_TYPES[Math.floor(Math.random() * PU_TYPES.length)]) {
    const u = { id: this.nextPu++, x, z, type };
    this.powerups.set(u.id, u);
    this.puAdds.push([u.id, r2(x), r2(z), type]);
    return u;
  }
  removePowerup(id) { if (this.powerups.delete(id)) this.puRems.push(id); }

  updatePowerups(dt) {
    this.puTimer -= dt;
    if (this.puTimer <= 0) {
      this.puTimer = 6 + Math.random() * 6;
      if (this.powerups.size < this.settings.powerupMax) { const [x, z] = this.randomPoint(this.voidRadius * 0.8); this.addPowerup(x, z); }
    }
  }

  startRush(secs = 20) {
    this.rush.t = secs;
    this.broadcast({ t: 'announce', text: '✨ GOLDEN RUSH — gold shards are raining!' });
  }
  updateRush(dt) {
    const S = this.settings, R = this.rush;
    if (R.t > 0) {
      R.t -= dt;
      if (this.shards.size < S.maxShards + 250) {
        const n = Math.ceil(dt * 14 + Math.random());
        for (let i = 0; i < n; i++) { const [x, z] = this.randomPoint(this.voidRadius * 0.95); this.addShard(x, z, 1); }
      }
      if (R.t <= 0) { R.next = S.rushInterval; this.system('Golden Rush is over.'); }
    } else if (S.rushInterval > 0) {
      R.next -= dt;
      if (R.next <= 0) this.startRush();
    }
  }

  move(p, dt) {
    const S = this.settings;
    if (p.prot > 0) p.prot -= dt;
    if (p.dashCd > 0) p.dashCd -= dt;
    if (p.pulseCd > 0) p.pulseCd -= dt;
    if (p.dashT > 0) p.dashT -= dt;
    for (const k in p.fx) if (p.fx[k] > 0) p.fx[k] -= dt;
    const slow = Math.pow(p.mass / START_MASS, -0.12);
    const sp = p.frozen ? 0 : S.speed * slow * (p.fx.speed > 0 ? 1.6 : 1);
    const tx = p.ix * sp, tz = p.iz * sp;
    const k = Math.exp(-5 * dt);
    p.vx = tx + (p.vx - tx) * k; p.vz = tz + (p.vz - tz) * k;
    p.x += p.vx * dt; p.z += p.vz * dt;

    // mass decay towards starting mass
    if (p.mass > START_MASS) p.mass -= (p.mass - START_MASS) * S.massDecay * (1 + (p.mass - START_MASS) / 50) * dt;

    // arena wall
    const r = radiusOf(p.mass), R = S.arenaRadius;
    const d = Math.hypot(p.x, p.z);
    if (d > R - r) {
      const nx = p.x / d, nz = p.z / d;
      p.x = nx * (R - r); p.z = nz * (R - r);
      const vn = p.vx * nx + p.vz * nz;
      if (vn > 0) { p.vx -= 1.6 * vn * nx; p.vz -= 1.6 * vn * nz; }
    }
    // void damage
    if (this.voidRadius < R && d > this.voidRadius && !p.god && !safe(p)) {
      p.mass -= (3 + p.mass * 0.12) * dt;
      if (p.mass < 4) this.kill(p, null, 'void');
    }
  }

  collide(list) {
    const S = this.settings;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!b.alive) continue;
        const ra = radiusOf(a.mass), rb = radiusOf(b.mass);
        const dx = b.x - a.x, dz = b.z - a.z;
        const d = Math.hypot(dx, dz);
        if (d >= ra + rb) continue;
        if (!S.pvp || safe(a) || safe(b)) { this.separate(a, b, dx, dz, d, ra, rb, 0.5); continue; }
        const [big, small] = a.mass >= b.mass ? [a, b] : [b, a];
        const rbig = big === a ? ra : rb, rsmall = big === a ? rb : ra;
        if (big.mass >= small.mass * S.absorbRatio && d < rbig - rsmall * 0.25 && !small.god) {
          big.mass = Math.min(MAX_MASS, big.mass + small.mass * 0.6);
          big.score += Math.round(small.mass * 10);
          this.kill(small, big);
          continue;
        }
        // dash bump
        for (const [x, y] of [[a, b], [b, a]]) {
          if (x.dashT > 0 && !x.dashHits.has(y.id)) {
            x.dashHits.add(y.id);
            const nx = (y.x - x.x) / (d || 1), nz = (y.z - x.z) / (d || 1);
            const f = 30 * Math.min(2.5, Math.sqrt(x.mass / y.mass));
            y.vx += nx * f; y.vz += nz * f;
            x.vx *= 0.4; x.vz *= 0.4;
            if (y.mass > 14 && !y.god) { y.mass -= y.mass * 0.03; this.dropShards(y.x, y.z, 6); }
            this.events.push({ k: 'bump', x: r2(y.x), z: r2(y.z) });
          }
        }
        this.separate(a, b, dx, dz, d, ra, rb, 0.5);
      }
    }
  }

  separate(a, b, dx, dz, d, ra, rb, strength) {
    const nx = d > 0.001 ? dx / d : 1, nz = d > 0.001 ? dz / d : 0;
    const overlap = (ra + rb - d) * strength;
    const wa = b.mass / (a.mass + b.mass), wb = 1 - wa;
    a.x -= nx * overlap * wa; a.z -= nz * overlap * wa;
    b.x += nx * overlap * wb; b.z += nz * overlap * wb;
  }

  updateVoid(dt) {
    const S = this.settings, v = this.void;
    if (!S.voidEnabled && v.phase === 'idle') { this.voidRadius = S.arenaRadius; return; }
    const min = S.arenaRadius * 0.38;
    v.t += dt;
    switch (v.phase) {
      case 'idle':
        this.voidRadius = S.arenaRadius;
        if (v.t >= v.next) this.startVoid();
        break;
      case 'warn':
        if (v.t >= 4) { v.phase = 'shrink'; v.t = 0; }
        break;
      case 'shrink':
        this.voidRadius = S.arenaRadius - (S.arenaRadius - min) * Math.min(1, v.t / 25);
        if (v.t >= 25) { v.phase = 'hold'; v.t = 0; }
        break;
      case 'hold':
        if (v.t >= 10) { v.phase = 'grow'; v.t = 0; }
        break;
      case 'grow':
        this.voidRadius = min + (S.arenaRadius - min) * Math.min(1, v.t / 6);
        if (v.t >= 6) { v.phase = 'idle'; v.t = 0; v.next = S.voidInterval; this.voidRadius = S.arenaRadius; }
        break;
    }
  }

  startVoid() {
    this.void.phase = 'warn'; this.void.t = 0;
    this.system('⚠ THE VOID IS RISING — get to the center!');
  }

  endVoid() { this.void.phase = 'idle'; this.void.t = 0; this.void.next = this.settings.voidInterval; this.voidRadius = this.settings.arenaRadius; }

  // ---------- bots ----------
  think(p, dt, list) {
    const ai = p.ai;
    ai.t -= dt;
    if (ai.t > 0) { p.ix = ai.ix; p.iz = ai.iz; return; }
    ai.t = 0.25 + Math.random() * 0.2;
    let ix = 0, iz = 0, best = Infinity, tx = null, tz = null;
    const r = radiusOf(p.mass);
    // danger & prey
    for (const o of list) {
      if (o === p || !o.alive) continue;
      const dx = o.x - p.x, dz = o.z - p.z, d = Math.hypot(dx, dz) || 1;
      if (o.mass > p.mass * this.settings.absorbRatio && d < 22) { ix -= (dx / d) * 2; iz -= (dz / d) * 2; }
      else if (p.mass > o.mass * this.settings.absorbRatio * 1.2 && d < 18 && d < best) { best = d; tx = o.x; tz = o.z; }
    }
    if (tx === null) {
      best = Infinity;
      for (const s of this.shards.values()) {
        const dx = s.x - p.x, dz = s.z - p.z, d = dx * dx + dz * dz - (s.k ? 200 : 0);
        if (d < best) { best = d; tx = s.x; tz = s.z; }
      }
    }
    if (tx !== null) { const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz) || 1; ix += dx / d; iz += dz / d; }
    // stay inside void
    const d0 = Math.hypot(p.x, p.z);
    if (d0 > this.voidRadius - r - 6) { ix -= (p.x / d0) * 3; iz -= (p.z / d0) * 3; }
    const l = Math.hypot(ix, iz) || 1;
    ai.ix = (ix / l) * 0.95; ai.iz = (iz / l) * 0.95;
    p.ix = ai.ix; p.iz = ai.iz;
    if (Math.random() < 0.03) this.dash(p);
  }

  // ---------- snapshots ----------
  broadcastSnapshot(dt) {
    const ps = [];
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const flags = 1 | (p.dashT > 0 ? 2 : 0) | (p.god ? 4 : 0) | (p.frozen ? 8 : 0) | (safe(p) ? 16 : 0) | (p.fx.speed > 0 ? 32 : 0) | (p.fx.magnet > 0 ? 64 : 0);
      ps.push([p.id, r2(p.x), r2(p.z), r2(p.mass), r2(p.vx), r2(p.vz), flags]);
    }
    const msg = { t: 's', n: this.tickNo, p: ps, v: r2(this.voidRadius), vp: this.void.phase };
    if (this.shardAdds.length) msg.sa = this.shardAdds;
    if (this.shardRems.length) msg.sr = this.shardRems;
    if (this.puAdds.length) msg.pa = this.puAdds;
    if (this.puRems.length) msg.pr = this.puRems;
    if (this.events.length) msg.ev = this.events;
    this.puAdds = []; this.puRems = []; this.shardAdds = []; this.shardRems = []; this.events = [];
    const s = JSON.stringify(msg);
    const doYou = this.tickNo % 4 === 0;
    for (const p of this.players.values()) {
      if (p.bot) continue;
      this.send(p, s);
      if (doYou) {
        this.send(p, {
          t: 'you', alive: p.alive, mass: r2(p.mass), score: p.score,
          dash: r2(Math.max(0, p.dashCd)), dashMax: this.settings.dashCooldown,
          pulse: r2(Math.max(0, p.pulseCd)), pulseMax: this.settings.pulseCooldown,
          fx: { speed: r2(Math.max(0, p.fx.speed)), shield: r2(Math.max(0, p.fx.shield)), magnet: r2(Math.max(0, p.fx.magnet)) }, rush: r2(Math.max(0, this.rush.t)),
        });
      }
    }
    this.lbTimer += dt;
    if (this.lbTimer >= 1) {
      this.lbTimer = 0;
      const lb = [...this.players.values()].filter((p) => p.alive)
        .sort((a, b) => b.mass - a.mass).slice(0, 8)
        .map((p) => [p.id, p.name, Math.round(p.mass)]);
      this.broadcast({ t: 'lb', lb, online: this.players.size });
    }
  }

  welcome(p) {
    return {
      t: 'welcome', id: p.id, name: p.name, admin: p.admin,
      settings: this.settings, tickRate: config.tickRate,
      players: [...this.players.values()].map((o) => this.meta(o)),
      shards: [...this.shards.values()].map((s) => [s.id, r2(s.x), r2(s.z), s.k]),
      powerups: [...this.powerups.values()].map((u) => [u.id, r2(u.x), r2(u.z), u.type]),
      hue: p.hue,
      hall: Accounts.top(),
    };
  }
}

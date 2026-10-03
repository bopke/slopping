// Deterministic game-rule tests that run the simulation directly (no sockets).
process.env.DB_PATH = './data/unit.db';
import assert from 'node:assert/strict';
const { Game } = await import('../src/game.js');
const g = new Game();
g.settings.minPlayers = 0; g.settings.obstacles = false; g.settings.voidEnabled = false; g.settings.rushInterval = 0;
g.botTimer = 1e9;
const mk = (name) => { const p = g.addPlayer({ name, bot: true }); p.ai.t = 1e9; p.ai.ix = p.ai.iz = 0; return p; };
const a = mk('A'), b = mk('B');
const place = (p, x, z, mass) => Object.assign(p, { x, z, mass, vx: 0, vz: 0, ix: 0, iz: 0, prot: 0, alive: true });

// 1. bigger orb eats smaller on overlap
g.obstacles = []; place(a, 20, 20, 60); place(b, 20, 20.5, 10);
g.tick(0.05);
assert.equal(b.alive, false, 'small orb eaten');
assert.ok(a.mass > 60, 'eater grows');

// 2. leader + bounty
place(a, -30, 0, 100); b.alive = true; place(b, 30, 0, 45);
g.tick(0.05);
assert.equal(g.leader, a, 'biggest orb >= 60 is crowned');
const before = b.mass;
place(a, -30, 0, 100); place(b, -30, 0.2, 400); // b becomes bigger and eats the leader
g.tick(0.05);
assert.equal(a.alive, false);
assert.ok(b.mass > 400 * 0.99, 'killer paid bounty');

// 3. shield prevents being eaten
place(a, 0, 40, 10); place(b, 0, 40.2, 100); a.fx.shield = 5;
g.tick(0.05);
assert.equal(a.alive, true, 'shielded orb survives');

// 4. obstacles repel
g.obstacles = [{ id: 1, x: 0, z: 0, r: 5 }];
place(a, 0, 0, 10); place(b, 60, 0, 10); a.vx = 5;
g.tick(0.05);
assert.ok(Math.hypot(a.x, a.z) >= 5 + 0.4 + 0.35 * Math.sqrt(10) - 0.01, 'pushed out of the pillar');

// 5. void drains orbs outside the radius
g.obstacles = [];
g.void.phase = 'hold'; g.voidRadius = 20;
place(b, -30, -30, 10); place(a, 60, 0, 30); a.prot = 0; a.fx.shield = 0; const m0 = a.mass;
g.settings.voidEnabled = true; g.void.t = 0;
g.tick(0.05);
assert.ok(a.mass < m0, 'void damage applied');
// 6. meteor impact hurts orbs in its radius but not shielded ones
a.fx.shield = 0; place(a, 10, 10, 50); place(b, 10, 11, 50); b.fx.shield = 5;
g.impact({ x: 10, z: 10, r: 8 });
assert.ok(a.mass < 50, 'meteor damages');
assert.equal(b.mass, 50, 'shield blocks meteor');
console.log('UNIT TESTS PASSED');
process.exit(0);

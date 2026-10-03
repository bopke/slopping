import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { Accounts, NAME_RE, keyOf, seedAdmin, isAdminRow } from './db.js';
import { Game } from './game.js';
import { adminState, runAdmin } from './admin.js';

seedAdmin();
const game = new Game();
const startedAt = Date.now();

const http = createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (req.url === '/health') {
    res.writeHead(200, cors);
    return res.end(JSON.stringify({ ok: true, players: game.players.size, uptime: Math.round((Date.now() - startedAt) / 1000) }));
  }
  res.writeHead(404, cors);
  res.end('{"error":"not found"}');
});

const wss = new WebSocketServer({
  server: http,
  maxPayload: 2048,
  verifyClient: ({ origin }) =>
    config.allowedOrigins.includes('*') || (origin && config.allowedOrigins.includes(origin)),
});

// ---- brute-force protection ----
const failsByIp = new Map();
const failsByName = new Map();
const locked = (m, k) => (m.get(k)?.until ?? 0) > Date.now();
function fail(m, k, max, lockMs) {
  const e = m.get(k) || { n: 0, until: 0 };
  if (++e.n >= max) { e.until = Date.now() + lockMs; e.n = 0; }
  m.set(k, e);
}
setInterval(() => {
  const now = Date.now();
  for (const m of [failsByIp, failsByName]) for (const [k, v] of m) if (v.until < now && v.n === 0) m.delete(k);
}, 60000).unref();

const hooks = {
  kick(p, reason) {
    game.send(p, { t: 'kicked', reason });
    const ws = p.ws;
    game.removePlayer(p, 'was kicked');
    setTimeout(() => ws?.close(4000, 'kicked'), 50);
  },
  isAdminKey: (key) => config.adminNicks.includes(key),
};

const ipOf = (req) =>
  (config.trustProxy && req.headers['x-forwarded-for']?.split(',')[0].trim()) ||
  req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?';

wss.on('connection', (ws, req) => {
  const ip = ipOf(req);
  let player = null;
  let tokens = 60, last = Date.now();
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  const authErr = (error) => send({ t: 'auth_error', error });

  ws.on('error', () => {});
  ws.on('message', (raw) => {
    const now = Date.now();
    tokens = Math.min(80, tokens + ((now - last) / 1000) * 40); last = now;
    if (--tokens < 0) return;
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;

    if (!player) {
      if (msg.t === 'check') {
        const name = String(msg.name ?? '');
        if (!NAME_RE.test(name)) return send({ t: 'check', name, valid: false });
        return send({ t: 'check', name, valid: true, exists: Accounts.exists(name) });
      }
      if (msg.t === 'hall') return send({ t: 'hall', hall: Accounts.top().slice(0, 5) });
      if (msg.t === 'login' || msg.t === 'register') return authenticate(msg);
      return;
    }
    if (!game.players.has(player.id)) return;

    if (msg.t === 'admin') {
      if (!player.admin) return;
      if (msg.cmd === 'state') return send(adminState(game, startedAt));
      return runAdmin(game, player, msg, hooks);
    }
    game.handle(player, msg);
  });

  function authenticate(msg) {
    const name = String(msg.name ?? ''), password = String(msg.password ?? '');
    if (!NAME_RE.test(name)) return authErr('Nickname must be 2-16 characters: letters, digits, _ or -');
    if (password.length < 4 || password.length > 72) return authErr('Password must be 4-72 characters');
    if (locked(failsByIp, ip) || locked(failsByName, keyOf(name))) return authErr('Too many attempts, wait a bit and retry');

    let row = Accounts.get(name);
    if (msg.t === 'register') {
      if (row) return authErr('That nickname was just taken, please log in');
      row = Accounts.create(name, password, config.adminNicks.includes(keyOf(name)));
    } else {
      if (!row) return authErr('Unknown nickname');
      if (!Accounts.verify(row, password)) {
        fail(failsByIp, ip, 10, 60000); fail(failsByName, keyOf(name), 5, 30000);
        return authErr('Wrong password');
      }
    }
    if (row.banned) return authErr(`Banned: ${row.banned}`);
    Accounts.touch(row.name);

    const existing = game.byKey.get(row.key);
    if (existing) hooks.kick(existing, 'Logged in from another place');

    player = game.addPlayer({ name: row.name, ws, ip, admin: isAdminRow(row), hue: row.hue });
    player.muted = !!row.muted;
    send(game.welcome(player));
    game.system(`${player.name} joined the arena`);
  }

  ws.on('close', () => { if (player) game.removePlayer(player); });
});

setInterval(() => {
  let st = null;
  for (const p of game.players.values()) {
    if (p.admin && !p.bot && p.ws?.readyState === 1) p.ws.send(JSON.stringify((st ??= adminState(game, startedAt))));
  }
}, 1000).unref();

let prev = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - prev) / 1000);
  prev = now;
  try { game.tick(dt); } catch (e) { console.error('tick error', e); }
}, 1000 / config.tickRate);

http.listen(config.port, () => console.log(`[shardfall] listening on :${config.port}`));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { console.log('bye'); process.exit(0); });

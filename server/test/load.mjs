// Load test: N fake players roam the arena; prints server tick cost and bandwidth.
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { rmSync } from 'node:fs';
const N = +process.argv[2] || 40, SECS = +process.argv[3] || 12, PORT = 18081, DB = './data/load.db';
for (const f of ['', '-wal', '-shm']) rmSync(DB + f, { force: true });
const srv = spawn('node', ['src/index.js'], { env: { ...process.env, PORT, DB_PATH: DB, ADMIN_PASSWORD: 'adminpw' }, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(800);
let bytes = 0, stats = null;
const mk = (name, pw, admin) => new Promise((res) => {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  ws.on('message', (d) => {
    bytes += d.length; const m = JSON.parse(d);
    if (m.t === 'auth_error') ws.send(JSON.stringify({ t: 'login', name, password: pw }));
    if (m.t === 'admin_state') stats = m.stats;
    if (m.t === 'welcome') res(ws);
  });
  ws.on('open', () => ws.send(JSON.stringify({ t: 'register', name, password: pw })));
});
const socks = [];
for (let i = 0; i < N; i++) socks.push(await mk('load' + i, 'password', false));
const admin = await mk('bopke', 'adminpw', true);
const iv = setInterval(() => socks.forEach((ws) => {
  const a = Math.random() * 6.28;
  ws.send(JSON.stringify({ t: 'input', x: Math.cos(a), z: Math.sin(a) }));
  if (Math.random() < 0.05) ws.send(JSON.stringify({ t: 'dash' }));
}), 250);
await sleep(SECS * 1000);
clearInterval(iv);
console.log(`players=${N} tickMs(avg)=${stats?.tickMs} shards=${stats?.shards} bandwidth=${(bytes / SECS / 1024 / (N + 1)).toFixed(1)} KB/s per client`);
srv.kill(); process.exit(0);

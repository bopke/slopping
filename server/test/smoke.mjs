// End-to-end smoke test: boots the server on a temp DB and drives it via WebSocket.
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const PORT = 18080, DB = './data/test.db';
for (const f of ['', '-wal', '-shm']) rmSync(DB + f, { force: true });
const srv = spawn('node', ['src/index.js'], { env: { ...process.env, PORT, DB_PATH: DB, ADMIN_NICK: 'bopke' }, stdio: 'inherit' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(800);

function client() {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const c = { ws, msgs: [], send: (o) => ws.send(JSON.stringify(o)) };
  ws.on('message', (d) => c.msgs.push(JSON.parse(d)));
  c.wait = async (pred, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const m = c.msgs.find(pred); if (m) return m; await sleep(25); }
    throw new Error('timeout waiting for message');
  };
  return new Promise((res) => ws.on('open', () => res(c)));
}

try {
  const a = await client();
  a.send({ t: 'check', name: 'alice' });
  assert.equal((await a.wait((m) => m.t === 'check')).exists, false);
  a.send({ t: 'register', name: 'alice', password: 'secret1' });
  const w = await a.wait((m) => m.t === 'welcome');
  assert.equal(w.admin, false);

  // second connection: nickname known -> wrong pw rejected, right pw kicks the old session
  const a2 = await client();
  a2.send({ t: 'check', name: 'ALICE' });
  assert.equal((await a2.wait((m) => m.t === 'check')).exists, true);
  a2.send({ t: 'login', name: 'alice', password: 'nope' });
  await a2.wait((m) => m.t === 'auth_error');
  a2.send({ t: 'login', name: 'alice', password: 'secret1' });
  await a2.wait((m) => m.t === 'welcome');
  await a.wait((m) => m.t === 'kicked');

  // gameplay: movement shows up in snapshots
  a2.send({ t: 'input', x: 1, z: 0 });
  await sleep(600);
  const snap = [...a2.msgs].reverse().find((m) => m.t === 's');
  assert.ok(snap.p.length >= 2, 'bots + player present');

  // non-admin can't use admin commands
  a2.send({ t: 'admin', cmd: 'clearshards' });
  await sleep(200);
  assert.ok(!a2.msgs.some((m) => m.t === 'admin_result'));

  // admin
  const b = await client();
  b.send({ t: 'register', name: 'Bopke', password: 'adminpw' });
  assert.equal((await b.wait((m) => m.t === 'welcome')).admin, true);
  b.send({ t: 'admin', cmd: 'setmass', target: 'alice', value: 100 });
  assert.equal((await b.wait((m) => m.t === 'admin_result')).ok, true);
  b.send({ t: 'admin', cmd: 'broadcast', text: 'hello' });
  await a2.wait((m) => m.t === 'announce');
  b.send({ t: 'admin', cmd: 'ban', target: 'alice', reason: 'test' });
  await a2.wait((m) => m.t === 'kicked');
  const a3 = await client();
  a3.send({ t: 'login', name: 'alice', password: 'secret1' });
  assert.match((await a3.wait((m) => m.t === 'auth_error')).error, /Banned/);
  console.log('SMOKE TEST PASSED');
} catch (e) {
  console.error('FAILED', e);
  process.exitCode = 1;
} finally {
  srv.kill();
}

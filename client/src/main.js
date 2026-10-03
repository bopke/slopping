import './style.css';
import { Net } from './net.js';
import { World } from './world.js';
import { AdminPanel } from './admin.js';
import { sfx } from './audio.js';

const $ = (s) => document.querySelector(s);
const net = new Net();
const world = new World($('#scene'));
let admin = null, me = null, settings = null, arena = 70, you = { mass: 10, dash: 0, dashMax: 1, pulse: 0, pulseMax: 1, alive: true };
let voidPhase = 'idle';
const names = new Map();

// ---------------- login flow ----------------
const nick = $('#nick'), pw = $('#pw'), err = $('#authErr');
nick.value = localStorage.getItem('nick') || '';
let exists = false, pending = false;
const setErr = (t) => (err.textContent = t || '');

net.on('hall', (m) => {
  const h = $('#hall'); h.textContent = '';
  if (!m.hall.length) return;
  const t = document.createElement('div'); t.className = 'hallT'; t.textContent = 'HALL OF FAME'; h.appendChild(t);
  m.hall.forEach((e, i) => { const d = document.createElement('div'); d.textContent = `${i + 1}. ${e.name} — ${Math.round(e.best_mass)} mass, ${e.kills} kills`; h.appendChild(d); });
});
net.connect().then(() => { net.send({ t: 'hall' }); $('#conn').textContent = 'connected'; setTimeout(() => ($('#conn').textContent = ''), 1200); })
  .catch(() => { $('#conn').textContent = 'Cannot reach the game server. Is it running?'; });
net.on('close', () => { if (!$('#hud').hidden) { $('#login').hidden = false; $('#hud').hidden = true; $('#step1').hidden = false; $('#step2').hidden = true; setErr('Disconnected from server — reload to reconnect'); $('#go1').disabled = true; } });

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); sfx.unlock(); setErr();
  if (pending) return;
  if (net.ws?.readyState !== 1) return setErr('Not connected to the server');
  if (!$('#step2').hidden) {
    pending = true;
    net.send({ t: exists ? 'login' : 'register', name: nick.value.trim(), password: pw.value });
    return;
  }
  const name = nick.value.trim();
  net.send({ t: 'check', name });
  const r = await net.once('check', (m) => m.name === name);
  if (!r.valid) return setErr('Nickname: 2-16 chars, letters, digits, _ or -');
  exists = r.exists;
  $('#step1').hidden = true; $('#step2').hidden = false;
  $('#pwHint').textContent = exists ? `Welcome back, ${name}! Enter your password.` : `"${name}" is free — set a password to claim it.`;
  pw.placeholder = exists ? 'your password' : 'choose a password (4+ chars)';
  $('#go2').textContent = exists ? 'Play' : 'Claim & Play';
  pw.value = ''; pw.focus();
});
$('#back').onclick = () => { $('#step2').hidden = true; $('#step1').hidden = false; setErr(); nick.focus(); };

net.on('auth_error', (m) => { pending = false; setErr(m.error); pw.select(); });
net.on('welcome', (m) => {
  pending = false;
  localStorage.setItem('nick', m.name);
  $('#login').hidden = true; $('#hud').hidden = false;
  world.selfId = m.id; settings = m.settings; arena = settings.arenaRadius; world.setArena(arena);
  names.clear(); m.players.forEach((p) => { names.set(p.id, p); world.addPlayer(p); });
  world.setShards(m.shards); world.setPowerups(m.powerups);
  buildColors(m.hue ?? names.get(m.id)?.hue);
  $('#myName').textContent = m.name;
  setAdmin(m.admin);
  addChat(null, `Welcome, ${m.name}! Grow by collecting shards. Bigger orbs devour smaller ones.`, 'sys');
  if (matchMedia('(pointer:coarse)').matches) { $('#stick').hidden = false; $('#touchBtns').hidden = false; }
});
function setAdmin(on) {
  if (on && !admin) admin = new AdminPanel(net);
  $('#adminBtn').hidden = !on;
  if (!on && admin) admin.toggle(false);
  world.isAdmin = on;
}
net.on('role', (m) => setAdmin(m.admin));
net.on('kicked', (m) => { $('#hud').hidden = true; $('#login').hidden = false; $('#step1').hidden = false; $('#step2').hidden = true; setErr(m.reason); });
net.on('settings', (m) => { settings = m.settings; arena = settings.arenaRadius; world.setArena(arena); });

// ---------------- world messages ----------------
net.on('join', (m) => { names.set(m.p.id, m.p); world.addPlayer(m.p); });
net.on('leave', (m) => { world.removePlayer(m.id); names.delete(m.id); });
net.on('s', (m) => {
  world.applySnapshot(m);
  voidPhase = m.vp;
  m.sa?.forEach((s) => world.addShard(s));
  m.sr?.forEach((id) => world.removeShard(id));
  m.pa?.forEach((u) => world.addPowerup(u));
  m.pr?.forEach((id) => world.removePowerup(id));
  m.ev?.forEach(onEvent);
});
const nearSelf = (x, z) => me && Math.hypot(x - me.x, z - me.z) < 45;
function onEvent(e) {
  const mine = e.id === world.selfId;
  switch (e.k) {
    case 'pu': if (mine) { sfx.spawn(); world.shake += 0.5; } break;
    case 'pick': if (mine) sfx.pick(e.sk); break;
    case 'dash': if (mine) sfx.dash(); break;
    case 'pulse': {
      world.burst(e.x, 1, e.z, 0xff3db8, 60, e.r * 1.3, 0.6, 0.8);
      if (nearSelf(e.x, e.z)) { sfx.pulse(); world.shake += 1.2; }
      break;
    }
    case 'death': {
      const c = world.players.get(e.id)?.color.getHex() ?? 0xffffff;
      world.burst(e.x, e.r, e.z, c, 80, 14, 0.9, 1.1);
      if (nearSelf(e.x, e.z)) { world.shake += e.r * 0.4; sfx.death(); }
      break;
    }
    case 'bump': world.burst(e.x, 1.2, e.z, 0xffffff, 14, 8, 0.4, 0.4); if (nearSelf(e.x, e.z)) { sfx.bump(); world.shake += 0.6; } break;
    case 'spawn': world.burst(e.x, 0.5, e.z, 0x35f0ff, 30, 6, 0.5, 0.8); if (mine) sfx.spawn(); break;
  }
}
net.on('meta', (m) => { names.set(m.p.id, m.p); world.setHue(m.p.id, m.p.hue); });
const FX = { speed: ['⚡ SPEED', '#b6ff3d'], shield: ['🛡 SHIELD', '#35f0ff'], magnet: ['🧲 MAGNET', '#b44dff'] };
net.on('you', (m) => {
  you = m; $('#dead').hidden = m.alive;
  $('#fx').textContent = '';
  for (const [k, v] of Object.entries(m.fx || {})) if (v > 0) {
    const d = document.createElement('div'); d.style.borderColor = FX[k][1]; d.style.color = FX[k][1]; d.textContent = `${FX[k][0]} ${v.toFixed(0)}s`; $('#fx').appendChild(d);
  }
  const rb = $('#rushBar'); rb.hidden = !(m.rush > 0); if (m.rush > 0) rb.textContent = `✨ GOLDEN RUSH ${Math.ceil(m.rush)}s`;
});
function buildColors(cur) {
  const box = $('#colors'); box.textContent = '';
  for (let h = 0; h < 360; h += 30) {
    const b = document.createElement('button'); b.style.background = `hsl(${h} 85% 55%)`;
    b.onclick = () => { net.send({ t: 'hue', hue: h }); box.hidden = true; };
    box.appendChild(b);
  }
}
$('#colorBtn').onclick = () => { $('#colors').hidden = !$('#colors').hidden; };
net.on('lb', (m) => {
  const list = $('#lbList'); list.textContent = '';
  m.lb.forEach(([id, name, mass], i) => {
    const li = document.createElement('li'); if (id === world.selfId) li.className = 'me';
    const a = document.createElement('span'), b = document.createElement('span');
    a.textContent = `${i + 1}. ${name}`; b.textContent = mass; li.append(a, b); list.appendChild(li);
  });
  const rank = m.lb.findIndex(([id]) => id === world.selfId);
  $('#myRank').textContent = rank >= 0 ? `#${rank + 1}` : '';
  $('#online').textContent = `${m.online} online`;
});
net.on('kill', (m) => {
  const d = document.createElement('div'); d.append(...(m.killer ? [Object.assign(document.createElement('b'), { textContent: m.killer }), ` devoured ${m.victim}`] : [`${m.victim} ${m.how === 'void' ? 'was swallowed by the void' : 'died'}`]));
  $('#feed').appendChild(d); setTimeout(() => d.remove(), 6000);
  while ($('#feed').children.length > 5) $('#feed').firstChild.remove();
});
function addChat(who, text, cls = '', isAdmin = false) {
  const d = document.createElement('div'); if (cls) d.className = cls;
  if (who) { const b = document.createElement('b'); if (isAdmin) b.className = 'admin'; b.textContent = who + ': '; d.append(b, text); } else d.textContent = text;
  const log = $('#chatLog'); log.appendChild(d); while (log.children.length > 8) log.firstChild.remove();
  setTimeout(() => d.remove(), 25000);
}
net.on('chat', (m) => addChat(m.name, m.text, '', m.admin));
let bannerT;
function banner(text) { const b = $('#banner'); b.textContent = text; b.classList.add('show'); clearTimeout(bannerT); bannerT = setTimeout(() => b.classList.remove('show'), 4500); }
net.on('announce', (m) => { banner(m.text); addChat(null, '📢 ' + m.text, 'sys'); });
net.on('sys', (m) => { addChat(null, m.text, 'sys'); if (m.text.includes('VOID')) { banner(m.text); sfx.warn(); } });
net.on('admin_state', (m) => admin?.onState(m));
net.on('admin_accounts', (m) => admin?.onAccounts(m.accounts));
net.on('admin_result', (m) => admin?.log(m.ok, m.msg));

// ---------------- input ----------------
const keys = new Set();
let mouseDown = false, mouseX = 0, mouseY = 0, stickVec = null, lastSent = { x: 0, z: 0, t: 0 };
const chat = $('#chatInput');
const typing = () => document.activeElement === chat || (admin?.open && document.activeElement?.tagName === 'INPUT');
addEventListener('keydown', (e) => {
  if (e.target === chat) {
    if (e.key === 'Enter') { if (chat.value.trim()) net.send({ t: 'chat', text: chat.value }); chat.value = ''; chat.blur(); }
    else if (e.key === 'Escape') chat.blur();
    return;
  }
  if (e.target.tagName === 'INPUT') return;
  if ($('#hud').hidden) return;
  const k = e.key.toLowerCase();
  if (e.key === 'Enter') { e.preventDefault(); chat.focus(); return; }
  if (k === '`' || k === '~') { admin?.toggle(); return; }
  if (k === 'm') { addChat(null, sfx.toggle() ? 'Sound off' : 'Sound on', 'sys'); return; }
  if (k === ' ') { e.preventDefault(); net.send({ t: 'dash' }); sfx.unlock(); }
  if (k === 'e') net.send({ t: 'pulse' });
  keys.add(k);
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => { keys.clear(); mouseDown = false; });
$('#scene').addEventListener('pointerdown', (e) => { sfx.unlock(); if (e.pointerType === 'touch') return; if (e.button === 2) { net.send({ t: 'pulse' }); return; } mouseDown = true; mouseX = e.clientX; mouseY = e.clientY; });
addEventListener('pointermove', (e) => { mouseX = e.clientX; mouseY = e.clientY; });
addEventListener('pointerup', () => (mouseDown = false));
$('#scene').addEventListener('contextmenu', (e) => e.preventDefault());
$('#adminBtn').onclick = () => admin?.toggle();

// touch joystick
const stick = $('#stick');
stick.addEventListener('pointerdown', (e) => { stick.setPointerCapture(e.pointerId); moveStick(e); });
stick.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') moveStick(e); });
stick.addEventListener('pointerup', () => { stickVec = null; stick.firstElementChild.style.transform = ''; });
function moveStick(e) {
  const r = stick.getBoundingClientRect(); let dx = (e.clientX - r.left - r.width / 2) / (r.width / 2), dz = (e.clientY - r.top - r.height / 2) / (r.height / 2);
  const l = Math.hypot(dx, dz); if (l > 1) { dx /= l; dz /= l; }
  stickVec = { x: dx, z: dz }; stick.firstElementChild.style.transform = `translate(${dx * 35}px,${dz * 35}px)`;
}
$('#tDash').onpointerdown = () => net.send({ t: 'dash' });
$('#tPulse').onpointerdown = () => net.send({ t: 'pulse' });

function readInput() {
  if (typing()) return { x: 0, z: 0 };
  let x = 0, z = 0;
  if (keys.has('a') || keys.has('arrowleft')) x -= 1;
  if (keys.has('d') || keys.has('arrowright')) x += 1;
  if (keys.has('w') || keys.has('arrowup')) z -= 1;
  if (keys.has('s') || keys.has('arrowdown')) z += 1;
  if (!x && !z && stickVec) return stickVec;
  if (!x && !z && mouseDown && me) {
    const g = world.groundPoint(mouseX, mouseY);
    if (g) { const dx = g.x - me.x, dz = g.z - me.z, d = Math.hypot(dx, dz); if (d > 0.8) return { x: dx / d, z: dz / d }; }
  }
  const l = Math.hypot(x, z) || 1;
  return { x: x / l, z: z / l };
}

// ---------------- main loop ----------------
const mm = $('#minimap').getContext('2d');
function drawMinimap() {
  const S = 150, c = S / 2, k = (c - 4) / arena;
  mm.clearRect(0, 0, S, S);
  mm.strokeStyle = 'rgba(53,240,255,.7)'; mm.lineWidth = 2; mm.beginPath(); mm.arc(c, c, arena * k, 0, 6.283); mm.stroke();
  if (world.voidR < arena - 0.5) { mm.strokeStyle = 'rgba(255,40,80,.9)'; mm.beginPath(); mm.arc(c, c, world.voidR * k, 0, 6.283); mm.stroke(); }
  for (const p of world.players.values()) {
    if (!p.alive) continue;
    mm.fillStyle = p === me ? '#fff' : `hsl(${p.meta.hue} 90% 60%)`;
    mm.beginPath(); mm.arc(c + p.x * k, c + p.z * k, p === me ? 4 : 2 + Math.min(4, p.r * 0.4), 0, 6.283); mm.fill();
  }
}

let last = performance.now(), sendT = 0;
function loop(nowMs) {
  const dt = Math.min(0.05, (nowMs - last) / 1000); last = nowMs;
  me = world.frame(dt, nowMs / 1000) || me;
  if (!$('#hud').hidden) {
    sendT += dt;
    const inp = readInput();
    if (sendT > 0.05 && (Math.abs(inp.x - lastSent.x) > 0.02 || Math.abs(inp.z - lastSent.z) > 0.02 || sendT > 0.5)) {
      net.send({ t: 'input', x: +inp.x.toFixed(3), z: +inp.z.toFixed(3) }); lastSent = inp; sendT = 0;
    }
    $('#myMass').textContent = Math.round(you.mass);
    $('#dashBar').style.width = (1 - you.dash / (you.dashMax || 1)) * 100 + '%';
    $('#pulseBar').style.width = (1 - you.pulse / (you.pulseMax || 1)) * 100 + '%';
    drawMinimap();
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// Admin panel UI. All actions are re-validated on the server; this is only a remote control.
const $ = (s, r = document) => r.querySelector(s);

export class AdminPanel {
  constructor(net) {
    this.net = net; this.el = $('#admin'); this.target = null; this.state = null; this.accounts = [];
    this.built = false;
    $('#aClose').onclick = () => this.toggle(false);
    for (const b of this.el.querySelectorAll('nav button')) b.onclick = () => this.tab(b.dataset.tab);
    for (const b of this.el.querySelectorAll('[data-cmd]')) b.onclick = () => this.targetCmd(b.dataset.cmd);
    const v = (id) => $(id).value;
    $('#aMassGo').onclick = () => this.targetCmd('setmass', { value: +v('#aMass') });
    $('#aTpGo').onclick = () => this.targetCmd('teleport', { x: +v('#aTx'), z: +v('#aTz') });
    $('#aToGo').onclick = () => this.targetCmd('teleport', { to: v('#aTo') });
    $('#aShGo').onclick = () => net.admin('spawnshards', { count: +v('#aShN'), target: this.target });
    $('#aShGold').onclick = () => net.admin('spawnshards', { count: +v('#aShN'), target: this.target, gold: true });
    $('#aVoid').onclick = () => net.admin('void', { action: 'start' });
    $('#aVoidEnd').onclick = () => net.admin('void', { action: 'end' });
    $('#aClear').onclick = () => net.admin('clearshards');
    $('#aSpawn').onclick = () => net.admin('spawnshards', { count: 50 });
    $('#aResetSet').onclick = () => net.admin('resetsettings');
    $('#aResetStats').onclick = () => confirm('Reset best mass / kills / deaths of ALL accounts?') && net.admin('resetstats');
    $('#aMsgGo').onclick = () => { net.admin('broadcast', { text: v('#aMsg') }); $('#aMsg').value = ''; };
    $('#aAccLoad').onclick = () => net.admin('accounts');
    $('#aAccQ').oninput = () => this.renderAccounts();
  }

  get open() { return !this.el.hidden; }
  toggle(on = this.el.hidden) {
    this.el.hidden = !on;
    if (on) { this.net.admin('state'); this.net.admin('accounts'); }
  }
  tab(name) {
    for (const b of this.el.querySelectorAll('nav button')) b.classList.toggle('on', b.dataset.tab === name);
    for (const s of this.el.querySelectorAll('section')) s.hidden = s.dataset.tab !== name;
  }
  targetCmd(cmd, extra = {}) {
    if (!this.target) return this.log(false, 'Select a player first');
    if (cmd === 'ban' && !confirm(`Ban ${this.target}?`)) return;
    this.net.admin(cmd, { target: this.target, ...extra });
  }
  log(ok, msg) { const l = $('#aLog'); l.textContent = msg; l.className = ok ? '' : 'bad'; }

  onState(st) {
    this.state = st;
    if (!this.open) return;
    const s = st.stats;
    $('#aStats').textContent = `${s.players} players · ${s.bots} bots · ${s.shards} shards · void:${s.void} (${s.voidRadius}) · up ${Math.floor(s.uptime / 60)}m`;
    const body = $('#aTable tbody'); body.textContent = '';
    for (const p of st.players) {
      const tr = document.createElement('tr');
      if (p.name === this.target) tr.className = 'sel';
      const flags = [p.bot && 'bot', p.admin && 'admin', !p.alive && 'dead', p.god && 'god', p.frozen && 'frozen', p.muted && 'muted'].filter(Boolean).join(' ');
      for (const c of [p.name, p.mass, p.kills, flags, p.ip]) { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); }
      tr.onclick = () => { this.target = p.name; $('#aTarget').textContent = p.name; this.onState(this.state); };
      body.appendChild(tr);
    }
    this.buildSettings(st.settings);
  }

  buildSettings(settings) {
    const box = $('#aSettings');
    if (!this.built) {
      this.built = true;
      for (const [k, val] of Object.entries(settings)) {
        const f = document.createElement('div'); f.className = 'f';
        const l = document.createElement('label'); l.textContent = k;
        const i = document.createElement('input'); i.dataset.key = k;
        if (typeof val === 'boolean') { i.type = 'checkbox'; i.style.width = 'auto'; i.onchange = () => this.net.admin('set', { key: k, value: i.checked }); }
        else { i.type = 'number'; i.step = 'any'; i.onchange = () => this.net.admin('set', { key: k, value: +i.value }); }
        f.append(l, i); box.appendChild(f);
      }
    }
    for (const i of box.querySelectorAll('input')) {
      if (document.activeElement === i) continue;
      const val = settings[i.dataset.key];
      if (i.type === 'checkbox') i.checked = !!val; else i.value = val;
    }
  }

  onAccounts(list) { this.accounts = list; this.renderAccounts(); }
  renderAccounts() {
    const q = $('#aAccQ').value.toLowerCase();
    const body = $('#aAccTable tbody'); body.textContent = '';
    for (const a of this.accounts.filter((a) => a.name.toLowerCase().includes(q))) {
      const tr = document.createElement('tr'); tr.style.cursor = 'default';
      const flags = [a.is_admin && 'admin', a.banned && `banned(${a.banned})`, a.muted && 'muted'].filter(Boolean).join(' ');
      for (const c of [a.name, Math.round(a.best_mass), `${a.kills}/${a.deaths}`, flags]) { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); }
      const td = document.createElement('td');
      const btn = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.onclick = () => { fn(); setTimeout(() => this.net.admin('accounts'), 250); }; td.appendChild(b); td.append(' '); };
      const t = a.name;
      btn(a.banned ? 'Unban' : 'Ban', () => this.net.admin(a.banned ? 'unban' : 'ban', { target: t, reason: a.banned ? '' : prompt('Ban reason?', 'Banned') || 'Banned' }));
      btn(a.muted ? 'Unmute' : 'Mute', () => this.net.admin(a.muted ? 'unmute' : 'mute', { target: t }));
      btn(a.is_admin ? 'Demote' : 'Promote', () => this.net.admin(a.is_admin ? 'demote' : 'promote', { target: t }));
      btn('Reset PW', () => { const pw = prompt(`New password for ${t}?`); if (pw) this.net.admin('resetpw', { target: t, password: pw }); });
      btn('Delete', () => confirm(`Delete account ${t}?`) && this.net.admin('deleteaccount', { target: t }));
      tr.appendChild(td); body.appendChild(tr);
    }
  }
}

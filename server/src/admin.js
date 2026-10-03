import { Accounts, keyOf } from './db.js';
import { DEFAULT_SETTINGS } from './game.js';

const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const SETTING_LIMITS = {
  arenaRadius: [30, 200], maxShards: [0, 600], speed: [3, 40], dashPower: [0, 120],
  dashCooldown: [0, 30], pulseCooldown: [0, 60], absorbRatio: [1.01, 5], pvp: 'bool',
  voidEnabled: 'bool', obstacles: 'bool', bounty: 'bool', powerupMax: [0, 20], meteorInterval: [0, 3600], rushInterval: [0, 3600], voidInterval: [10, 3600], minPlayers: [0, 40], massDecay: [0, 0.2], shardRate: [0, 20],
};

export function adminState(game, startedAt) {
  const players = [...game.players.values()].map((p) => ({
    id: p.id, name: p.name, bot: p.bot, admin: p.admin, alive: p.alive, mass: Math.round(p.mass),
    score: p.score, god: p.god, frozen: p.frozen, muted: p.muted, ip: p.bot ? '' : p.ip,
    x: Math.round(p.x), z: Math.round(p.z), kills: p.kills,
  }));
  return {
    t: 'admin_state', players, settings: game.settings,
    stats: {
      players: players.filter((p) => !p.bot).length, bots: players.filter((p) => p.bot).length,
      shards: game.shards.size, uptime: Math.round((Date.now() - startedAt) / 1000),
      tickMs: Math.round(game.tickMs * 100) / 100, void: game.void.phase, voidRadius: Math.round(game.voidRadius),
    },
  };
}

export function runAdmin(game, admin, msg, hooks) {
  const reply = (ok, text) => game.send(admin, { t: 'admin_result', ok, msg: text });
  const find = (n) => {
    const k = keyOf(n || '');
    for (const p of game.players.values()) if (p.name.toLowerCase() === k) return p;
    return null;
  };
  const target = () => {
    const p = find(msg.target);
    if (!p) reply(false, `No online player "${msg.target}"`);
    return p;
  };
  const account = () => {
    const a = Accounts.get(msg.target || '');
    if (!a) reply(false, `No account "${msg.target}"`);
    return a;
  };
  let p, a;

  switch (msg.cmd) {
    case 'kick':
      if (!(p = target())) return;
      if (p === admin) return reply(false, "You can't kick yourself");
      if (p.bot) game.removePlayer(p); else hooks.kick(p, msg.reason || 'Kicked by an admin');
      reply(true, `Kicked ${p.name}`); break;
    case 'ban':
      if (!(a = account())) return;
      if (a.is_admin || hooks.isAdminKey(a.key)) return reply(false, "Can't ban an admin");
      Accounts.setBan(a.name, String(msg.reason || 'Banned').slice(0, 100));
      if ((p = find(a.name))) hooks.kick(p, 'You have been banned');
      reply(true, `Banned ${a.name}`); break;
    case 'unban':
      if (!(a = account())) return;
      Accounts.setBan(a.name, null); reply(true, `Unbanned ${a.name}`); break;
    case 'mute':
    case 'unmute': {
      const v = msg.cmd === 'mute';
      if (!(a = account())) return;
      Accounts.setMuted(a.name, v);
      if ((p = find(a.name))) { p.muted = v; game.tell(p, v ? 'You were muted by an admin.' : 'You were unmuted.'); }
      reply(true, `${v ? 'Muted' : 'Unmuted'} ${a.name}`); break;
    }
    case 'kill':
      if (!(p = target())) return;
      game.kill(p, null, 'admin'); reply(true, `Killed ${p.name}`); break;
    case 'respawn':
      if (!(p = target())) return;
      game.spawn(p); reply(true, `Respawned ${p.name}`); break;
    case 'setmass':
      if (!(p = target())) return;
      p.mass = clamp(num(msg.value, 10), 4, 500); p.peak = Math.max(p.peak, p.mass);
      reply(true, `${p.name} mass = ${Math.round(p.mass)}`); break;
    case 'teleport': {
      if (!(p = target())) return;
      const to = msg.to ? find(msg.to) : null;
      if (msg.to && !to) return reply(false, `No online player "${msg.to}"`);
      p.x = to ? to.x : num(msg.x); p.z = to ? to.z : num(msg.z); p.vx = p.vz = 0;
      reply(true, `Teleported ${p.name}`); break;
    }
    case 'launch':
      if (!(p = target())) return;
      p.vx += (Math.random() - 0.5) * 160; p.vz += (Math.random() - 0.5) * 160;
      reply(true, `Launched ${p.name}`); break;
    case 'god':
      if (!(p = target())) return;
      p.god = !p.god; reply(true, `${p.name} god mode ${p.god ? 'ON' : 'OFF'}`); break;
    case 'freeze':
      if (!(p = target())) return;
      p.frozen = !p.frozen; reply(true, `${p.name} ${p.frozen ? 'frozen' : 'unfrozen'}`); break;
    case 'resetcd':
      if (!(p = target())) return;
      p.dashCd = p.pulseCd = 0; reply(true, `Cooldowns reset for ${p.name}`); break;
    case 'spawnshards': {
      const n = clamp(Math.floor(num(msg.count, 20)), 1, 500);
      const gold = !!msg.gold;
      const at = msg.target ? find(msg.target) : null;
      for (let i = 0; i < n; i++) {
        let x, z;
        if (at) { const ang = Math.random() * 6.283, d = Math.random() * 8; x = at.x + Math.cos(ang) * d; z = at.z + Math.sin(ang) * d; }
        else [x, z] = game.randomPoint();
        game.addShard(x, z, gold ? 1 : 0);
      }
      reply(true, `Spawned ${n} shards`); break;
    }
    case 'clearshards':
      for (const id of [...game.shards.keys()]) game.removeShard(id);
      reply(true, 'Shards cleared'); break;
    case 'broadcast': {
      const text = String(msg.text || '').slice(0, 200);
      if (!text) return reply(false, 'Empty message');
      game.broadcast({ t: 'announce', text }); reply(true, 'Sent'); break;
    }
    case 'powerup': {
      const type = ['speed', 'shield', 'magnet'].includes(msg.type) ? msg.type : null;
      if (!type) return reply(false, 'Unknown powerup');
      if (msg.target) { if (!(p = target())) return; game.giveFx(p, type); reply(true, `${type} given to ${p.name}`); }
      else { const [x, z] = game.randomPoint(); game.addPowerup(x, z, type); reply(true, `${type} pickup spawned`); }
      break;
    }
    case 'meteors':
      game.startMeteors(clamp(Math.floor(num(msg.count, 10)), 1, 60)); reply(true, 'Meteor shower started'); break;
    case 'rush':
      if (msg.action === 'end') game.rush.t = 0.01; else game.startRush(clamp(num(msg.secs, 20), 5, 120));
      reply(true, 'Golden Rush toggled'); break;
    case 'void':
      if (msg.action === 'end') game.endVoid(); else game.startVoid();
      reply(true, `Void ${msg.action === 'end' ? 'ended' : 'started'}`); break;
    case 'set': {
      const lim = SETTING_LIMITS[msg.key];
      if (!lim) return reply(false, `Unknown setting ${msg.key}`);
      const v = lim === 'bool' ? !!msg.value : clamp(num(msg.value, game.settings[msg.key]), lim[0], lim[1]);
      game.settings[msg.key] = v;
      if (msg.key === 'arenaRadius') game.voidRadius = Math.min(game.voidRadius, v);
      if (msg.key === 'arenaRadius' || msg.key === 'obstacles') game.genObstacles();
      game.broadcast({ t: 'settings', settings: game.settings });
      reply(true, `${msg.key} = ${v}`); break;
    }
    case 'resetsettings':
      Object.assign(game.settings, DEFAULT_SETTINGS);
      game.broadcast({ t: 'settings', settings: game.settings });
      reply(true, 'Settings reset'); break;
    case 'resetpw': {
      if (!(a = account())) return;
      const pw = String(msg.password || '');
      if (pw.length < 4 || pw.length > 72) return reply(false, 'Password must be 4-72 chars');
      Accounts.setPassword(a.name, pw); reply(true, `Password for ${a.name} changed`); break;
    }
    case 'deleteaccount':
      if (!(a = account())) return;
      if (hooks.isAdminKey(a.key)) return reply(false, "Can't delete an admin");
      if ((p = find(a.name))) hooks.kick(p, 'Account deleted');
      Accounts.remove(a.name); reply(true, `Deleted account ${a.name}`); break;
    case 'promote':
    case 'demote': {
      const v = msg.cmd === 'promote';
      if (!(a = account())) return;
      if (!v && hooks.isAdminKey(a.key)) return reply(false, 'That admin is set in server config');
      Accounts.setAdmin(a.name, v);
      if ((p = find(a.name))) { p.admin = v; game.send(p, { t: 'role', admin: v }); }
      reply(true, `${a.name} is ${v ? 'now' : 'no longer'} an admin`); break;
    }
    case 'resetstats':
      Accounts.resetStats(); reply(true, 'All stats reset'); break;
    case 'accounts':
      game.send(admin, { t: 'admin_accounts', accounts: Accounts.all() }); return;
    default:
      return reply(false, `Unknown command ${msg.cmd}`);
  }
  console.log(`[admin ${admin.name}] ${msg.cmd} ${msg.target ?? ''}`);
}

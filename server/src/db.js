import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { config } from './config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });
const db = new DatabaseSync(config.dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS players (
    key        TEXT PRIMARY KEY,         -- lowercase nickname
    name       TEXT NOT NULL,            -- display nickname
    salt       TEXT NOT NULL,
    hash       TEXT NOT NULL,
    is_admin   INTEGER NOT NULL DEFAULT 0,
    banned     TEXT,                     -- ban reason or NULL
    muted      INTEGER NOT NULL DEFAULT 0,
    best_mass  REAL NOT NULL DEFAULT 0,
    kills      INTEGER NOT NULL DEFAULT 0,
    deaths     INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL
  );
`);

try { db.exec('ALTER TABLE players ADD COLUMN hue INTEGER'); } catch {}

try { db.exec('ALTER TABLE players ADD COLUMN token_hash TEXT'); } catch {}

const q = {
  get: db.prepare('SELECT * FROM players WHERE key = ?'),
  insert: db.prepare(
    'INSERT INTO players (key,name,salt,hash,is_admin,created_at,last_seen) VALUES (?,?,?,?,?,?,?)',
  ),
  setHue: db.prepare('UPDATE players SET hue=? WHERE key=?'),
  setToken: db.prepare('UPDATE players SET token_hash=? WHERE key=?'),
  setPw: db.prepare('UPDATE players SET salt=?, hash=? WHERE key=?'),
  seen: db.prepare('UPDATE players SET last_seen=? WHERE key=?'),
  ban: db.prepare('UPDATE players SET banned=? WHERE key=?'),
  mute: db.prepare('UPDATE players SET muted=? WHERE key=?'),
  admin: db.prepare('UPDATE players SET is_admin=? WHERE key=?'),
  stats: db.prepare(
    'UPDATE players SET best_mass=MAX(best_mass,?), kills=kills+?, deaths=deaths+? WHERE key=?',
  ),
  del: db.prepare('DELETE FROM players WHERE key=?'),
  all: db.prepare(
    'SELECT key,name,is_admin,banned,muted,best_mass,kills,deaths,created_at,last_seen FROM players ORDER BY last_seen DESC LIMIT 500',
  ),
  top: db.prepare(
    'SELECT name,best_mass,kills FROM players WHERE banned IS NULL AND best_mass > 0 ORDER BY best_mass DESC LIMIT 10',
  ),
  resetStats: db.prepare('UPDATE players SET best_mass=0, kills=0, deaths=0'),
};

const hashPw = (pw, salt) => scryptSync(pw, Buffer.from(salt, 'hex'), 64).toString('hex');

export const NAME_RE = /^[A-Za-z0-9_-]{2,16}$/;
export const keyOf = (name) => String(name).toLowerCase();

export const Accounts = {
  get: (name) => q.get.get(keyOf(name)),
  exists: (name) => !!q.get.get(keyOf(name)),
  create(name, password, isAdmin = false) {
    const salt = randomBytes(16).toString('hex');
    const now = Date.now();
    q.insert.run(keyOf(name), name, salt, hashPw(password, salt), isAdmin ? 1 : 0, now, now);
    return q.get.get(keyOf(name));
  },
  verify(row, password) {
    const a = Buffer.from(hashPw(password, row.salt), 'hex');
    const b = Buffer.from(row.hash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  },
  setPassword(name, password) {
    const salt = randomBytes(16).toString('hex');
    q.setToken.run(null, keyOf(name));
    return q.setPw.run(salt, hashPw(password, salt), keyOf(name)).changes > 0;
  },
  setHue: (name, h) => q.setHue.run(h, keyOf(name)),
  issueToken(name) {
    const t = randomBytes(24).toString('hex');
    q.setToken.run(createHash('sha256').update(t).digest('hex'), keyOf(name));
    return t;
  },
  verifyToken(row, t) {
    if (!row.token_hash || typeof t !== 'string') return false;
    const a = Buffer.from(createHash('sha256').update(t).digest('hex')), b = Buffer.from(row.token_hash);
    return a.length === b.length && timingSafeEqual(a, b);
  },
  revokeToken: (name) => q.setToken.run(null, keyOf(name)),
  rankOf: (key) => db.prepare('SELECT COUNT(*)+1 AS r FROM players WHERE best_mass > (SELECT best_mass FROM players WHERE key=?)').get(key).r,
  touch: (name) => q.seen.run(Date.now(), keyOf(name)),
  setBan: (name, reason) => q.ban.run(reason, keyOf(name)).changes > 0,
  setMuted: (name, v) => q.mute.run(v ? 1 : 0, keyOf(name)).changes > 0,
  setAdmin: (name, v) => q.admin.run(v ? 1 : 0, keyOf(name)).changes > 0,
  addStats: (name, mass, kills, deaths) => q.stats.run(mass, kills, deaths, keyOf(name)),
  remove: (name) => q.del.run(keyOf(name)).changes > 0,
  all: () => q.all.all(),
  top: () => q.top.all(),
  resetStats: () => q.resetStats.run(),
};

// Make sure the configured admin account has the right password / role.
export function seedAdmin() {
  const nick = config.adminNicks[0];
  if (!nick || !config.adminPassword) return;
  const row = Accounts.get(nick);
  if (!row) Accounts.create(nick, config.adminPassword, true);
  else {
    Accounts.setPassword(nick, config.adminPassword);
    Accounts.setAdmin(nick, true);
  }
  console.log(`[auth] admin account "${nick}" seeded from ADMIN_PASSWORD`);
}

export const isAdminRow = (row) => !!row && (row.is_admin === 1 || config.adminNicks.includes(row.key));

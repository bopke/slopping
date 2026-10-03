const env = process.env;
const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);

export const config = {
  port: int(env.PORT, 8080),
  dbPath: env.DB_PATH || './data/shardfall.db',
  // Nicknames (case-insensitive, comma separated) that get admin rights on login.
  adminNicks: (env.ADMIN_NICK || 'bopke')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  // Optional: (re)sets the password of the first admin nick at every startup.
  // Strongly recommended so nobody can claim the admin nickname before you do.
  adminPassword: env.ADMIN_PASSWORD || '',
  // Comma separated list of allowed Origins for the websocket, "*" = any.
  allowedOrigins: (env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
  tickRate: 20,
};

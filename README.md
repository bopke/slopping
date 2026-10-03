# SHARDFALL

A real-time multiplayer 3D arena in the browser. You are a glowing orb: collect shards to grow, **dash** into rivals,
**pulse** to blast them away, and devour anyone smaller than you — while **the Void** periodically swallows the arena's edge.

* **Client** – three.js (bloom, instanced shards, GPU particles) + Vite, fully static → Cloudflare Pages
* **Server** – Node 22, `ws`, authoritative 20 Hz simulation, SQLite (`node:sqlite`) accounts → Docker
* **Accounts** – type a nickname. Known? asked for the password. New? pick a password, done (scrypt-hashed).
* **Admin** – the nickname `bopke` (configurable) gets an in-game **ADMIN** panel.

## Features
* Bumper pillars, a crowned leader with a **bounty**, kill-streak shout-outs, ☄ **meteor showers**, spectating after death
* Power-ups (⚡ speed, 🛡 shield, 🧲 magnet), random **Golden Rush** gold-shard storms, the shrinking **Void**
* Persistent accounts with best mass / kills / deaths, hall of fame on the login screen, `Tab` = your profile
* Pick your orb color (🎨, saved to your account), remember-me sessions and automatic reconnect
* Bots keep the arena lively even when you're alone

## Controls
`WASD`/arrows or hold the mouse = move · `Space` = dash · `E`/right-click = pulse · `Enter` = chat · `M` = mute · `` ` `` = admin panel.
Touch devices get a joystick and buttons.

## Run locally
```bash
cd server && npm install && ADMIN_PASSWORD=secret npm start      # ws://localhost:8080
cd client && npm install && npm run dev                          # http://localhost:5173 (talks to :8080)
cd server && npm test                                            # unit (game rules) + end-to-end smoke test
cd server && node test/load.mjs 40 12                           # load test: N fake players, prints tick cost + bandwidth
```

## Deploy

### 1. Server (your own machine)
```bash
cp .env.example .env        # set ADMIN_PASSWORD, ALLOWED_ORIGINS, DOMAIN
docker compose --profile tls up -d --build
```
`--profile tls` adds Caddy with automatic HTTPS for `$DOMAIN` (point its DNS at the server; ports 80/443 open).
Browsers on an https page (Cloudflare Pages) need `wss://`, so TLS is required. Already have a reverse proxy,
or a Cloudflare Tunnel? Skip the profile and proxy to `:8080` (websocket upgrade must pass through).
Data (SQLite) lives in the `shardfall-data` volume. Health check: `GET /health`.

### 2. Client (Cloudflare Pages)
Connect the repo, then: **Root directory** `client` · **Build command** `npm run build` · **Output** `dist`.
Tell it where the server is — either
* env var `VITE_SERVER_URL=wss://game.example.com` (build time), or
* edit `client/public/config.js` → `serverUrl: "wss://game.example.com"` (works after build too).

Put the Pages URL into `ALLOWED_ORIGINS` on the server.

## Admin
Admin nicknames come from `ADMIN_NICK` (default `bopke`); more admins can be promoted from the panel.
**Set `ADMIN_PASSWORD`** – it (re)creates the admin account on every start, so nobody can squat the nickname.
Forgot the password? Change `ADMIN_PASSWORD` and restart.

The panel (button at the top or `` ` ``) lets admins:
* **Players** – kick, ban, mute/unmute, kill, respawn, god mode, freeze, launch, reset cooldowns, set mass, teleport (coords or to player), spawn shards on someone
* **World** – start/end the Void, spawn/clear shards, broadcast announcements, live-edit every setting (arena size, speed, dash power, cooldowns, PvP on/off, absorb ratio, bot count, shard rate…), reset stats
* **Accounts** – every registered account: ban/unban, mute, promote/demote, reset password, delete

All commands are enforced server-side; non-admins can't send them.

## Layout
```
client/   Vite + three.js static site     server/   ws game server (+ Dockerfile, smoke test)
docker-compose.yml  Caddyfile  .env.example
```
Security notes: passwords are scrypt-hashed with per-user salt, login attempts are rate-limited per IP and nickname,
inputs are validated and rate-limited, websocket origin can be locked to your Pages domain.

// Thin websocket wrapper with typed handlers.
export function serverUrl() {
  const cfg = window.GAME_CONFIG?.serverUrl || import.meta.env.VITE_SERVER_URL;
  if (cfg) return cfg;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return import.meta.env.DEV ? `${proto}//${location.hostname}:8080` : `${proto}//${location.host}`;
}

export class Net {
  constructor() { this.handlers = {}; this.ws = null; this.rtt = 0; }
  on(type, fn) { this.handlers[type] = fn; return this; }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = (this.ws = new WebSocket(serverUrl()));
      ws.onopen = () => { resolve(); this.pingLoop = setInterval(() => this.send({ t: 'ping', c: performance.now() }), 2000); };
      ws.onerror = () => reject(new Error('Cannot reach server'));
      ws.onclose = (e) => { clearInterval(this.pingLoop); if (this.ws === ws) this.handlers.close?.(e); };
      ws.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.t === 'pong') { this.rtt = performance.now() - m.c; return; }
        this.handlers[m.t]?.(m);
      };
    });
  }
  send(o) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(o)); }
  admin(cmd, args = {}) { this.send({ t: 'admin', cmd, ...args }); }
  once(type, pred = () => true) {
    return new Promise((res) => {
      const prev = this.handlers[type];
      this.handlers[type] = (m) => { if (!pred(m)) return prev?.(m); this.handlers[type] = prev; res(m); };
    });
  }
}

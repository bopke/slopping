// Tiny synthesized sound effects (no assets needed).
let ctx = null, muted = localStorage.getItem('muted') === '1';
const ensure = () => { if (!ctx) { try { ctx = new AudioContext(); } catch {} } ctx?.state === 'suspended' && ctx.resume(); return ctx; };
function tone(freq, dur, type = 'sine', vol = 0.08, slide = 0) {
  if (muted || !ensure()) return;
  const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + dur);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + dur);
}
export const sfx = {
  pick: (gold) => tone(gold ? 880 : 620 + Math.random() * 120, 0.09, 'triangle', 0.06, 300),
  dash: () => tone(180, 0.18, 'sawtooth', 0.05, 500),
  pulse: () => tone(120, 0.4, 'sine', 0.12, -70),
  death: () => tone(300, 0.5, 'sawtooth', 0.09, -250),
  bump: () => tone(90, 0.12, 'square', 0.05, -30),
  spawn: () => tone(300, 0.25, 'sine', 0.05, 400),
  warn: () => { tone(220, 0.3, 'square', 0.06); setTimeout(() => tone(165, 0.4, 'square', 0.06), 250); },
  toggle() { muted = !muted; localStorage.setItem('muted', muted ? '1' : '0'); return muted; },
  unlock: ensure,
};

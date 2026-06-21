// Tiny synthesized UI sound kit (Web Audio — no asset files). Soft, short, and
// musical: a wooden "tick" per sown seed, a bright chime on capture, a short
// rising arpeggio on win. Muted state persists per device; the AudioContext is
// created lazily on the first gesture (browser autoplay policy).

let ctx: AudioContext | null = null;
let muted = false;

if (typeof localStorage !== "undefined") {
  try {
    muted = localStorage.getItem("awale.muted") === "1";
  } catch {
    /* ignore */
  }
}

function ac(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    if (!ctx) ctx = new Ctor();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(freq: number, dur: number, opts: { type?: OscillatorType; gain?: number; delay?: number; glideTo?: number } = {}) {
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime + (opts.delay ?? 0);
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = opts.type ?? "sine";
  osc.frequency.setValueAtTime(freq, t0);
  if (opts.glideTo) osc.frequency.exponentialRampToValueAtTime(opts.glideTo, t0 + dur);
  const peak = opts.gain ?? 0.05;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

export type Sfx = "select" | "tick" | "capture" | "win" | "lose" | "draw";

export function sfx(name: Sfx): void {
  if (muted) return;
  switch (name) {
    case "select":
      tone(440, 0.07, { type: "triangle", gain: 0.04 });
      break;
    case "tick": // a soft woodblock per sown seed
      tone(300 + Math.random() * 40, 0.06, { type: "sine", gain: 0.035 });
      break;
    case "capture":
      tone(660, 0.12, { type: "triangle", gain: 0.06 });
      tone(990, 0.16, { type: "sine", gain: 0.045, delay: 0.04 });
      break;
    case "win": // rising major arpeggio
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, 0.28, { type: "triangle", gain: 0.06, delay: i * 0.1 }));
      break;
    case "lose":
      tone(330, 0.5, { type: "sine", gain: 0.05, glideTo: 196 });
      break;
    case "draw":
      tone(440, 0.3, { type: "sine", gain: 0.05 });
      break;
  }
}

export function isMuted(): boolean {
  return muted;
}

export function toggleMuted(): boolean {
  muted = !muted;
  try {
    localStorage.setItem("awale.muted", muted ? "1" : "0");
  } catch {
    /* ignore */
  }
  if (!muted) sfx("select"); // confirm un-mute audibly
  return muted;
}

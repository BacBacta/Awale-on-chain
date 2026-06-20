"use client";

import { useEffect, useRef, useState } from "react";
import { applyMove, legalMovesMask, type GameState } from "../../../engine/src/awale.js";

export interface BoardProps {
  state: GameState;
  /** Which player the local viewer is (their row is drawn at the bottom). */
  perspective?: 0 | 1;
  /** Called with the house (0..5, relative to `perspective`) when tapped. */
  onPlay?: (house: number) => void;
  /** Houses (0..5, relative to `perspective`) currently playable; [] disables input. */
  playable?: number[];
}

const W = 360;
const H = 300;
const R = 31; // pit radius
const ROW_TOP = 96;
const ROW_BOTTOM = H - 96;
const MAX_SEEDS = 14; // visible seed dots before we rely on the count badge

// Sow pacing — deliberately readable so a newcomer can follow each seed. Shared
// with the demo so it can sequence the bot's reply after the board settles.
export const SOW_MS = 215; // per-seed drop cadence
export const SETTLE_MS = 380; // dwell after a move settles (capture flash, read)

/** How long the board will spend animating a move of `seeds` seeds. */
export function moveDurationMs(seeds: number): number {
  return Math.max(1, seeds) * SOW_MS + SETTLE_MS;
}

// Stable sunflower scatter of seed slots inside a pit — deterministic by index
// so seeds never teleport between renders.
const SEED_SLOTS: { dx: number; dy: number }[] = Array.from({ length: MAX_SEEDS }, (_, i) => {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const r = Math.sqrt((i + 0.5) / MAX_SEEDS) * R * 0.6;
  const a = i * golden;
  return { dx: Math.cos(a) * r, dy: Math.sin(a) * r };
});

// Seeds piled in a store well — a tall, narrow deterministic scatter.
const STORE_SLOTS: { dx: number; dy: number }[] = Array.from({ length: 24 }, (_, i) => {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const t = (i + 0.5) / 24;
  const a = i * golden;
  return { dx: Math.cos(a) * 13 * Math.sqrt(t), dy: (t - 0.5) * 150 };
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function haptic(pattern: number | number[]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* unsupported */
  }
}

function eqState(a: GameState, b: GameState): boolean {
  return (
    a.store0 === b.store0 &&
    a.store1 === b.store1 &&
    a.turn === b.turn &&
    a.over === b.over &&
    a.pits.every((v, i) => v === b.pits[i])
  );
}

/** If `to` is exactly one legal move from `from`, return that move; else null. */
function findMove(from: GameState, to: GameState): { house: number; idx: number } | null {
  if (from.over) return null;
  const mask = legalMovesMask(from);
  for (let h = 0; h < 6; h++) {
    if (!(mask & (1 << h))) continue;
    try {
      if (eqState(applyMove(from, h), to)) {
        return { house: h, idx: from.turn === 0 ? h : 6 + h };
      }
    } catch {
      /* illegal — skip */
    }
  }
  return null;
}

/** Mirror of the engine's sow: ordered board snapshots, one per seed dropped. */
function sowFrames(pits: number[], idx: number): number[][] {
  const out = pits.slice();
  let seeds = out[idx];
  out[idx] = 0;
  const frames: number[][] = [out.slice()];
  let pos = idx;
  while (seeds > 0) {
    pos = (pos + 1) % 12;
    if (pos === idx) continue;
    out[pos] += 1;
    seeds -= 1;
    frames.push(out.slice());
  }
  return frames;
}

function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  useEffect(() => {
    ref.current = value;
  });
  return ref.current;
}

function Pit({
  x,
  y,
  seeds,
  prevSeeds,
  active,
  captured,
  origin,
  onClick,
}: {
  x: number;
  y: number;
  seeds: number;
  prevSeeds: number;
  active: boolean;
  captured: boolean;
  origin: boolean;
  onClick?: () => void;
}) {
  const shown = Math.min(seeds, MAX_SEEDS);
  return (
    <g
      onClick={onClick}
      style={{ cursor: onClick ? "pointer" : "default" }}
      role={onClick ? "button" : undefined}
      aria-label={onClick ? `Play house with ${seeds} seeds` : `${seeds} seeds`}
    >
      {captured && (
        <circle cx={x} cy={y} r={R + 3} fill="none" stroke="var(--gold)" strokeWidth={3} style={{ animation: "flash-gold 650ms ease-out" }} />
      )}
      {/* carved well: cast shadow ring, recessed bowl, rim highlight */}
      <ellipse cx={x} cy={y + 2.5} rx={R} ry={R * 0.94} fill="#000" opacity={0.45} filter="url(#soft)" />
      <circle cx={x} cy={y} r={R} fill="url(#pitGrad)" />
      <circle cx={x} cy={y} r={R} fill="none" stroke="rgba(0,0,0,0.55)" strokeWidth={2} />
      <circle cx={x} cy={y - 1.5} r={R - 1.5} fill="none" stroke="rgba(255,228,180,0.16)" strokeWidth={1.4} />
      {origin && <circle cx={x} cy={y} r={R - 4} fill="none" stroke="var(--seed)" strokeWidth={2} opacity={0.5} />}
      {active && (
        <circle cx={x} cy={y} r={R + 0.5} fill="none" stroke="var(--accent)" strokeWidth={3.5} filter="url(#glow)">
          <animate attributeName="opacity" values="1;0.45;1" dur="1.3s" repeatCount="indefinite" />
        </circle>
      )}
      {/* seeds — cowrie-shell sprites, each rotated for a natural pile */}
      {SEED_SLOTS.slice(0, shown).map((s, i) => (
        <g
          key={i}
          transform={`rotate(${(i * 73) % 360} ${x + s.dx} ${y + s.dy})`}
          style={i >= prevSeeds ? { animation: "pop-in 220ms cubic-bezier(0.34,1.56,0.64,1) both" } : undefined}
        >
          <use href="#cowrie" x={x + s.dx - 7} y={y + s.dy - 5} width={14} height={10} />
        </g>
      ))}
      {/* engraved count below the pit */}
      <g transform={`translate(${x}, ${y + R + 11})`}>
        <text x={0} y={0.9} textAnchor="middle" fontSize="12.5" fontWeight="800" fill="rgba(0,0,0,0.6)">
          {seeds}
        </text>
        <text x={0} y={0} textAnchor="middle" fontSize="12.5" fontWeight="800" fill="var(--seed-light)">
          {seeds}
        </text>
      </g>
    </g>
  );
}

export function Board({ state, perspective = 0, onPlay, playable = [] }: BoardProps) {
  // `disp` is what we render; it animates toward the real `state`.
  const [disp, setDisp] = useState<GameState>(state);
  const prevDisp = usePrevious(disp);
  const [captured, setCaptured] = useState<number[]>([]);
  const [origin, setOrigin] = useState<number | null>(null);
  const [shakePit, setShakePit] = useState<number | null>(null);
  const animating = useRef(false);
  const target = useRef<GameState>(state);
  target.current = state; // always chase the freshest state, even mid-animation

  // Drive the display toward `target`, animating single moves seed-by-seed.
  useEffect(() => {
    async function run() {
      if (animating.current) return; // a running loop already reads target.current
      if (eqState(disp, target.current)) return;
      animating.current = true;
      let cur = disp;
      while (!eqState(cur, target.current)) {
        const move = findMove(cur, target.current);
        if (!move) {
          setDisp(target.current); // can't reconstruct a single move — snap
          cur = target.current;
          break;
        }
        setOrigin(move.idx);
        const frames = sowFrames(cur.pits, move.idx);
        for (let f = 1; f < frames.length; f++) {
          setDisp({ ...cur, pits: frames[f], over: false, winner: 0 });
          haptic(4);
          await sleep(SOW_MS);
        }
        const settled = applyMove(cur, move.house);
        setDisp(settled); // capture flash fires off the store diff
        cur = settled;
        await sleep(SETTLE_MS);
        setOrigin(null);
      }
      animating.current = false;
    }
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Capture flash: a store grew between display frames → flash emptied pits.
  useEffect(() => {
    if (!prevDisp) return;
    if (disp.store0 + disp.store1 <= prevDisp.store0 + prevDisp.store1) return;
    const emptied: number[] = [];
    for (let i = 0; i < 12; i++) if (prevDisp.pits[i] > 0 && disp.pits[i] === 0) emptied.push(i);
    if (emptied.length) {
      setCaptured(emptied);
      haptic([14, 40, 22]);
      const t = setTimeout(() => setCaptured([]), 680);
      return () => clearTimeout(t);
    }
  }, [disp, prevDisp]);

  const isAnimating = animating.current;
  const myBase = perspective === 0 ? 0 : 6;
  const oppBase = perspective === 0 ? 6 : 0;
  const bottom = [0, 1, 2, 3, 4, 5].map((h) => myBase + h);
  const top = [5, 4, 3, 2, 1, 0].map((h) => oppBase + h);
  const myStore = perspective === 0 ? disp.store0 : disp.store1;
  const oppStore = perspective === 0 ? disp.store1 : disp.store0;
  const prevPits = prevDisp?.pits ?? disp.pits;
  const colX = (col: number) => 64 + col * 46;

  function tap(col: number, idx: number) {
    if (animating.current) return;
    if (playable.includes(col)) {
      haptic(8);
      onPlay?.(col);
    } else if (onPlay) {
      haptic([20, 30, 20]);
      setShakePit(idx);
      setTimeout(() => setShakePit(null), 420);
    }
  }

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label="Awalé board"
      style={{ filter: "drop-shadow(0 16px 34px rgba(0,0,0,0.55))", display: "block" }}
    >
      <defs>
        <clipPath id="boardClip">
          <rect x="0" y="0" width={W} height={H} rx="26" />
        </clipPath>
        <radialGradient id="sheen" cx="0.28" cy="0.08" r="0.95">
          <stop offset="0" stopColor="rgba(255,240,205,0.4)" />
          <stop offset="0.45" stopColor="rgba(255,240,205,0)" />
        </radialGradient>
        <radialGradient id="vignette" cx="0.5" cy="0.5" r="0.72">
          <stop offset="0.6" stopColor="rgba(0,0,0,0)" />
          <stop offset="1" stopColor="rgba(18,9,2,0.6)" />
        </radialGradient>
        <radialGradient id="pitGrad" cx="0.5" cy="0.3" r="0.9">
          <stop offset="0" stopColor="#3a2616" />
          <stop offset="0.55" stopColor="#241710" />
          <stop offset="1" stopColor="#0e0905" />
        </radialGradient>
        <radialGradient id="storeGrad" cx="0.5" cy="0.18" r="1">
          <stop offset="0" stopColor="#33210f" />
          <stop offset="1" stopColor="#0c0703" />
        </radialGradient>
        <filter id="soft" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.5" />
        </filter>
        <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="3" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        {/* cowrie-shell seed sprite (with a baked soft shadow) */}
        <radialGradient id="cowrieBody" cx="0.38" cy="0.3" r="0.95">
          <stop offset="0" stopColor="#fff7e6" />
          <stop offset="0.55" stopColor="#eed3a1" />
          <stop offset="1" stopColor="#c39e5d" />
        </radialGradient>
        <symbol id="cowrie" viewBox="0 0 14 10">
          <ellipse cx="7" cy="6" rx="6.6" ry="4.4" fill="rgba(0,0,0,0.3)" />
          <ellipse cx="7" cy="5" rx="6.6" ry="4.4" fill="url(#cowrieBody)" stroke="#a9824a" strokeWidth="0.3" />
          <ellipse cx="5.2" cy="3.4" rx="2.1" ry="1.2" fill="rgba(255,255,255,0.45)" />
          <ellipse cx="7" cy="5" rx="1.15" ry="3.3" fill="#6b4d28" />
          <g stroke="#efdcae" strokeWidth="0.5" strokeLinecap="round">
            <line x1="6.1" y1="2.4" x2="7.9" y2="2.4" />
            <line x1="6" y1="3.4" x2="8" y2="3.4" />
            <line x1="6" y1="4.4" x2="8" y2="4.4" />
            <line x1="6" y1="5.4" x2="8" y2="5.4" />
            <line x1="6" y1="6.4" x2="8" y2="6.4" />
            <line x1="6.1" y1="7.4" x2="7.9" y2="7.4" />
          </g>
        </symbol>
      </defs>

      {/* board body: photographic wood + sheen + vignette + framed rim */}
      <g clipPath="url(#boardClip)">
        <image href="/assets/wood.png" x="0" y="0" width={W} height={H} preserveAspectRatio="xMidYMid slice" />
        <rect x="0" y="0" width={W} height={H} fill="url(#sheen)" />
        <rect x="0" y="0" width={W} height={H} fill="url(#vignette)" />
      </g>
      <rect x="2" y="2" width={W - 4} height={H - 4} rx="25" fill="none" stroke="rgba(0,0,0,0.45)" strokeWidth="3.5" />
      <rect x="7" y="7" width={W - 14} height={H - 14} rx="19" fill="none" stroke="rgba(255,233,188,0.18)" strokeWidth="1.5" />

      {/* stores: opponent (left), you (right) — carved wells with cowrie piles */}
      {([
        { x: 37, count: oppStore },
        { x: W - 37, count: myStore },
      ] as const).map(({ x, count }, si) => (
        <g key={si}>
          <ellipse cx={x} cy={H / 2 + 2} rx="25" ry={(H - 64) / 2} fill="#000" opacity={0.4} filter="url(#soft)" />
          <rect x={x - 23} y="36" width="46" height={H - 72} rx="22" fill="url(#storeGrad)" />
          <rect x={x - 23} y="36" width="46" height={H - 72} rx="22" fill="none" stroke="rgba(0,0,0,0.5)" strokeWidth="2" />
          <rect x={x - 21} y="38" width="42" height={H - 76} rx="20" fill="none" stroke="rgba(255,228,180,0.12)" strokeWidth="1.2" />
          {STORE_SLOTS.slice(0, Math.min(count, STORE_SLOTS.length)).map((s, i) => (
            <g key={i} transform={`rotate(${(i * 73) % 360} ${x + s.dx} ${H / 2 + 18 + s.dy})`}>
              <use href="#cowrie" x={x + s.dx - 6.5} y={H / 2 + 18 + s.dy - 4.6} width={13} height={9.3} />
            </g>
          ))}
          <circle cx={x} cy={58} r={15} fill="rgba(0,0,0,0.45)" />
          <text x={x} y={64} textAnchor="middle" fontSize="20" fontWeight="800" fill="var(--seed-light)">
            {count}
          </text>
        </g>
      ))}

      {top.map((idx, col) => (
        <Pit
          key={idx}
          x={colX(col)}
          y={ROW_TOP}
          seeds={disp.pits[idx]}
          prevSeeds={prevPits[idx]}
          active={false}
          captured={captured.includes(idx)}
          origin={origin === idx}
        />
      ))}

      {bottom.map((idx, col) => {
        const active = !isAnimating && playable.includes(col);
        return (
          <g key={idx} className={shakePit === idx ? "shake" : undefined}>
            <Pit
              x={colX(col)}
              y={ROW_BOTTOM}
              seeds={disp.pits[idx]}
              prevSeeds={prevPits[idx]}
              active={active}
              captured={captured.includes(idx)}
              origin={origin === idx}
              onClick={onPlay ? () => tap(col, idx) : undefined}
            />
          </g>
        );
      })}
    </svg>
  );
}

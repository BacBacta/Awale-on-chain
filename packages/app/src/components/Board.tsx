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
const DROP_MS = 105; // per-seed sow cadence

// Stable sunflower scatter of seed slots inside a pit — deterministic by index
// so seeds never teleport between renders.
const SEED_SLOTS: { dx: number; dy: number }[] = Array.from({ length: MAX_SEEDS }, (_, i) => {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const r = Math.sqrt((i + 0.5) / MAX_SEEDS) * R * 0.6;
  const a = i * golden;
  return { dx: Math.cos(a) * r, dy: Math.sin(a) * r };
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
      {/* pit well with carved depth */}
      <circle cx={x} cy={y} r={R} fill="url(#pitGrad)" filter="url(#pitShadow)" />
      <circle cx={x} cy={y} r={R} fill="none" stroke="rgba(0,0,0,0.35)" strokeWidth={1.5} />
      <circle cx={x} cy={y - 1} r={R - 2} fill="none" stroke="rgba(255,220,160,0.10)" strokeWidth={1.2} />
      {origin && <circle cx={x} cy={y} r={R - 4} fill="none" stroke="var(--seed)" strokeWidth={2} opacity={0.5} />}
      {active && (
        <circle cx={x} cy={y} r={R} fill="none" stroke="var(--accent)" strokeWidth={3.5}>
          <animate attributeName="opacity" values="1;0.4;1" dur="1.3s" repeatCount="indefinite" />
        </circle>
      )}
      {/* seeds */}
      <g filter="url(#seedShadow)">
        {SEED_SLOTS.slice(0, shown).map((s, i) => (
          <circle
            key={i}
            cx={x + s.dx}
            cy={y + s.dy}
            r={4.3}
            fill="url(#seedGrad)"
            style={i >= prevSeeds ? { animation: "pop-in 220ms cubic-bezier(0.34,1.56,0.64,1) both" } : undefined}
          />
        ))}
      </g>
      {/* count badge */}
      <g transform={`translate(${x}, ${y + R + 2})`}>
        <rect x={-12} y={-9} width={24} height={17} rx={8} fill="#160f08" opacity={0.92} />
        <text x={0} y={3} textAnchor="middle" fontSize="11.5" fontWeight="800" fill="var(--seed-light)">
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
          await sleep(DROP_MS);
        }
        const settled = applyMove(cur, move.house);
        setDisp(settled); // capture flash fires off the store diff
        cur = settled;
        await sleep(200);
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
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Awalé board">
      <defs>
        <linearGradient id="boardGrad" x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0" stopColor="var(--wood-light)" />
          <stop offset="0.55" stopColor="var(--wood)" />
          <stop offset="1" stopColor="var(--wood-dark)" />
        </linearGradient>
        <radialGradient id="pitGrad" cx="0.5" cy="0.32" r="0.85">
          <stop offset="0" stopColor="#241810" />
          <stop offset="0.7" stopColor="var(--wood-deep)" />
          <stop offset="1" stopColor="#120c06" />
        </radialGradient>
        <radialGradient id="storeGrad" cx="0.5" cy="0.25" r="0.95">
          <stop offset="0" stopColor="#241810" />
          <stop offset="1" stopColor="#110b05" />
        </radialGradient>
        <radialGradient id="seedGrad" cx="0.36" cy="0.3" r="0.85">
          <stop offset="0" stopColor="var(--seed-light)" />
          <stop offset="0.6" stopColor="var(--seed)" />
          <stop offset="1" stopColor="var(--seed-shadow)" />
        </radialGradient>
        <filter id="pitShadow" x="-30%" y="-30%" width="160%" height="160%">
          <feOffset dx="0" dy="2" />
          <feGaussianBlur stdDeviation="2" result="off" />
          <feComposite in="SourceGraphic" in2="off" operator="over" />
        </filter>
        <filter id="seedShadow" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="1" stdDeviation="0.8" floodColor="#000" floodOpacity="0.5" />
        </filter>
        <filter id="grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
          <feComponentTransfer>
            <feFuncA type="linear" slope="0.06" />
          </feComponentTransfer>
          <feComposite operator="in" in2="SourceGraphic" />
        </filter>
      </defs>

      {/* board body with grain + framed rim */}
      <rect x="0" y="0" width={W} height={H} rx="26" fill="url(#boardGrad)" />
      <rect x="0" y="0" width={W} height={H} rx="26" fill="#000" filter="url(#grain)" />
      <rect x="5" y="5" width={W - 10} height={H - 10} rx="22" fill="none" stroke="rgba(0,0,0,0.28)" strokeWidth="2.5" />
      <rect x="9" y="9" width={W - 18} height={H - 18} rx="18" fill="none" stroke="rgba(255,225,170,0.10)" strokeWidth="1.5" />

      {/* stores: opponent (left), you (right) */}
      <rect x="14" y="34" width="46" height={H - 68} rx="22" fill="url(#storeGrad)" filter="url(#pitShadow)" />
      <text x="37" y={H / 2 + 7} textAnchor="middle" fontSize="22" fontWeight="800" fill="var(--seed-light)">
        {oppStore}
      </text>
      <rect x={W - 60} y="34" width="46" height={H - 68} rx="22" fill="url(#storeGrad)" filter="url(#pitShadow)" />
      <text x={W - 37} y={H / 2 + 7} textAnchor="middle" fontSize="22" fontWeight="800" fill="var(--seed-light)">
        {myStore}
      </text>

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

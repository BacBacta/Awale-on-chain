"use client";

import type { GameState } from "../../../engine/src/awale.js";

export interface BoardProps {
  state: GameState;
  /** Which player the local viewer is (their row is drawn at the bottom). */
  perspective?: 0 | 1;
  /** Called with the house (0..5, relative to `perspective`) when tapped. */
  onPlay?: (house: number) => void;
  /** Houses (0..5, relative to `perspective`) currently playable; [] disables input. */
  playable?: number[];
}

const W = 328;
const H = 180;
const R = 22;

function Pit({
  x,
  y,
  seeds,
  active,
  onClick,
}: {
  x: number;
  y: number;
  seeds: number;
  active: boolean;
  onClick?: () => void;
}) {
  return (
    <g onClick={active ? onClick : undefined} style={{ cursor: active ? "pointer" : "default" }}>
      <circle
        cx={x}
        cy={y}
        r={R}
        fill="var(--wood-dark)"
        stroke={active ? "var(--accent)" : "var(--wood)"}
        strokeWidth={active ? 3 : 2}
      />
      <text x={x} y={y + 5} textAnchor="middle" fontSize="16" fontWeight="700" fill="var(--seed)">
        {seeds}
      </text>
    </g>
  );
}

export function Board({ state, perspective = 0, onPlay, playable = [] }: BoardProps) {
  const myBase = perspective === 0 ? 0 : 6;
  const oppBase = perspective === 0 ? 6 : 0;
  // bottom row = my houses left→right; top row = opponent's, right→left (CCW)
  const bottom = [0, 1, 2, 3, 4, 5].map((h) => myBase + h);
  const top = [5, 4, 3, 2, 1, 0].map((h) => oppBase + h);
  const myStore = perspective === 0 ? state.store0 : state.store1;
  const oppStore = perspective === 0 ? state.store1 : state.store0;
  const colX = (col: number) => 52 + col * 45;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Awalé board">
      <rect x="0" y="0" width={W} height={H} rx="20" fill="var(--wood)" />

      {/* opponent store left, my store right */}
      <rect x="6" y="28" width="34" height={H - 56} rx="16" fill="var(--wood-dark)" />
      <text x="23" y={H / 2} textAnchor="middle" fontSize="16" fontWeight="700" fill="var(--seed)">
        {oppStore}
      </text>
      <rect x={W - 40} y="28" width="34" height={H - 56} rx="16" fill="var(--wood-dark)" />
      <text x={W - 23} y={H / 2} textAnchor="middle" fontSize="16" fontWeight="700" fill="var(--seed)">
        {myStore}
      </text>

      {/* opponent row (top) */}
      {top.map((idx, col) => (
        <Pit key={idx} x={colX(col)} y={54} seeds={state.pits[idx]} active={false} />
      ))}

      {/* my row (bottom) */}
      {bottom.map((idx, col) => {
        const active = playable.includes(col);
        return (
          <Pit
            key={idx}
            x={colX(col)}
            y={H - 54}
            seeds={state.pits[idx]}
            active={active}
            onClick={() => onPlay?.(col)}
          />
        );
      })}
    </svg>
  );
}

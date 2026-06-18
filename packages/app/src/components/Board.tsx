"use client";

import type { GameState } from "../../../engine/src/awale.js";

export interface BoardProps {
  state: GameState;
  /** Called when the local player taps one of their playable houses. */
  onPlay?: (house: number) => void;
  /** Houses (0..5, relative to player 0) currently playable; [] disables input. */
  playable?: number[];
}

// South (player 0) houses 0..5 along the bottom, left→right.
// North (player 1) houses 6..11 along the top, shown right→left so the board
// reads counter-clockwise (0→1→…→11→0).
const TOP = [11, 10, 9, 8, 7, 6];
const BOTTOM = [0, 1, 2, 3, 4, 5];

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

export function Board({ state, onPlay, playable = [] }: BoardProps) {
  const colX = (col: number) => 52 + col * 45;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Awalé board">
      <rect x="0" y="0" width={W} height={H} rx="20" fill="var(--wood)" />

      {/* stores: player 1 (North) left, player 0 (South) right */}
      <rect x="6" y="28" width="34" height={H - 56} rx="16" fill="var(--wood-dark)" />
      <text x="23" y={H / 2} textAnchor="middle" fontSize="16" fontWeight="700" fill="var(--seed)">
        {state.store1}
      </text>
      <rect x={W - 40} y="28" width="34" height={H - 56} rx="16" fill="var(--wood-dark)" />
      <text x={W - 23} y={H / 2} textAnchor="middle" fontSize="16" fontWeight="700" fill="var(--seed)">
        {state.store0}
      </text>

      {/* North row (player 1) */}
      {TOP.map((idx, col) => (
        <Pit key={idx} x={colX(col)} y={54} seeds={state.pits[idx]} active={false} />
      ))}

      {/* South row (player 0) */}
      {BOTTOM.map((idx, col) => {
        const active = playable.includes(idx);
        return (
          <Pit
            key={idx}
            x={colX(col)}
            y={H - 54}
            seeds={state.pits[idx]}
            active={active}
            onClick={() => onPlay?.(idx)}
          />
        );
      })}
    </svg>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { initialState, applyMove, legalMovesMask, type GameState } from "../../../engine/src/awale.js";
import { Board } from "./Board.js";

function legalHouses(s: GameState): number[] {
  const mask = legalMovesMask(s);
  const out: number[] = [];
  for (let h = 0; h < 6; h++) if (mask & (1 << h)) out.push(h);
  return out;
}

// A self-playing, silent board used as a living backdrop in the home hero.
export function HeroBoard() {
  const [state, setState] = useState<GameState>(() => initialState());
  const ref = useRef(state);
  ref.current = state;

  useEffect(() => {
    const id = setInterval(() => {
      const s = ref.current;
      const houses = s.over ? [] : legalHouses(s);
      if (houses.length === 0) {
        setState(initialState());
        return;
      }
      const h = houses[Math.floor(Math.random() * houses.length)];
      try {
        setState(applyMove(s, h));
      } catch {
        setState(initialState());
      }
    }, 2600);
    return () => clearInterval(id);
  }, []);

  return <Board state={state} silent />;
}

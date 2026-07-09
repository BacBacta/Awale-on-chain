// Single source for stake-token DISPLAY (decimals + symbol) — the PRIMARY token.
//
// DERIVED from the stake-token registry (stakeTokens()) so it can NEVER drift
// from the token the game actually uses. The old design read separate
// NEXT_PUBLIC_STAKE_DECIMALS / NEXT_PUBLIC_STAKE_SYMBOL env vars, which let the
// symbol fall back to "aUSD" while NEXT_PUBLIC_STAKE_TOKENS already said USDT —
// so every amount in the app was labelled in the wrong currency. One registry,
// one truth: set NEXT_PUBLIC_STAKE_TOKENS and every screen agrees.
//
// Multi-token screens (MatchActions, WeeklyLeague, PlayerStats) still read
// per-token decimals from stakeTokens()/the payload directly; THESE globals are
// only the default/primary token for the many single-token display sites.

import { stakeTokens } from "./stakeTokens.js";

const primary = stakeTokens()[0];

// env fallbacks kept only for a deployment with no token registry configured
export const STAKE_DECIMALS = primary?.decimals ?? Number(process.env.NEXT_PUBLIC_STAKE_DECIMALS ?? "18");
export const STAKE_SYMBOL = primary?.symbol ?? process.env.NEXT_PUBLIC_STAKE_SYMBOL ?? "aUSD";

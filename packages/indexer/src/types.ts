import type { Address } from "viem";

/** A MatchEscrow event normalised with its block timestamp (unix seconds). */
export type EventRecord =
  | { type: "created"; matchId: bigint; player0: Address; token: Address; stake: bigint; timestamp: number }
  | { type: "joined"; matchId: bigint; player1: Address; timestamp: number }
  | { type: "settled"; matchId: bigint; winner: number; prize: bigint; timestamp: number }
  | { type: "voided"; matchId: bigint; timestamp: number }
  | { type: "fee"; matchId: bigint; token: Address; amount: bigint; timestamp: number };

export interface TokenAgg {
  token: Address;
  symbol?: string;
  /** total pot settled (2 × stake) for this token, as a base-unit string */
  volume: string;
  /** protocol revenue (rake) collected for this token, as a base-unit string */
  revenue: string;
}

export interface StatsSnapshot {
  generatedAt: number;
  matches: { created: number; settled: number; voided: number; open: number };
  uniquePlayers: number;
  dau: number;
  mau: number;
  retention: { d1: number; d7: number; d30: number };
  perToken: TokenAgg[];
}

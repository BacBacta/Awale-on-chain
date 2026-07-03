// MatchEscrow interactions from the mini-app. Every write sets `feeCurrency` so
// the network fee is paid in the user's stablecoin (CIP-64) — never CELO.

import { parseUnits, encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { matchEscrowAbi, erc20Abi } from "../../../protocol/src/abis.js";

/** Narrow write surface satisfied by a viem WalletClient (cast at the call site). */
export interface WriteClient {
  writeContract(req: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
    account: Address;
    feeCurrency?: Address;
  }): Promise<Hex>;
}

export interface EscrowConfig {
  chainId: number;
  escrow: Address;
  verifier: Address;
  rpcUrl: string;
}

/** Read the deployed-contract wiring from NEXT_PUBLIC_* env (null if unset). */
export function escrowConfig(): EscrowConfig | null {
  const escrow = process.env.NEXT_PUBLIC_ESCROW_ADDRESS;
  const verifier = process.env.NEXT_PUBLIC_VERIFIER_ADDRESS;
  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;
  const chainId = process.env.NEXT_PUBLIC_CHAIN_ID;
  if (!escrow || !verifier || !rpcUrl || !chainId) return null;
  return { chainId: Number(chainId), escrow: escrow as Address, verifier: verifier as Address, rpcUrl };
}

/** Convert a human stake (e.g. "2.5") to base units for the token's decimals. */
export function parseStake(human: string, decimals: number): bigint {
  return parseUnits(human as `${number}`, decimals);
}

export function approve(
  wallet: WriteClient,
  p: { account: Address; token: Address; spender: Address; amount: bigint; feeCurrency?: Address },
): Promise<Hex> {
  return wallet.writeContract({
    address: p.token,
    abi: erc20Abi,
    functionName: "approve",
    args: [p.spender, p.amount],
    account: p.account,
    feeCurrency: p.feeCurrency,
  });
}

export function createMatch(
  wallet: WriteClient,
  p: { account: Address; escrow: Address; token: Address; stake: bigint; session: Address; feeCurrency?: Address },
): Promise<Hex> {
  return wallet.writeContract({
    address: p.escrow,
    abi: matchEscrowAbi,
    functionName: "createMatch",
    args: [p.token, p.stake, p.session],
    account: p.account,
    feeCurrency: p.feeCurrency,
  });
}

export function joinMatch(
  wallet: WriteClient,
  p: { account: Address; escrow: Address; matchId: bigint; session: Address; feeCurrency?: Address },
): Promise<Hex> {
  return wallet.writeContract({
    address: p.escrow,
    abi: matchEscrowAbi,
    functionName: "joinMatch",
    args: [p.matchId, p.session],
    account: p.account,
    feeCurrency: p.feeCurrency,
  });
}

/** Withdraw an open match nobody has joined — the full stake comes back.
 *  Staking must feel reversible: money stuck in a lobby with no exit is the
 *  fastest way to lose a first-time player's trust. */
export function cancelMatch(
  wallet: WriteClient,
  p: { account: Address; escrow: Address; matchId: bigint; feeCurrency?: Address },
): Promise<Hex> {
  return wallet.writeContract({
    address: p.escrow,
    abi: matchEscrowAbi,
    functionName: "cancelMatch",
    args: [p.matchId],
    account: p.account,
    feeCurrency: p.feeCurrency,
  });
}

/** Move-clock forfeit / abandonment: claim a result and open the challenge
 *  window. Must exactly match ReplayVerifier.transcriptHash so a later
 *  {@link challenge} with the real transcript is checked against the same
 *  commitment. `moves` are plain house indices (0..5), not signatures. */
export function transcriptCommitment(matchId: bigint, startTurn: 0 | 1, moves: number[]): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint8" }, { type: "uint8[]" }],
      [matchId, startTurn, moves],
    ),
  );
}

export function proposeResult(
  wallet: WriteClient,
  p: { account: Address; escrow: Address; matchId: bigint; winner: 0 | 1 | 2; startTurn: 0 | 1; moves: number[]; feeCurrency?: Address },
): Promise<Hex> {
  return wallet.writeContract({
    address: p.escrow,
    abi: matchEscrowAbi,
    functionName: "proposeResult",
    args: [p.matchId, p.winner, transcriptCommitment(p.matchId, p.startTurn, p.moves)],
    account: p.account,
    feeCurrency: p.feeCurrency,
  });
}

/** Dispute a proposed result with the real signed transcript. Pays the true
 *  winner if it replays to a finished game; voids (refunds both) otherwise. */
export function challengeResult(
  wallet: WriteClient,
  p: {
    account: Address;
    escrow: Address;
    matchId: bigint;
    session0: Address;
    session1: Address;
    startTurn: 0 | 1;
    moves: number[];
    sigs: Hex[];
    feeCurrency?: Address;
  },
): Promise<Hex> {
  return wallet.writeContract({
    address: p.escrow,
    abi: matchEscrowAbi,
    functionName: "challenge",
    args: [
      p.matchId,
      { matchId: p.matchId, session0: p.session0, session1: p.session1, startTurn: p.startTurn, moves: p.moves, sigs: p.sigs },
    ],
    account: p.account,
    feeCurrency: p.feeCurrency,
  });
}

/** Pay out a proposed result once its challenge window has elapsed. Anyone
 *  can call this — normally the server's keeper does, but a player can too. */
export function finalizeResult(
  wallet: WriteClient,
  p: { account: Address; escrow: Address; matchId: bigint; feeCurrency?: Address },
): Promise<Hex> {
  return wallet.writeContract({
    address: p.escrow,
    abi: matchEscrowAbi,
    functionName: "finalize",
    args: [p.matchId],
    account: p.account,
    feeCurrency: p.feeCurrency,
  });
}

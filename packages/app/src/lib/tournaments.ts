// Tournament lobby client. The server is the lobby's source of truth (it
// orchestrates the bracket); joining is a real on-chain entry-fee transaction to
// TournamentEscrow, then a mirror POST so the server can seat the bracket.

import { readContract } from "viem/actions";
import type { Address } from "viem";
import { publicClient } from "./minipay.js";
import { effectiveFeeCurrency } from "./minipay.js";
import { approve, type WriteClient } from "./escrow.js";
import { tournamentEscrowAbi, erc20Abi } from "../../../protocol/src/abis.js";

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "";

export interface Tournament {
  id: string;
  token: Address;
  entryFee: string; // base units, stringified
  maxPlayers: number;
  cutBps: number;
  payoutBps: number[];
  joinDeadline: number;
  phase: "lobby" | "running" | "settling" | "done";
  entrants: Address[];
}

export function tournamentsEnabled(): boolean {
  return !!SERVER_URL && !!process.env.NEXT_PUBLIC_TOURNAMENT_ADDRESS;
}

export function tournamentAddress(): Address | null {
  return (process.env.NEXT_PUBLIC_TOURNAMENT_ADDRESS as Address) ?? null;
}

/** Open lobbies still accepting entrants. */
export async function listOpenTournaments(): Promise<Tournament[]> {
  if (!SERVER_URL) return [];
  const res = await fetch(`${SERVER_URL}/tournaments?open=1`);
  if (!res.ok) return [];
  const { tournaments } = (await res.json()) as { tournaments: Tournament[] };
  return tournaments;
}

export async function getTournament(id: string): Promise<Tournament | null> {
  if (!SERVER_URL) return null;
  const res = await fetch(`${SERVER_URL}/tournaments/state?id=${id}`);
  return res.ok ? ((await res.json()) as Tournament) : null;
}

/** Top prize a full field would pay, for the "win up to" lobby line. */
export function topPrize(t: Tournament): bigint {
  const fee = BigInt(t.entryFee);
  const pool = fee * BigInt(t.maxPlayers);
  const distributable = pool - (pool * BigInt(t.cutBps)) / 10_000n;
  const first = t.payoutBps[0] ?? 10_000;
  return (distributable * BigInt(first)) / 10_000n;
}

/** Approve the entry fee if needed, pay it on-chain, then mirror to the server. */
export async function joinTournament(opts: {
  wallet: WriteClient;
  account: Address;
  t: Tournament;
  chainId: number;
  rpcUrl: string;
  feeCurrency?: Address;
}): Promise<void> {
  const { wallet, account, t, chainId, rpcUrl, feeCurrency } = opts;
  const escrow = tournamentAddress();
  if (!escrow) throw new Error("tournaments not configured");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = publicClient(rpcUrl, chainId) as any;
  const fee = BigInt(t.entryFee);

  if (fee > 0n) {
    const allowance = (await readContract(client, {
      address: t.token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account, escrow],
    })) as bigint;
    if (allowance < fee) {
      const ah = await approve(wallet, { account, token: t.token, spender: escrow, amount: fee, feeCurrency });
      await client.waitForTransactionReceipt({ hash: ah });
    }
  }

  const jh = await wallet.writeContract({
    address: escrow,
    abi: tournamentEscrowAbi as unknown as readonly unknown[],
    functionName: "join",
    args: [BigInt(t.id)],
    account,
    feeCurrency: effectiveFeeCurrency(feeCurrency),
  });
  await client.waitForTransactionReceipt({ hash: jh });

  // mirror so the server can seat the bracket (best-effort; chain is the truth)
  await fetch(`${SERVER_URL}/tournaments/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: t.id, address: account }),
  }).catch(() => {});
}

// --- bracket coordination (the live-pairing seam) ---

export interface Assignment {
  round: number;
  index: number;
  role: "host" | "guest";
  opponent: Address;
  asyncMatchId: string | null;
  pendingSince: number;
}

// Mirrors the server's TOURNAMENT_WALKOVER_MS default — used only to decide
// when to *show* the claim button; the server is the actual authority.
export const TOURNAMENT_WALKOVER_MS = 15 * 60_000;

/** The player's current bracket obligation, or null (waiting / eliminated / done). */
export async function myGame(id: string, address: Address): Promise<Assignment | null> {
  if (!SERVER_URL) return null;
  const res = await fetch(`${SERVER_URL}/tournaments/my-game?id=${id}&address=${address}`);
  if (!res.ok) return null;
  const { assignment } = (await res.json()) as { assignment: Assignment | null };
  return assignment;
}

/** Host tells the server which async game it created, so the guest can join it. */
export async function reportGameCreated(
  id: string,
  round: number,
  index: number,
  asyncMatchId: string,
): Promise<void> {
  await fetch(`${SERVER_URL}/tournaments/game-created`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, round, index, asyncMatchId }),
  }).catch(() => {});
}

/** Report a bracket game's winner; the server advances (and finalizes on-chain). */
export async function reportGameResult(
  id: string,
  round: number,
  index: number,
  winner: Address,
): Promise<void> {
  await fetch(`${SERVER_URL}/tournaments/result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, round, index, winner }),
  }).catch(() => {});
}

/** Guest claims a walkover: the host never created the bracket game in time. */
export async function claimWalkover(id: string, round: number, index: number, claimant: Address): Promise<void> {
  const res = await fetch(`${SERVER_URL}/tournaments/claim-walkover`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, round, index, claimant }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error ?? "walkover claim failed");
  }
}

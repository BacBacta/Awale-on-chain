// Open-match lobby + a shared join flow. Cash matches sit Open on-chain until a
// second player joins — this surfaces them so anyone can join a stranger's staked
// game (staked matchmaking), instead of only joining a match id a friend DM'd.

import { readContract } from "viem/actions";
import type { Address } from "viem";
import { publicClient } from "./minipay.js";
import { joinMatch, approve, type WriteClient, type EscrowConfig } from "./escrow.js";
import { createSessionKey, persistSession } from "./session.js";
import { recordLocalMatch } from "./matches.js";
import { matchEscrowAbi, erc20Abi } from "../../../protocol/src/abis.js";
import { confirmTx, sendWithStaleRetry } from "./tx.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const STATUS_OPEN = 1;

export interface OpenMatch {
  id: bigint;
  stake: bigint;
  token: Address;
  creator: Address;
  rakeBps: number;
  /** created by the viewer — not joinable by them, but cancellable. Chain-
   *  discovered, so it surfaces even if the device recorded a wrong local id
   *  (the pre-receipt id prediction could be off by one under races). */
  mine: boolean;
}

interface RawMatch {
  token: Address;
  stake: bigint;
  player0: Address;
  player1: Address;
  status: number;
  rakeBps: number;
}

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "";

interface ServerLobby {
  matches: { id: string; stake: string; token: Address; creator: Address; rakeBps: number; mine: boolean }[];
  mine: { id: string; stake: string; token: Address; creator: Address; rakeBps: number; mine: boolean }[];
  convergeTo: string | null;
}

/** The full lobby view. Server-first (one shared scan + server-side
 *  convergence), falling back to the on-chain scan below when the server is
 *  unreachable. `convergeTo` is the older equal-stake match this viewer should
 *  join instead of waiting in a parallel room (null if none / from fallback). */
export async function fetchLobby(
  cfg: EscrowConfig,
  account?: Address,
  limit = 40,
): Promise<{ matches: OpenMatch[]; convergeTo: bigint | null }> {
  if (SERVER_URL) {
    try {
      const url = `${SERVER_URL.replace(/\/$/, "")}/lobby${account ? `?viewer=${account}` : ""}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = (await res.json()) as ServerLobby;
        const toOpen = (x: ServerLobby["matches"][number]): OpenMatch => ({
          id: BigInt(x.id),
          stake: BigInt(x.stake),
          token: x.token,
          creator: x.creator,
          rakeBps: x.rakeBps,
          mine: x.mine,
        });
        return {
          matches: [...data.matches.map(toOpen), ...data.mine.map(toOpen)],
          convergeTo: data.convergeTo ? BigInt(data.convergeTo) : null,
        };
      }
    } catch {
      /* server unreachable — fall back to the on-chain scan */
    }
  }
  return { matches: await scanOpenMatchesOnChain(cfg, account, limit), convergeTo: null };
}

/** The most recent open (joinable) cash matches, newest first. Server-first,
 *  on-chain fallback. */
export async function listOpenMatches(cfg: EscrowConfig, account?: Address, limit = 40): Promise<OpenMatch[]> {
  return (await fetchLobby(cfg, account, limit)).matches;
}

/** The on-chain scan — the fallback when the server lobby is unreachable, and
 *  the source the server itself uses. Up to `limit` sequential getMatch reads. */
async function scanOpenMatchesOnChain(cfg: EscrowConfig, account?: Address, limit = 40): Promise<OpenMatch[]> {
  const client = publicClient(cfg.rpcUrl, cfg.chainId);
  const next = (await readContract(client, { address: cfg.escrow, abi: matchEscrowAbi, functionName: "nextMatchId" })) as bigint;
  const out: OpenMatch[] = [];
  const lo = next > BigInt(limit) ? next - BigInt(limit) : 1n;
  for (let id = next - 1n; id >= lo; id--) {
    try {
      const m = (await readContract(client, {
        address: cfg.escrow,
        abi: matchEscrowAbi,
        functionName: "getMatch",
        args: [id],
      })) as RawMatch;
      if (Number(m.status) !== STATUS_OPEN || m.player1 !== ZERO) continue;
      const mine = !!account && m.player0.toLowerCase() === account.toLowerCase();
      out.push({ id, stake: m.stake, token: m.token, creator: m.player0, rakeBps: Number(m.rakeBps), mine });
    } catch {
      /* skip unreadable id */
    }
  }
  return out;
}

/** Join a match whose token+stake we already KNOW (the cash matchmaking
 *  flow: the server relays them) — no read of the freshly-created match from
 *  a possibly-stale node. That read was where the joiner's "Something went
 *  wrong" came from: half the nodes hadn't seen the creation yet. */
export async function joinCashMatch(opts: {
  wallet: WriteClient;
  account: Address;
  cfg: EscrowConfig;
  matchId: bigint;
  token: Address;
  stake: bigint;
  feeCurrency?: Address;
}): Promise<void> {
  const { wallet, account, cfg, matchId, token, stake, feeCurrency } = opts;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = publicClient(cfg.rpcUrl, cfg.chainId) as any;
  await approveIfNeeded(client, wallet, account, cfg, token, stake, feeCurrency);
  const session = createSessionKey();
  persistSession(matchId, session);
  recordLocalMatch(matchId);
  const jh = await sendWithStaleRetry("stake", () =>
    joinMatch(wallet, { account, escrow: cfg.escrow, matchId, session: session.address, feeCurrency }),
  );
  await confirmTx(client, jh, "Your stake");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function approveIfNeeded(client: any, wallet: WriteClient, account: Address, cfg: EscrowConfig, token: Address, stake: bigint, feeCurrency?: Address): Promise<void> {
  const allowance = (await readContract(client, {
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account, cfg.escrow],
  })) as bigint;
  if (allowance >= stake) return;
  const ah = await approve(wallet, { account, token, spender: cfg.escrow, amount: stake * 100n, feeCurrency });
  await confirmTx(client, ah, "Approval");
  for (let i = 0; i < 8; i++) {
    const seen = (await readContract(client, { address: token, abi: erc20Abi, functionName: "allowance", args: [account, cfg.escrow] })) as bigint;
    if (seen >= stake) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/** Join an existing open match: approve the stake if needed, then joinMatch. */
export async function joinOpenMatch(opts: {
  wallet: WriteClient;
  account: Address;
  cfg: EscrowConfig;
  matchId: bigint;
  feeCurrency?: Address;
}): Promise<void> {
  const { wallet, account, cfg, matchId, feeCurrency } = opts;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = publicClient(cfg.rpcUrl, cfg.chainId) as any;
  // the match may be seconds old — poll until a node actually shows it
  let m: { token: Address; stake: bigint } | null = null;
  for (let i = 0; i < 15; i++) {
    const read = (await readContract(client, {
      address: cfg.escrow,
      abi: matchEscrowAbi,
      functionName: "getMatch",
      args: [matchId],
    })) as { token: Address; stake: bigint };
    if (read.token !== "0x0000000000000000000000000000000000000000" && read.stake > 0n) {
      m = read;
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!m) throw new Error("This match isn't visible on the network yet — try again in a moment.");

  const session = createSessionKey();
  persistSession(matchId, session);
  recordLocalMatch(matchId);

  const allowance = (await readContract(client, {
    address: m.token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account, cfg.escrow],
  })) as bigint;
  if (allowance < m.stake) {
    // generous headroom: one approval covers ~100 games at this stake
    const ah = await approve(wallet, { account, token: m.token, spender: cfg.escrow, amount: m.stake * 100n, feeCurrency });
    await confirmTx(client, ah, "Approval");
    // load-balanced RPC: wait until the allowance is visible before joining
    for (let i = 0; i < 8; i++) {
      const seen = (await readContract(client, {
        address: m.token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [account, cfg.escrow],
      })) as bigint;
      if (seen >= m.stake) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  const jh = await sendWithStaleRetry("stake", () =>
    joinMatch(wallet, { account, escrow: cfg.escrow, matchId, session: session.address, feeCurrency }),
  );
  // wait until the join is MINED (tolerantly): callers redirect to the match
  // screen next, and a pre-confirmation read shows the old state
  await confirmTx(client, jh, "Your stake");
}

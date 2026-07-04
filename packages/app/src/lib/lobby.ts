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

/** The most recent open (joinable) cash matches, newest first. */
export async function listOpenMatches(cfg: EscrowConfig, account?: Address, limit = 40): Promise<OpenMatch[]> {
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
  const m = (await readContract(client, {
    address: cfg.escrow,
    abi: matchEscrowAbi,
    functionName: "getMatch",
    args: [matchId],
  })) as { token: Address; stake: bigint };

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
    await client.waitForTransactionReceipt({ hash: ah });
  }
  const jh = await joinMatch(wallet, { account, escrow: cfg.escrow, matchId, session: session.address, feeCurrency });
  // wait until the join is MINED: callers redirect to the match screen next,
  // and reading the match pre-confirmation shows the old state — the joiner
  // was greeted with "this wallet is not a player in this match"
  await client.waitForTransactionReceipt({ hash: jh });
}

// Finalize a no-loss league season.
//
// Computes the final standings from on-chain data (league depositors ranked by
// their MatchEscrow wins), splits the realised yield, builds the prize Merkle
// tree, writes the published proofs file the mini-app reads, and — with
// --broadcast — commits the root via HarvestVault.finalize.
//
//   tsx src/scripts/finalize-league.ts            # dry run: writes the JSON
//   tsx src/scripts/finalize-league.ts --broadcast # also calls finalize()
//
// Env: RPC_URL, CHAIN_ID, HARVEST_ADDRESS, ESCROW_ADDRESS, SEASON_ID,
//      OWNER_KEY (vault owner; required for --broadcast),
//      OUT (default ../app/public/league).

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbiItem,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo, celoSepolia, celoAlfajores } from "viem/chains";
import { buildPrizeTree, splitPrizes } from "../league.js";

const RPC_URL = req("RPC_URL");
const CHAIN_ID = Number(process.env.CHAIN_ID ?? "11142220");
const HARVEST = req("HARVEST_ADDRESS") as Address;
const ESCROW = req("ESCROW_ADDRESS") as Address;
const SEASON = BigInt(req("SEASON_ID"));
const OUT = process.env.OUT ?? resolve(import.meta.dirname, "../../../app/public/league");
const BROADCAST = process.argv.includes("--broadcast");

function req(n: string): string {
  const v = process.env[n];
  if (!v) throw new Error(`missing env ${n}`);
  return v;
}
function chainFor(id: number) {
  return id === celoSepolia.id ? celoSepolia : id === celoAlfajores.id ? celoAlfajores : celo;
}

const DEPOSITED = parseAbiItem("event Deposited(uint256 indexed seasonId, address indexed player, uint256 amount)");
const SETTLED = parseAbiItem("event MatchSettled(uint256 indexed matchId, uint8 winner, uint256 prize)");
const getSeasonAbi = parseAbiItem(
  "function getSeason(uint256) view returns ((address token,address pool,uint64 depositDeadline,uint64 seasonEnd,uint8 status,uint256 totalPrincipal,uint256 redeemed,uint256 yieldPot,uint256 prizeDistributed,bytes32 prizeMerkleRoot))",
);
const getMatchAbi = parseAbiItem(
  "function getMatch(uint256) view returns ((address token,uint128 stake,address player0,address player1,address session0,address session1,uint8 status,uint8 startTurn,uint8 proposedWinner,uint16 rakeBps,uint64 challengeDeadline,uint64 activeDeadline,uint64 revealBlock))",
);
const aTokenAbi = parseAbiItem("function aToken() view returns (address)");
const balanceOfAbi = parseAbiItem("function balanceOf(address) view returns (uint256)");
const finalizeAbi = parseAbiItem("function finalize(uint256 seasonId, bytes32 prizeMerkleRoot)");

async function main() {
  const client = createPublicClient({ chain: chainFor(CHAIN_ID), transport: http(RPC_URL) });

  const season = (await client.readContract({ address: HARVEST, abi: [getSeasonAbi], functionName: "getSeason", args: [SEASON] })) as {
    token: Address;
    pool: Address;
    totalPrincipal: bigint;
    yieldPot: bigint;
    status: number;
  };

  // 1. depositors + principal
  const deposits = await client.getLogs({ address: HARVEST, event: DEPOSITED, args: { seasonId: SEASON }, fromBlock: 0n });
  const principal = new Map<string, bigint>();
  for (const l of deposits) {
    const a = l.args as { player?: Address; amount?: bigint };
    if (a.player) principal.set(a.player.toLowerCase(), (principal.get(a.player.toLowerCase()) ?? 0n) + (a.amount ?? 0n));
  }
  if (principal.size === 0) throw new Error("no depositors for this season");

  // 2. wins per depositor, from settled matches
  const settled = await client.getLogs({ address: ESCROW, event: SETTLED, fromBlock: 0n });
  const wins = new Map<string, number>();
  for (const l of settled) {
    const a = l.args as { matchId?: bigint; winner?: number };
    if (a.matchId == null || a.winner == null || a.winner === 2) continue;
    const m = (await client.readContract({ address: ESCROW, abi: [getMatchAbi], functionName: "getMatch", args: [a.matchId] })) as {
      player0: Address;
      player1: Address;
    };
    const winner = (Number(a.winner) === 0 ? m.player0 : m.player1).toLowerCase();
    if (principal.has(winner)) wins.set(winner, (wins.get(winner) ?? 0) + 1);
  }

  // 3. realised yield estimate (aToken balance of the vault − principal)
  let yieldPot = season.yieldPot;
  if (yieldPot === 0n) {
    try {
      const aToken = (await client.readContract({ address: season.pool, abi: [aTokenAbi], functionName: "aToken" })) as Address;
      const bal = (await client.readContract({ address: aToken, abi: [balanceOfAbi], functionName: "balanceOf", args: [HARVEST] })) as bigint;
      yieldPot = bal > season.totalPrincipal ? bal - season.totalPrincipal : 0n;
    } catch {
      console.warn("could not estimate yield from pool; using 0");
    }
  }

  const standings = [...principal.entries()].map(([account, p]) => ({
    account: account as Address,
    wins: wins.get(account) ?? 0,
    principal: p,
  }));
  standings.sort((a, b) => b.wins - a.wins || (b.principal > a.principal ? 1 : -1));

  const tree = buildPrizeTree(splitPrizes(standings, yieldPot));
  const claims: Record<string, { amount: string; proof: Hex[] }> = {};
  for (const c of tree.claims) claims[c.account.toLowerCase()] = { amount: c.amount.toString(), proof: c.proof };

  const file = resolve(OUT, `prizes-${SEASON.toString()}.json`);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(file, JSON.stringify({ season: SEASON.toString(), token: season.token, root: tree.root, yieldPot: yieldPot.toString(), generatedAt: new Date().toISOString(), claims }, null, 2));
  console.log(`standings: ${standings.length} players · yield ${yieldPot} · root ${tree.root}`);
  console.log(`wrote ${file}`);
  standings.forEach((s, i) => console.log(`  #${i + 1} ${s.account} — ${s.wins} wins, ${s.principal} principal`));

  if (BROADCAST) {
    const account = privateKeyToAccount(req("OWNER_KEY") as Hex);
    const wallet = createWalletClient({ account, chain: chainFor(CHAIN_ID), transport: http(RPC_URL) });
    const hash = await wallet.writeContract({ address: HARVEST, abi: [finalizeAbi], functionName: "finalize", args: [SEASON, tree.root] });
    console.log(`finalize tx: ${hash}`);
  } else {
    console.log("dry run — pass --broadcast to call finalize()");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

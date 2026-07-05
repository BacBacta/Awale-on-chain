// Auto-void the user's 7 stuck Active matches as each passes its TTL.
// Uses the deployer/operator key (0x8E30, a player in all 7) so voidExpired
// is accepted. Refunds BOTH players, → Voided. Exits when all are terminal.
//
// Run: from packages/game-server, with the key loaded:
//   set -a; . ../../contracts/.env; set +a
//   K=$PRIVATE_KEY; case "$K" in 0x*) ;; *) K="0x$K";; esac
//   VOID_KEY="$K" npx tsx <thisfile>

import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { celoSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const RPC = "https://forno.celo-sepolia.celo-testnet.org";
const ESCROW = "0x813eF5EAAF5E90D791F6A8FEdeE2F1990CCB4F54" as Address;
const IDS = [7n, 17n, 23n, 31n, 38n, 39n, 40n];
const POLL_MS = 240_000; // 4 min

const matchTuple = {
  components: [
    { name: "token", type: "address" },
    { name: "stake", type: "uint128" },
    { name: "player0", type: "address" },
    { name: "player1", type: "address" },
    { name: "session0", type: "address" },
    { name: "session1", type: "address" },
    { name: "status", type: "uint8" },
    { name: "startTurn", type: "uint8" },
    { name: "proposedWinner", type: "uint8" },
    { name: "rakeBps", type: "uint16" },
    { name: "challengeDeadline", type: "uint64" },
    { name: "activeDeadline", type: "uint64" },
    { name: "revealBlock", type: "uint64" },
    { name: "challengeWindow", type: "uint64" },
    { name: "transcriptCommitment", type: "bytes32" },
  ],
  name: "m",
  type: "tuple",
} as const;
const ABI = [
  { name: "getMatch", type: "function", stateMutability: "view", inputs: [{ name: "id", type: "uint256" }], outputs: [matchTuple] },
  { name: "voidExpired", type: "function", stateMutability: "nonpayable", inputs: [{ name: "id", type: "uint256" }], outputs: [] },
] as const;

const key = process.env.VOID_KEY as Hex;
if (!key) throw new Error("VOID_KEY missing");
const account = privateKeyToAccount(key);
const pub = createPublicClient({ chain: celoSepolia, transport: http(RPC, { timeout: 30_000, retryCount: 3 }) });
const wallet = createWalletClient({ account, chain: celoSepolia, transport: http(RPC, { timeout: 30_000, retryCount: 3 }) });

const STAT: Record<number, string> = { 1: "Open", 2: "Active", 3: "Proposed", 4: "Resolved", 5: "Cancelled", 6: "Voided" };
const log = (s: string) => console.log(`[${new Date().toISOString()}] ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readMatch(id: bigint) {
  return (await pub.readContract({ address: ESCROW, abi: ABI, functionName: "getMatch", args: [id] })) as {
    player0: Address; player1: Address; status: number; activeDeadline: bigint; stake: bigint;
  };
}

async function main() {
  log(`operator ${account.address} — watching ${IDS.length} matches: ${IDS.join(", ")}`);
  const done = new Set<bigint>();
  while (done.size < IDS.length) {
    const now = BigInt(Math.floor(Date.now() / 1000));
    for (const id of IDS) {
      if (done.has(id)) continue;
      try {
        const m = await readMatch(id);
        if (m.status !== 2 && m.status !== 3) {
          log(`#${id} is ${STAT[m.status] ?? m.status} — nothing to do, marking done`);
          done.add(id);
          continue;
        }
        if (now <= m.activeDeadline) {
          const mins = Number(m.activeDeadline - now) / 60;
          log(`#${id} ${STAT[m.status]} — expires in ${mins.toFixed(0)} min, waiting`);
          continue;
        }
        // eligible: void it (refunds both players)
        log(`#${id} past TTL → voidExpired…`);
        const hash = await wallet.writeContract({ address: ESCROW, abi: ABI, functionName: "voidExpired", args: [id] });
        const rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
        if (rcpt.status === "success") {
          log(`✓ #${id} VOIDED — both players refunded (tx ${hash})`);
          done.add(id);
        } else {
          log(`✗ #${id} void reverted (tx ${hash}) — will retry next cycle`);
        }
      } catch (e) {
        log(`#${id} error: ${(e as Error).message.split("\n")[0]} — retry next cycle`);
      }
    }
    if (done.size < IDS.length) await sleep(POLL_MS);
  }
  log(`ALL DONE — ${done.size}/${IDS.length} matches now terminal. Exiting.`);
}

main().catch((e) => {
  log(`FATAL: ${(e as Error).message}`);
  process.exit(1);
});

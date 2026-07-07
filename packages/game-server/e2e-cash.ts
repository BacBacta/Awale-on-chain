// E2E: two simulated players run the NEW one-tap staked flow against the
// PRODUCTION server and the real Celo Sepolia chain:
//   cash-queue ×2 → paired → creator stakes on-chain → joiner stakes →
//   board opens for both → a real signed move → resign → both result-sigs →
//   server settleSigned pays the winner → on-chain Resolved + balance checked.
// Exits non-zero on any missed step. This is the "no friction left" proof.

import { io, type Socket } from "socket.io-client";
import { createWalletClient, createPublicClient, http, parseEventLogs, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { celoSepolia } from "viem/chains";
import { moveDigest, resultDigest, resignDigest, stateHash } from "/workspaces/Awale-on-chain/packages/protocol/src/eip712.js";
const OPENING = { pits: Array(12).fill(4), store0: 0, store1: 0, turn: 0, noCaptureCount: 0 };
import { matchEscrowAbi, erc20Abi } from "/workspaces/Awale-on-chain/packages/protocol/src/abis.js";

const SERVER = "https://awale-game-server.fly.dev";
const RPC = "https://forno.celo-sepolia.celo-testnet.org";
const ESCROW = "0x813eF5EAAF5E90D791F6A8FEdeE2F1990CCB4F54" as Address;
const CHAIN_ID = 11142220n;
const STAKE = 1_000_000_000_000_000_000n; // 1 aUSD — the exact case the players hit
const A_KEY = process.env.A_KEY as Hex; // funded operator key (test wallet A)

const faucetAbi = parseAbi(["function mint(address to, uint256 amount)"]);
const pub = createPublicClient({ chain: celoSepolia, transport: http(RPC) });
const T0 = Date.now();
const marks: Record<string, number> = {};
const mark = (k: string) => (marks[k] = Date.now());
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const fail = (m: string): never => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};
const deadline = setTimeout(() => fail("global timeout (600s)"), 600_000);

// forno's load-balanced nodes lag each other — viem's receipt waiter can hit
// a node that hasn't seen the block yet and throw. Poll tolerantly instead.
async function withRetry<T>(what: string, fn: () => Promise<T>, tries = 6): Promise<T> {
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      log(`retry ${what} (${i + 1}/${tries}): ${String(e).split("\n")[0].slice(0, 90)}`);
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  return fail(`${what} failed after ${tries} tries`);
}

async function receipt(hash: Hex) {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await pub.getTransactionReceipt({ hash });
      if (r) return r;
    } catch {
      /* not yet visible on this node */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return fail(`receipt timeout for ${hash}`);
}

function until<T>(what: string, ms: number, arm: (done: (v: T) => void) => void): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => fail(`timeout waiting for ${what}`), ms);
    arm((v) => {
      clearTimeout(t);
      resolve(v);
    });
  });
}

async function main() {
  // --- wallets: BOTH players are fresh keys (the funded key only bankrolls
  // them once) — avoids nonce races with the live server, which signs its own
  // txs from the operator account, and with forno's lagging nonce views.
  const funder = privateKeyToAccount(A_KEY);
  const wf = createWalletClient({ account: funder, chain: celoSepolia, transport: http(RPC) });
  const A = privateKeyToAccount(generatePrivateKey());
  const B = privateKeyToAccount(generatePrivateKey());
  const wa = createWalletClient({ account: A, chain: celoSepolia, transport: http(RPC) });
  const wb = createWalletClient({ account: B, chain: celoSepolia, transport: http(RPC) });
  log(`A=${A.address} B=${B.address}`);

  // token + verifier discovered from chain state (match #13 was 1 aUSD)
  const m13 = (await pub.readContract({ address: ESCROW, abi: matchEscrowAbi, functionName: "getMatch", args: [13n] })) as { token: Address };
  const TOKEN = m13.token;
  log(`token=${TOKEN}`);

  // fund both: explicit nonces (forno is load-balanced; its nonce view lags)
  let nf = await pub.getTransactionCount({ address: funder.address, blockTag: "pending" });
  const fund = async (fn: () => Promise<Hex>) => receipt(await withRetry("fund tx", fn));
  await fund(() => wf.sendTransaction({ to: A.address, value: 30_000_000_000_000_000n, nonce: nf++ }));
  await fund(() => wf.sendTransaction({ to: B.address, value: 30_000_000_000_000_000n, nonce: nf++ }));
  await fund(() => wf.writeContract({ address: TOKEN, abi: faucetAbi, functionName: "mint", args: [A.address, STAKE * 3n], nonce: nf++ }));
  await fund(() => wf.writeContract({ address: TOKEN, abi: faucetAbi, functionName: "mint", args: [B.address, STAKE * 3n], nonce: nf++ }));
  log("A & B funded (0.03 CELO + 3 aUSD each)");

  // --- 1. both tap "Play for 1 — find an opponent" ---
  const sa: Socket = io(SERVER, { transports: ["websocket"] });
  const sb: Socket = io(SERVER, { transports: ["websocket"] });
  sa.on("error", (e: { message: string }) => log(`A got server error: ${e.message}`));
  sb.on("error", (e: { message: string }) => log(`B got server error: ${e.message}`));
  const matchedA = until<{ role: string; opponent: Address }>("A cash-matched", 30_000, (done) => sa.on("cash-matched", done));
  const matchedB = until<{ role: string; opponent: Address }>("B cash-matched", 30_000, (done) => sb.on("cash-matched", done));
  sa.on("connect", () => sa.emit("cash-queue", { address: A.address, stakeWei: STAKE.toString(), token: TOKEN }));
  // B queues a beat later so roles are deterministic (A = creator)
  sb.on("connect", () => setTimeout(() => sb.emit("cash-queue", { address: B.address, stakeWei: STAKE.toString(), token: TOKEN }), 1500));
  const [ma, mb] = await Promise.all([matchedA, matchedB]);
  if (ma.role !== "create" || mb.role !== "join") fail(`unexpected roles: A=${ma.role} B=${mb.role}`);
  mark("paired");
  log(`✓ paired — A creates, B joins (A sees opponent ${ma.opponent})`);

  // forno is load-balanced: a mined approve can be invisible to the next
  // node for a few seconds — wait until the allowance is actually readable
  const waitAllowance = async (owner: Address, min: bigint) => {
    for (let i = 0; i < 30; i++) {
      const al = (await pub.readContract({ address: TOKEN, abi: erc20Abi, functionName: "allowance", args: [owner, ESCROW] })) as bigint;
      if (al >= min) return;
      await new Promise((r) => setTimeout(r, 2000));
    }
    fail("allowance never became visible");
  };

  // --- 2. A (creator): approve×100 + create, report id ---
  const sessA = { key: generatePrivateKey() };
  const sessAaddr = privateKeyToAccount(sessA.key).address;
  let h = await withRetry("A approve", () => wa.writeContract({ address: TOKEN, abi: erc20Abi, functionName: "approve", args: [ESCROW, STAKE * 100n] }));
  await receipt(h);
  await waitAllowance(A.address, STAKE);
  h = await withRetry("A create", () => wa.writeContract({ address: ESCROW, abi: matchEscrowAbi, functionName: "createMatch", args: [TOKEN, STAKE, sessAaddr] }));
  const rcA = await receipt(h);
  const created = parseEventLogs({ abi: matchEscrowAbi, logs: rcA.logs, eventName: "MatchCreated" });
  const matchId = (created[0]?.args as { matchId?: bigint }).matchId!;
  log(`✓ A created match #${matchId}`);
  const joinMsg = until<{ matchId: string }>("B cash-join", 30_000, (done) => sb.on("cash-join", done));
  sa.emit("cash-created", { matchId: matchId.toString() });
  const jm = await joinMsg;
  if (jm.matchId !== matchId.toString()) fail(`B got wrong match id ${jm.matchId}`);
  log("✓ B received the match id from the server");
  const readyMsg = until<{ matchId: string }>("A cash-ready", 120_000, (done) => sa.on("cash-ready", done));

  // --- 3. B (joiner): approve×100 + join ---
  const sessB = { key: generatePrivateKey() };
  const sessBaddr = privateKeyToAccount(sessB.key).address;
  h = await withRetry("B approve", () => wb.writeContract({ address: TOKEN, abi: erc20Abi, functionName: "approve", args: [ESCROW, STAKE * 100n] }));
  await receipt(h);
  await waitAllowance(B.address, STAKE);
  h = await withRetry("B join", () => wb.writeContract({ address: ESCROW, abi: matchEscrowAbi, functionName: "joinMatch", args: [matchId, sessBaddr] }));
  await receipt(h);
  sb.emit("cash-joined", {});
  const rm = await readyMsg;
  if (rm.matchId !== matchId.toString()) fail("cash-ready carried wrong id");
  mark("ready");
  log("✓ B joined on-chain — both stakes locked; creator released by cash-ready");

  // --- 4. both watch until the board opens (StartFinalized / hydration) ---
  type StateMsg = { state: { turn: number; over: boolean; pits: number[] }; ply: number };
  const boardA = until<StateMsg>("board for A", 150_000, (done) => sa.on("state", (m: StateMsg) => done(m)));
  const boardB = until<StateMsg>("board for B", 150_000, (done) => sb.on("state", (m: StateMsg) => done(m)));
  const rewatch = setInterval(() => {
    sa.emit("watch", { matchId: matchId.toString(), player: 0 });
    sb.emit("watch", { matchId: matchId.toString(), player: 1 });
  }, 4000);
  sa.emit("watch", { matchId: matchId.toString(), player: 0 });
  sb.emit("watch", { matchId: matchId.toString(), player: 1 });
  const [stA] = await Promise.all([boardA, boardB]);
  clearInterval(rewatch);
  mark("board");
  const verifier = (await pub.readContract({ address: ESCROW, abi: parseAbi(["function verifier() view returns (address)"]), functionName: "verifier" })) as Address;
  log(`✓ board open on BOTH sockets — turn=${stA.state.turn}, verifier=${verifier}`);

  // --- 5. the player on move plays one real signed move ---
  const mover = stA.state.turn as 0 | 1;
  const moverSock = mover === 0 ? sa : sb;
  const moverSess = mover === 0 ? sessA.key : sessB.key;
  const ctx = { chainId: CHAIN_ID, verifier };
  const sig = await privateKeyToAccount(moverSess).sign({ hash: moveDigest(matchId, 0n, 0, stateHash(OPENING), ctx) });
  const afterMove = until<StateMsg>("state after move", 20_000, (done) =>
    sa.on("state", (m: StateMsg) => (m.ply === 1 ? done(m) : undefined)),
  );
  moverSock.emit("move", { matchId: matchId.toString(), player: mover, house: 0, signature: sig });
  await afterMove;
  log("✓ signed move accepted, both boards advanced to ply 1");

  // diagnostic: fetch the server's own view of the match before resigning
  type Tr = { transcript: { startTurn: number; moves: number[]; session0: Address; session1: Address; sigs: string[] } };
  const trMsg = await until<Tr>("transcript", 10_000, (done) => {
    sa.on("transcript", (m: Tr) => done(m));
    sa.emit("get-transcript", { matchId: matchId.toString() });
  });
  const tr = trMsg.transcript;
  log(`server view: startTurn=${tr.startTurn} moves=[${tr.moves}] s0=${tr.session0} s1=${tr.session1}`);
  log(`local view:  sessA=${sessAaddr} sessB=${sessBaddr} (ply for resign: ${tr.moves.length})`);

  // --- 6. the other player resigns → gameover → both sign the result ---
  const resigner = (1 - mover) as 0 | 1;
  const resignerSock = resigner === 0 ? sa : sb;
  const resignerSess = resigner === 0 ? sessA.key : sessB.key;
  const overA = until<{ winner: number }>("gameover A", 20_000, (done) => sa.on("gameover", done));
  const overB = until<{ winner: number }>("gameover B", 20_000, (done) => sb.on("gameover", done));
  const rSig = await privateKeyToAccount(resignerSess).sign({ hash: resignDigest(matchId, BigInt(tr.moves.length), ctx) });
  resignerSock.emit("resign", { matchId: matchId.toString(), player: resigner, signature: rSig });
  const [ovA] = await Promise.all([overA, overB]);
  if (ovA.winner !== mover) fail(`winner should be ${mover}, got ${ovA.winner}`);
  log(`✓ resign accepted — winner is player ${ovA.winner}`);

  // both submit result signatures → server settleSigned (ITS first live run)
  const settled = until<unknown>("settled event", 60_000, (done) => sa.on("settled", done));
  const rctx = { chainId: CHAIN_ID, escrow: ESCROW };
  const sig0 = await privateKeyToAccount(sessA.key).sign({ hash: resultDigest(matchId, ovA.winner, rctx) });
  const sig1 = await privateKeyToAccount(sessB.key).sign({ hash: resultDigest(matchId, ovA.winner, rctx) });
  const balBefore = (await pub.readContract({ address: TOKEN, abi: erc20Abi, functionName: "balanceOf", args: [mover === 0 ? A.address : B.address] })) as bigint;
  sa.emit("result-sig", { matchId: matchId.toString(), signature: sig0 });
  sb.emit("result-sig", { matchId: matchId.toString(), signature: sig1 });
  await settled;
  log("✓ server settled the match (settleSigned)");

  // --- 7. on-chain proof: Resolved + winner paid 1.84 (settle tx needs to mine) ---
  let finStatus = 0;
  for (let i = 0; i < 45; i++) {
    const fin = (await pub.readContract({ address: ESCROW, abi: matchEscrowAbi, functionName: "getMatch", args: [matchId] })) as { status: number };
    finStatus = Number(fin.status);
    if (finStatus === 4) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (finStatus !== 4) fail(`final status ${finStatus}, expected 4 (Resolved)`);
  const balAfter = (await pub.readContract({ address: TOKEN, abi: erc20Abi, functionName: "balanceOf", args: [mover === 0 ? A.address : B.address] })) as bigint;
  const gained = balAfter - balBefore;
  log(`✓ on-chain Resolved — winner received ${Number(gained) / 1e18} aUSD (expected 1.84)`);
  if (gained !== 1_840_000_000_000_000_000n) fail(`payout mismatch: ${gained}`);

  // --- scenario B: joiner fails AFTER the creator staked → the still-
  // connected creator must receive cash-abort (its cue to auto-refund) ---
  log("scenario B: joiner failure → creator gets the abort cue…");
  const sa2: Socket = io(SERVER, { transports: ["websocket"] });
  const sb2: Socket = io(SERVER, { transports: ["websocket"] });
  const m2a = until<{ role: string }>("A2 matched", 30_000, (done) => sa2.on("cash-matched", done));
  const m2b = until<{ role: string }>("B2 matched", 30_000, (done) => sb2.on("cash-matched", done));
  const STAKE2 = STAKE / 4n; // separate queue key
  sa2.on("connect", () => sa2.emit("cash-queue", { address: A.address, stakeWei: STAKE2.toString(), token: TOKEN }));
  sb2.on("connect", () => setTimeout(() => sb2.emit("cash-queue", { address: B.address, stakeWei: STAKE2.toString(), token: TOKEN }), 1200));
  await Promise.all([m2a, m2b]);
  const abortA = until<{ reason: string }>("A2 cash-abort", 20_000, (done) => sa2.on("cash-abort", done));
  sa2.emit("cash-created", { matchId: "999999" }); // creator reports its (fictional) stake
  sb2.emit("cash-failed", {}); // joiner's stake fails
  const ab = await abortA;
  log(`✓ creator received the abort cue while still connected ("${ab.reason.slice(0, 50)}…") — the app auto-cancels here`);
  sa2.close();
  sb2.close();

  clearTimeout(deadline);
  sa.close();
  sb.close();
  const secs = (a: string, b: string) => ((marks[b] - marks[a]) / 1000).toFixed(0);
  console.log("\n=== FRICTION REPORT ===");
  console.log(`pair → both stakes confirmed: ${secs("paired", "ready")}s (approve pre-warmed in the app hides ~half)`);
  console.log(`pair → board open both sides: ${secs("paired", "board")}s`);
  console.log("\nPASS — full flow + joiner-failure abort cue: queue → pair → create → join → cash-ready → board → move → resign → settleSigned → paid.");
  process.exit(0);
}

main().catch((e) => fail(String(e?.stack ?? e)));

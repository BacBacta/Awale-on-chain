"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { readContract } from "viem/actions";
import { parseEventLogs, type Address } from "viem";
import { io, type Socket } from "socket.io-client";
import { publicClient, effectiveFeeCurrency } from "../lib/minipay.js";
import { createMatch, joinMatch, approve, cancelMatch, parseStake, type WriteClient, type EscrowConfig } from "../lib/escrow.js";
import { createSessionKey, persistSession } from "../lib/session.js";
import { receiptDeeplink } from "../lib/deeplinks.js";
import { computePayout, fmt, rakePct, stakeFloor } from "../lib/money.js";
import { humanizeError } from "../lib/errors.js";
import { recordLocalMatch, listLocalMatches } from "../lib/matches.js";
import { stakeTokens, preferredIndex } from "../lib/stakeTokens.js";
import { listOpenMatches, joinOpenMatch, joinCashMatch, type OpenMatch } from "../lib/lobby.js";
import { CrossMatchOffer } from "./CrossMatchOffer.js";
import { friendlyName } from "../lib/names.js";
import { faucetAbi } from "../lib/league.js";
import { track } from "../lib/analytics.js";
import { confirmTx, sendWithStaleRetry, readWithRetry } from "../lib/tx.js";
import { matchEscrowAbi, erc20Abi } from "../../../protocol/src/abis.js";

const TOKENS = stakeTokens();
// Micro-stakes by design: the average MiniPay transaction is ~$1 and most of
// the target audience budgets under $10/month for betting (GeoPoll 2025) —
// a $5 default was asking for their whole month in one game.
const QUICK_STAKES = ["0.25", "0.5", "1"];

type Step = "idle" | "approving" | "staking" | "done" | "error";

export function MatchActions({ wallet, account, cfg }: { wallet: WriteClient; account: Address; cfg: EscrowConfig }) {
  const [stake, setStake] = useState("0.5");
  const [joinId, setJoinId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);
  const [openId, setOpenId] = useState<bigint | null>(null);
  const [step, setStep] = useState<Step>("idle");
  const [balance, setBalance] = useState<bigint | null>(null);
  const [rakeBps, setRakeBps] = useState<number | null>(null); // null until confirmed — never show a made-up fee
  const [minStake, setMinStake] = useState<bigint>(0n);
  const [copied, setCopied] = useState(false);
  const [sel, setSel] = useState(0); // index into TOKENS
  const [showJoin, setShowJoin] = useState(false); // join-by-number is the rare path
  // a match of mine already waiting for an opponent — steer to sharing it
  // instead of quietly stacking a second stake in a second empty lobby
  const [alreadyOpen, setAlreadyOpen] = useState<bigint | null>(null);
  // open matches from OTHER players — shown ABOVE the create form. The
  // recurring failure mode of two friends playing "for money" was BOTH
  // tapping create: two orphan stakes, nobody across the board. Surfacing
  // the friend's fresh match here turns the second create into a join.
  const [openToJoin, setOpenToJoin] = useState<OpenMatch[]>([]);
  const [joiningOpen, setJoiningOpen] = useState<bigint | null>(null);
  // one-time 18+ / responsible-play acknowledgement before the first stake
  const [adultOk, setAdultOk] = useState(false);
  // one-tap staked matchmaking (the primary path): queue on the server with
  // a stake, get paired, and the two clients run create → join between them.
  // Nobody browses lobbies, shares links or reads match numbers anymore.
  const [finding, setFinding] = useState<"idle" | "searching" | "pairing">("idle");
  const [autoFind, setAutoFind] = useState(false);
  const [foundOpp, setFoundOpp] = useState<Address | null>(null);
  // set only when the server resolved the pair to a stake LOWER than we typed
  // (matched inside a stake band, P0-3) — surfaced so the final amount is shown
  const [matchedStake, setMatchedStake] = useState<bigint | null>(null);
  const cashSock = useRef<Socket | null>(null);

  const busy = step === "approving" || step === "staking";
  const tok = TOKENS[sel];
  const token = tok?.address;
  const dec = tok?.decimals ?? 18;
  const sym = tok?.symbol ?? "";
  const feeCurrency = tok?.feeCurrency;

  // Read balances across all stake tokens + the live rake; default to the
  // user's highest-balance token (preferred stablecoin). The reads are kept
  // independent: a failed balance read must never zero out the displayed fee
  // (a wrong number on a money screen is worse than a placeholder).
  useEffect(() => {
    if (TOKENS.length === 0) return;
    const client = publicClient(cfg.rpcUrl, cfg.chainId);
    // readWithRetry: a single dropped forno request used to silently blank
    // the fee preview and the balance on the money panel
    readWithRetry(() => readContract(client, { address: cfg.escrow, abi: matchEscrowAbi, functionName: "rakeBps" }))
      .then((rake) => setRakeBps(Number(rake)))
      .catch(() => setRakeBps(null));
    readWithRetry(() => readContract(client, { address: cfg.escrow, abi: matchEscrowAbi, functionName: "minStake" }))
      .then((floor) => setMinStake(floor as bigint))
      .catch(() => {});
    Promise.all(
      TOKENS.map((t) =>
        readWithRetry(() => readContract(client, { address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [account] })),
      ),
    )
      .then((bals) => {
        const balances = bals as bigint[];
        const pref = preferredIndex(TOKENS, balances);
        setSel(pref);
        setBalance(balances[pref]);
      })
      .catch(() => {
        /* balance preview is best-effort */
      });
  }, [account, cfg]);

  useEffect(() => {
    const refresh = () =>
      listOpenMatches(cfg, account, 15)
        .then((list) => setOpenToJoin(list.filter((o) => !o.mine).slice(0, 3)))
        .catch(() => {});
    void refresh();
    const iv = setInterval(refresh, 12_000); // a friend may create AFTER we opened the panel
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  useEffect(() => {
    track("money_open");
    try {
      setAdultOk(localStorage.getItem("awale_adult") === "1");
    } catch {
      /* storage unavailable — keep the checkbox visible */
    }
    // rematch deep-link: /?money=1&stake=X&auto=1 — both players tap Rematch,
    // both auto-queue at the same stake, the matchmaker reunites them
    try {
      const params = new URLSearchParams(window.location.search);
      const st = params.get("stake");
      if (st && Number(st) > 0) setStake(st);
      if (params.get("auto") === "1") setAutoFind(true);
    } catch {
      /* ignore */
    }
  }, []);

  function confirmAdult() {
    setAdultOk(true);
    try {
      localStorage.setItem("awale_adult", "1");
    } catch {
      /* ignore */
    }
  }

  // does one of my recent matches already sit open? (checked once, best-effort)
  useEffect(() => {
    const ids = listLocalMatches().slice(0, 6);
    if (ids.length === 0) return;
    const client = publicClient(cfg.rpcUrl, cfg.chainId);
    Promise.allSettled(
      ids.map(async (id) => {
        const m = (await readContract(client, {
          address: cfg.escrow,
          abi: matchEscrowAbi,
          functionName: "getMatch",
          args: [id],
        })) as { status: number; player0: Address };
        return { id, status: Number(m.status), creator: m.player0 };
      }),
    ).then((results) => {
      const mine = results
        .filter((r): r is PromiseFulfilledResult<{ id: bigint; status: number; creator: Address }> => r.status === "fulfilled")
        .map((r) => r.value)
        .find((m) => m.status === 1 && m.creator.toLowerCase() === account.toLowerCase());
      if (mine) setAlreadyOpen(mine.id);
    });
  }, [account, cfg]);

  // keep the displayed balance in sync with the selected token
  useEffect(() => {
    if (!token) return;
    const client = publicClient(cfg.rpcUrl, cfg.chainId);
    readContract(client, { address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] })
      .then((b) => setBalance(b as bigint))
      .catch(() => {});
  }, [sel, token, account, cfg]);

  async function onFaucet() {
    if (!tok?.faucet || !token || busy) return;
    setError(null);
    setStep("staking");
    try {
      const client = publicClient(cfg.rpcUrl, cfg.chainId);
      const hash = await wallet.writeContract({
        address: token,
        abi: faucetAbi,
        functionName: "mint",
        args: [account, parseStake("100", dec)],
        account,
        feeCurrency: effectiveFeeCurrency(feeCurrency),
      });
      await client.waitForTransactionReceipt({ hash });
      const b = (await readContract(client, { address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] })) as bigint;
      setBalance(b);
      setStep("idle");
    } catch (e) {
      fail(e);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function ensureAllowance(client: any, token: Address, amount: bigint) {
    const allowance = (await readContract(client, {
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account, cfg.escrow],
    })) as bigint;
    if (allowance >= amount) return;
    setStep("approving");
    // approve generous headroom once (≈100 games at this stake): one wallet
    // popup instead of one per game — approvals were half the tx friction
    const hash = await approve(wallet, { account, token, spender: cfg.escrow, amount: amount * 100n, feeCurrency: feeCurrency });
    await confirmTx(client, hash, "Approval");
    // best-effort visibility wait; the stake itself also retries on staleness
    for (let i = 0; i < 8; i++) {
      const seen = (await readContract(client, {
        address: token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [account, cfg.escrow],
      })) as bigint;
      if (seen >= amount) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  async function onJoinOpen(matchId: bigint) {
    if (busy || joiningOpen !== null || !adultOk) return;
    setJoiningOpen(matchId);
    setError(null);
    try {
      await joinOpenMatch({ wallet, account, cfg, matchId, feeCurrency });
      track("match_joined");
      window.location.href = `/play?match=${matchId.toString()}`;
    } catch (e) {
      setError(humanizeError(e));
      setJoiningOpen(null);
    }
  }

  function fail(e: unknown) {
    setError(humanizeError(e));
    setStep("error");
  }

  /** Stake + create on-chain; returns the real match id from the receipt.
   *  Resilient by design: the stake send retries through stale-node reverts
   *  and the receipt wait tolerates lagging nodes — these two were the
   *  "Placing your stake fails 4 times out of 5". */
  async function createOnChain(amount: bigint): Promise<bigint> {
    const client = publicClient(cfg.rpcUrl, cfg.chainId);
    const session = createSessionKey();
    await ensureAllowance(client, token!, amount);
    setStep("staking");
    const hash = await sendWithStaleRetry("stake", () =>
      createMatch(wallet, {
        account,
        escrow: cfg.escrow,
        token: token!,
        stake: amount,
        session: session.address,
        feeCurrency: feeCurrency,
      }),
    );
    const receipt = await confirmTx(client, hash, "Your stake");
    const created = parseEventLogs({ abi: matchEscrowAbi, logs: receipt.logs, eventName: "MatchCreated" });
    const matchId = (created[0]?.args as { matchId?: bigint } | undefined)?.matchId;
    if (matchId === undefined) throw new Error("match created but its id couldn't be read — check Your matches");
    persistSession(matchId, session);
    recordLocalMatch(matchId);
    setTx(hash);
    return matchId;
  }

  // the floor the UI enforces: the higher of the client minimum (kills dust
  // matches even when the contract's minStake is 0) and the on-chain minStake.
  const floor = (): bigint => stakeFloor(minStake, dec);

  function validateStake(): bigint | null {
    const amount = parseStake(stake || "0", dec);
    if (amount <= 0n) {
      setError("Enter an amount greater than zero.");
      return null;
    }
    const min = floor();
    if (amount < min) {
      setError(`Minimum stake is ${fmt(min, dec)} ${sym}.`);
      return null;
    }
    if (balance !== null && amount > balance) {
      setError(`Not enough ${sym} — add money to MiniPay first.`);
      return null;
    }
    return amount;
  }

  /** THE button: find someone at this stake and start playing.
   *
   *  Friction-cuts baked in:
   *  - the token approval runs DURING the search, not after pairing — by the
   *    time an opponent appears, the slowest transaction is already done;
   *  - the creator only leaves for the board once the joiner's stake is
   *    CONFIRMED (cash-ready) — if the joiner fails, the creator is still
   *    here and auto-cancels for an instant refund, no button hunting;
   *  - every send retries through stale-node reverts, every receipt wait
   *    tolerates lagging nodes (the old "fails 4 times out of 5"). */
  function findOpponent() {
    if (!token || busy || !adultOk || finding !== "idle") return;
    setError(null);
    const amount = validateStake();
    if (amount === null) return;
    setFinding("searching");
    const client = publicClient(cfg.rpcUrl, cfg.chainId);
    // warm the approval while we search — hides ~30-60s of setup time
    const allowanceReady = ensureAllowance(client, token, amount);
    allowanceReady.catch(() => {});
    let createdId: bigint | null = null;

    const sock = io(process.env.NEXT_PUBLIC_SERVER_URL ?? "", { transports: ["websocket"] });
    cashSock.current = sock;
    const bail = (msg: string | null) => {
      sock.close();
      cashSock.current = null;
      setFinding("idle");
      setFoundOpp(null);
      setMatchedStake(null);
      setStep("idle");
      if (msg) setError(msg);
    };
    // v: 2 — this client creates the match at the RESOLVED (lower) stake the
    // server sends in cash-matched, so the server may pair us within a stake
    // band and settle at the lower amount (P0-3).
    sock.on("connect", () => sock.emit("cash-queue", { address: account, stakeWei: amount.toString(), token, v: 2 }));
    sock.on("connect_error", () => bail("Network hiccup — please try again."));
    sock.on("cash-abort", async (m: { reason: string }) => {
      // our stake is already on the table? bring it home automatically —
      // a player must never have to hunt for a refund button
      if (createdId !== null) {
        const id = createdId;
        createdId = null;
        try {
          const ch = await sendWithStaleRetry("refund", () =>
            cancelMatch(wallet, { account, escrow: cfg.escrow, matchId: id, feeCurrency }),
          );
          await confirmTx(client, ch, "Refund");
          bail(`${m.reason} Your stake came back automatically.`);
        } catch {
          bail(`${m.reason} Auto-refund didn't go through — your stake is under Your matches.`);
        }
        return;
      }
      bail(m.reason);
    });
    sock.on("cash-matched", async (m: { role: "create" | "join"; opponent: Address; stakeWei?: string }) => {
      setFoundOpp(m.opponent);
      setFinding("pairing");
      // the server resolves the pair to the LOWER of the two stakes (P0-3);
      // fall back to our own amount for an older server that omits it
      const resolved = m.stakeWei ? BigInt(m.stakeWei) : amount;
      if (resolved !== amount) setMatchedStake(resolved); // show the final amount
      if (m.role !== "create") return; // joiner waits for cash-join
      try {
        await allowanceReady; // approved for our amount ≥ resolved, so it covers it
        createdId = await createOnChain(resolved);
        sock.emit("cash-created", { matchId: createdId.toString() });
        track("match_created");
        setStep("idle"); // board opens when the opponent's stake confirms
      } catch (e) {
        sock.emit("cash-failed", {});
        bail(null);
        fail(e);
      }
    });
    // the opponent's stake confirmed — table fully set, go play
    sock.on("cash-ready", (m: { matchId: string }) => {
      window.location.href = `/play?match=${m.matchId || createdId?.toString()}`;
    });
    sock.on("cash-join", async (m: { matchId: string; token?: Address; stakeWei?: string }) => {
      try {
        await allowanceReady; // warmed during the search
        setStep("staking");
        // token+stake come from the server — never read the seconds-old match
        // from a node that may not have seen it yet
        if (m.token && m.stakeWei) {
          await joinCashMatch({ wallet, account, cfg, matchId: BigInt(m.matchId), token: m.token, stake: BigInt(m.stakeWei), feeCurrency });
        } else {
          await joinOpenMatch({ wallet, account, cfg, matchId: BigInt(m.matchId), feeCurrency });
        }
        sock.emit("cash-joined", {});
        track("match_joined");
        window.location.href = `/play?match=${m.matchId}`;
      } catch (e) {
        sock.emit("cash-failed", {});
        bail(null);
        fail(e);
      }
    });
  }

  // fire the deep-linked rematch search once the panel is ready
  useEffect(() => {
    if (autoFind && adultOk && finding === "idle" && token) {
      setAutoFind(false);
      findOpponent();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFind, adultOk, token, stake]);

  function cancelFind() {
    cashSock.current?.emit("cash-cancel");
    cashSock.current?.close();
    cashSock.current = null;
    setFinding("idle");
    setFoundOpp(null);
  }

  async function onCreate() {
    if (!token || busy) return;
    setError(null);
    try {
      const amount = parseStake(stake, dec);
      if (amount <= 0n) return setError("Enter an amount greater than zero.");
      const min = floor();
      if (amount < min) return setError(`Minimum stake is ${fmt(min, dec)} ${sym}.`);
      if (balance !== null && amount > balance) return setError(`Not enough ${sym} — add money to MiniPay first.`);
      const client = publicClient(cfg.rpcUrl, cfg.chainId);

      const session = createSessionKey();
      await ensureAllowance(client, token, amount);
      setStep("staking");
      const hash = await createMatch(wallet, {
        account,
        escrow: cfg.escrow,
        token: token,
        stake: amount,
        session: session.address,
        feeCurrency: feeCurrency,
      });
      // The REAL match id comes from the receipt's MatchCreated event. It used
      // to be predicted by reading nextMatchId before sending — two creations
      // racing meant the number on screen (and in the shared invite!) could be
      // someone else's match, greeting both players with "not a player".
      // confirmTx, not viem's default waiter: lagging nodes made the default
      // throw while the stake had in fact landed ("fails 4 times out of 5").
      const receipt = await confirmTx(client, hash, "Your stake");
      const created = parseEventLogs({ abi: matchEscrowAbi, logs: receipt.logs, eventName: "MatchCreated" });
      const matchId = (created[0]?.args as { matchId?: bigint } | undefined)?.matchId;
      if (matchId === undefined) throw new Error("match created but its id couldn't be read — check Your matches");
      persistSession(matchId, session);
      recordLocalMatch(matchId);

      setTx(hash);
      setOpenId(matchId);
      setStep("done");
      track("match_created");
    } catch (e) {
      fail(e);
    }
  }

  async function onJoin() {
    if (!joinId || busy) return;
    setError(null);
    try {
      const matchId = BigInt(joinId);
      const client = publicClient(cfg.rpcUrl, cfg.chainId);
      const m = (await readContract(client, {
        address: cfg.escrow,
        abi: matchEscrowAbi,
        functionName: "getMatch",
        args: [matchId],
      })) as { token: Address; stake: bigint };

      const session = createSessionKey();
      persistSession(matchId, session);
      recordLocalMatch(matchId);

      await ensureAllowance(client, m.token, m.stake);
      setStep("staking");
      const hash = await joinMatch(wallet, {
        account,
        escrow: cfg.escrow,
        matchId,
        session: session.address,
        feeCurrency: feeCurrency,
      });
      // wait until mined, then go straight into the game: the joiner fills
      // the match — showing them the creator's "waiting for an opponent"
      // room (or reading the match pre-confirmation) was pure confusion.
      // confirmTx tolerates the lagging nodes the default waiter chokes on.
      await confirmTx(client, hash, "Your stake");
      track("match_joined");
      window.location.href = `/play?match=${matchId.toString()}`;
    } catch (e) {
      fail(e);
    }
  }

  function shareInvite() {
    if (openId === null) return;
    const url = `${window.location.origin}/play?match=${openId.toString()}`;
    const data = { title: "Awalé", text: `Join my Awalé match #${openId} for ${stake} ${sym}`, url };
    if (navigator.share) navigator.share(data).catch(() => {});
    else
      navigator.clipboard?.writeText(url).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
  }

  // payout preview
  const stakeRaw = (() => {
    try {
      return parseStake(stake || "0", dec);
    } catch {
      return 0n;
    }
  })();
  const { prize } = computePayout(stakeRaw, rakeBps ?? 0);

  // --- waiting room after a successful create/join ---
  if (step === "done" && openId !== null) {
    return (
      <div className="stack animate-in">
        {/* if the friend created their own room instead of joining ours,
            converge on the older match automatically */}
        <CrossMatchOffer myMatchId={openId} myStake={stakeRaw} wallet={wallet} account={account} cfg={cfg} feeCurrency={feeCurrency} />
        <div className="card stack" style={{ gap: 12, alignItems: "center", textAlign: "center" }}>
          <span className="chip positive">
            <span className="dot pulse" />
            Waiting for an opponent
          </span>
          <span className="display">Match #{openId.toString()}</span>
          <span className="muted">
            You each stake {fmt(stakeRaw, dec)} · winner takes {fmt(prize, dec)} {sym}
          </span>
        </div>
        <button className="btn block" onClick={shareInvite}>
          {copied ? "Link copied ✓" : "Invite an opponent"}
        </button>
        <Link className="btn secondary block" href={`/play?match=${openId.toString()}`}>
          Open match →
        </Link>
        {tx && (
          <a className="btn ghost block" href={receiptDeeplink(tx)}>
            View receipt
          </a>
        )}
      </div>
    );
  }

  return (
    <div className="stack">
      {/* Join first: if someone (your friend, most likely) already has a
          stake waiting, joining beats creating a second empty lobby */}
      {openToJoin.length > 0 && (
        <div className="card stack" style={{ gap: 8 }}>
          <span className="h2">Join an open match</span>
          {openToJoin.map((o) => {
            const { prize: oPrize } = computePayout(o.stake, o.rakeBps);
            return (
              <div className="row" key={o.id.toString()} style={{ gap: 8 }}>
                <span className="col" style={{ flex: 1, gap: 1 }}>
                  <span style={{ fontWeight: 700, fontSize: 14 }}>{friendlyName(o.creator)}</span>
                  <span className="faint">
                    Stake {fmt(o.stake, dec)} · winner takes {fmt(oPrize, dec)} {sym}
                  </span>
                </span>
                <button
                  className="btn"
                  style={{ padding: "8px 16px" }}
                  onClick={() => onJoinOpen(o.id)}
                  disabled={busy || joiningOpen !== null || !adultOk}
                >
                  {joiningOpen === o.id ? "Joining…" : "Join"}
                </button>
              </div>
            );
          })}
          <span className="faint" style={{ fontSize: 11.5, textAlign: "center" }}>
            or create your own below
          </span>
        </div>
      )}

      {/* Create */}
      <div className="card stack" style={{ gap: 12 }}>
        <div className="row">
          <span className="h2">Play for money</span>
          {balance !== null && (
            <span className="faint">
              Balance {fmt(balance, dec)} {sym}
            </span>
          )}
        </div>

        {/* preferred-stablecoin selector (shows when several are configured) */}
        {TOKENS.length > 1 && (
          <div className="row" style={{ gap: 6 }}>
            {TOKENS.map((t, i) => (
              <button
                key={t.address}
                className={`chip ${i === sel ? "positive" : ""}`}
                onClick={() => setSel(i)}
                style={{ cursor: "pointer", flex: 1, justifyContent: "center", padding: "8px 0" }}
              >
                {t.symbol}
              </button>
            ))}
          </div>
        )}

        {/* one decision: how much? — presets and the custom field share a line */}
        <div className="row" style={{ gap: 6 }}>
          {QUICK_STAKES.map((q) => (
            <button
              key={q}
              className={`chip ${stake === q ? "positive" : ""}`}
              onClick={() => setStake(q)}
              style={{ cursor: "pointer", minWidth: 52, justifyContent: "center", padding: "10px 0" }}
            >
              {q}
            </button>
          ))}
          <div className="row input" style={{ gap: 6, flex: 1, minWidth: 0 }}>
            <input
              value={stake}
              onChange={(e) => setStake(e.target.value)}
              inputMode="decimal"
              aria-label="Amount"
              style={{ background: "transparent", border: "none", color: "var(--text)", width: "100%", minWidth: 0, outline: "none" }}
            />
            <span className="muted" style={{ fontWeight: 700 }}>
              {sym}
            </span>
          </div>
        </div>

        {/* the whole deal in one quiet line — the app's single canonical money
            phrase ("you each stake X · winner takes Y"), mirroring
            MatchEscrow._payout; placeholder (never a made-up 0%) until the
            live rake is confirmed */}
        <span className="faint" style={{ textAlign: "center" }}>
          {rakeBps === null
            ? "Checking the winner's payout…"
            : `You each stake ${fmt(stakeRaw, dec)} · winner takes ${fmt(prize, dec)} ${sym} (fee ${rakePct(rakeBps)})`}
        </span>

        {alreadyOpen !== null && (
          <span className="muted" style={{ textAlign: "center", fontSize: 12.5 }}>
            Match #{alreadyOpen.toString()} is already waiting for an opponent —{" "}
            <Link href={`/play?match=${alreadyOpen.toString()}`} style={{ color: "var(--accent)" }}>
              share it instead?
            </Link>
          </span>
        )}

        {!adultOk && (
          <button
            className="list-row"
            onClick={confirmAdult}
            style={{ font: "inherit", textAlign: "left" }}
            aria-label="Confirm you are 18 or older"
          >
            <span className="chip" style={{ minWidth: 26, justifyContent: "center" }}>
              ☐
            </span>
            <span className="muted" style={{ flex: 1, fontSize: 12.5 }}>
              I&apos;m 18 or older and I only stake what I can afford to lose.
            </span>
          </button>
        )}

        {/* THE button: one tap, the server pairs you (with your friend
            searching at the same stake, most likely) and the two apps set
            the table between themselves — no lobby, no link, no number */}
        {finding === "idle" ? (
          <button className="btn block" onClick={findOpponent} disabled={busy || !token || !adultOk}>
            ⚡ Play for {stake || "0"} {sym} — find an opponent
          </button>
        ) : finding === "searching" ? (
          <button className="btn block" onClick={cancelFind}>
            <span className="dot pulse" /> Finding an opponent for {stake} {sym}… tap to cancel
          </button>
        ) : (
          <button className="btn block" disabled>
            {step === "approving"
              ? "Confirm in your wallet…"
              : step === "staking"
                ? "Placing your stake…"
                : matchedStake !== null
                  ? `Matched — you both play for ${fmt(matchedStake, dec)} ${sym} (the lower stake)`
                  : `Matched with ${foundOpp ? friendlyName(foundOpp) : "…"} — setting the table…`}
          </button>
        )}

        <button
          className="faint"
          onClick={onCreate}
          disabled={busy || !token || !adultOk || finding !== "idle"}
          style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12.5, alignSelf: "center" }}
        >
          Prefer a private table? Create a match &amp; share the invite
        </button>
        {tok?.faucet && (
          <button
            className="faint"
            onClick={onFaucet}
            disabled={busy}
            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12.5, alignSelf: "center" }}
          >
            Need test {sym}? Use the faucet
          </button>
        )}
      </div>

      {/* joining by number is the rare path (invites travel as links) — a
          quiet toggle, not a second form competing with "create" */}
      {showJoin ? (
        <div className="row animate-in" style={{ gap: 8 }}>
          <input
            className="input"
            value={joinId}
            onChange={(e) => setJoinId(e.target.value)}
            inputMode="numeric"
            placeholder="Match #"
            aria-label="Match id"
            style={{ flex: 1 }}
          />
          <button className="btn secondary" onClick={onJoin} disabled={busy || !joinId || !adultOk}>
            Join
          </button>
        </div>
      ) : (
        <button
          className="faint"
          onClick={() => setShowJoin(true)}
          style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12.5, alignSelf: "center" }}
        >
          Got a match number? Join it
        </button>
      )}

      {error && (
        <div className="chip danger" style={{ alignSelf: "stretch", justifyContent: "center", padding: "10px" }}>
          {error}
        </div>
      )}
    </div>
  );
}

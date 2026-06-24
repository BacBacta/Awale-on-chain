# 🔐 Security Review — Awale-on-chain

---

## Scope

|                                  |                                                        |
| -------------------------------- | ------------------------------------------------------ |
| **Mode**                         | default (all in-scope `.sol`)                          |
| **Files reviewed**               | `AwaleRules.sol` · `Cosmetics.sol` · `HarvestVault.sol`<br>`MatchEscrow.sol` · `ReplayVerifier.sol` · `TournamentEscrow.sol`<br>`Treasury.sol` |
| **Confidence threshold (1-100)** | 80                                                     |
| **Agents**                       | 12 (Opus) — math, access-control, economics, execution-trace, invariant, periphery, first-principles, asymmetry, boundary, numerical-gap, trust-gap, flow-gap |

---

## Findings

[90] **1. A losing player can void a legitimately proposed result via `voidExpired` during the open challenge window**

`MatchEscrow.voidExpired` · Confidence: 90 · [agents: 6]

**Description**
`voidExpired` accepts a `Proposed` match gated only on `block.timestamp > activeDeadline`, while `finalize` is gated on the later `challengeDeadline = proposeTime + challengeWindow`; a result proposed near `activeDeadline` therefore sits in the interval `(activeDeadline, challengeDeadline]` where the **loser can call `voidExpired` to refund both stakes before the winner can `finalize`**, nullifying a legitimate win (the loser can force this reliably by stalling off-chain play until the TTL nears). Demonstrated by the project's own test `test_voidExpired_worksOnProposedExpiredMatch`.

**Fix**

```diff
 function voidExpired(uint256 matchId) external nonReentrant {
     Match storage m = matches[matchId];
     require(m.status == Status.Active || m.status == Status.Proposed, "MatchEscrow: not active or proposed");
     require(msg.sender == m.player0 || msg.sender == m.player1, "MatchEscrow: not a player");
-    require(block.timestamp > m.activeDeadline, "MatchEscrow: not expired");
+    // a Proposed result must not be voidable while its challenge window is still open
+    require(block.timestamp > m.activeDeadline, "MatchEscrow: not expired");
+    require(m.status == Status.Active || block.timestamp > m.challengeDeadline, "MatchEscrow: challenge open");
     _void(matchId, m);
 }
```

---

[85] **2. Self-void escape: a loser commits to a non-terminal transcript prefix and challenges their own proposal to force a refund**

`MatchEscrow.challenge` · Confidence: 85 · [agents: 3]

**Description**
`challenge` lets *either* player call it, and its non-terminal branch voids (refunds both) whenever the submitted transcript hashes to the proposer's `transcriptCommitment` — but nothing forces that commitment to bind a *terminal* game, so a losing player can `proposeResult(winner=self, commitment=hash(non-terminal prefix of the real, validly-signed game))` and then `challenge(thatPrefix)` themselves in the same block → `_void` → both stakes refunded, escaping the loss atomically (no waiting, the prefix is fully signed from normal play). The commitment guard was designed to stop a *challenger* from forging a partial proof, but does nothing to stop the *proposer* committing to a partial transcript in the first place.

**Fix**

```diff
 function challenge(uint256 matchId, ReplayVerifier.Transcript calldata t) external nonReentrant {
     Match storage m = matches[matchId];
     require(msg.sender == m.player0 || msg.sender == m.player1, "MatchEscrow: not a player");
     require(m.status == Status.Proposed, "MatchEscrow: not proposed");
     ...
     } else {
         require(
             verifier.transcriptHash(t.matchId, t.startTurn, t.moves) == m.transcriptCommitment,
             "MatchEscrow: transcript mismatch"
         );
+        // the proposer cannot void their own proposal with a self-committed
+        // non-terminal prefix; only the opponent may force the premature-proposal void
+        require(msg.sender != _proposer(m), "MatchEscrow: proposer cannot self-void");
         _void(matchId, m);
     }
 }
```
*(Alternative, stronger: require `proposeResult`'s commitment to be the terminal transcript hash, so a non-terminal proposal can never be created.)*

---

Findings List

| # | Confidence | Title |
|---|---|---|
| 1 | [90] | Loser voids a legit proposed result in the open challenge window (`voidExpired`) |
| 2 | [85] | Self-void escape via non-terminal commitment (`challenge`) |

---

## Leads

_Vulnerability trails with concrete code smells where the full exploit path could not be completed in one pass. Not false positives — high-signal leads for manual review. Not scored._

- **No-loss breaks first-come-first-served under market loss** — `HarvestVault.claimPrincipal/finalize` — Code smells: when `redeemed < totalPrincipal`, `yieldPot` clamps to 0 but each depositor still claims full principal from a now-insufficient balance; last claimers revert. Documented as external market risk (§13), but the loss falls entirely on the slowest claimers rather than pro-rata — confirm intent. *[agents: 5]*
- **Weak first-move randomness** — `MatchEscrow.finalizeStart` — Code smells: `startTurn = keccak256(blockhash(joinBlock+1), matchId) & 1`; the reveal-block proposer can withhold/choose their block to bias the first-move coin flip. Known PoS tradeoff, not a fund-theft path, but first-mover advantage is real on staked matches. *[agents: 4]*
- **Operator can divert real finishers' prizes to Treasury** — `TournamentEscrow.finalize` — Code smells: no check ties `winners.length` to the field size, so the operator can submit fewer winners than payout places; the unpaid places sweep to Treasury via `pool - distributed`. Self-dealing iff operator == Treasury owner (unverified). *[agents: 2]*
- **Off-chain/on-chain rules divergence risk** — `AwaleRules._capture` — Code smells: grand-slam guard compares the contiguous 2/3 capture run against the full opponent-row total; byte-identical agreement with the off-chain TypeScript engine is unverified and any divergence breaks the replay-dispute guarantee. Needs a differential test. *[agents: 2]*
- **`createSeason` accepts an already-closed deposit window** — `HarvestVault.createSeason` — Code smells: requires `depositDeadline < seasonEnd` and `seasonEnd > now` but never `depositDeadline > now`; owner can brick a season's deposits. Owner-only misconfig. *[agents: 1]*
- **Unbounded `refundWindow` / no lower-bound `joinWindow`** — `TournamentEscrow.createTournament` — Code smells: operator can set a far-future `refundDeadline`, locking entrants' fees until then if it never `finalize`s. Bounded by the operator trust model. *[agents: 1]*
- **Rake rounds to zero on dust stakes** — `MatchEscrow._payout` — Code smells: `rake = pot*rakeBps/BPS` truncates to 0 for tiny stakes when `minStake` is unset (default 0); self-inflicted config, no party cheated. Mitigated by the `minStake` floor. *[agents: 1]*

---

> ⚠️ This review was performed by AI agents. AI analysis can never verify the complete absence of vulnerabilities and no guarantee of security is given. An independent human security review and a bug-bounty program are strongly recommended before mainnet / real-money launch.

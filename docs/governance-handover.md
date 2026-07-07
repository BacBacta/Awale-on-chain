# Governance handover runbook (L-02)

Moves control of every privileged contract from the single hot operator key to a
**timelock + Safe multisig**, so no one key can seize funds or change parameters.
Run once, at mainnet, when a Safe exists on Celo mainnet (Safe does not support
Celo Sepolia, so there is no testnet rehearsal — the flow is proven by
`Govern.t.sol`, 4 tests).

## What it changes

| Contract | Privileged surface that becomes governed |
|---|---|
| MatchEscrow | rake, treasury, token allowlist, TTLs, challenge window |
| Treasury | withdrawals of accrued rake |
| WeeklyPrizes | publishRound (the weekly root), sweep |
| Cosmetics | ownerMint, config |

After handover, each of these needs: multisig **schedule** → **delay** (2 days)
→ multisig **execute**. The server's hot key keeps only its *operational* role
(signing settlements, publishing race roots as a REQUESTER where applicable) —
it can no longer touch funds or parameters.

## Prerequisites

1. A **Safe** on Celo mainnet (e.g. 2-of-3 or 3-of-5, keys on separate devices).
2. The operator key still owns all four contracts (it does).
3. Decide `TIMELOCK_DELAY` (default **2 days** — long enough to react to a
   malicious scheduled op, short enough for real ops).

## Run

```bash
cd contracts
ESCROW_ADDRESS=<MatchEscrow>        \
TREASURY_ADDRESS=<Treasury>         \
WEEKLY_PRIZES_ADDRESS=<WeeklyPrizes> \
COSMETICS_ADDRESS=<Cosmetics>       \
MULTISIG=<Safe address>             \
TIMELOCK_DELAY=172800               \
PRIVATE_KEY=<operator>              \
forge script script/Govern.s.sol --rpc-url $CELO_RPC --broadcast
```

It deploys one `TimelockController` (the Safe is its sole proposer + executor,
`admin=address(0)` so the timelock self-administers) and transfers all four
ownerships to it. The two optional addresses are skipped if unset.

## Verify after

```bash
for C in $ESCROW_ADDRESS $TREASURY_ADDRESS $WEEKLY_PRIZES_ADDRESS $COSMETICS_ADDRESS; do
  cast call $C 'owner()(address)' --rpc-url $CELO_RPC   # → the timelock
done
```

- Confirm each `owner()` is the timelock.
- Confirm a direct admin call from the old operator now reverts.
- Confirm the Safe can schedule → (after delay) execute a no-op param change.

## Ongoing operations after handover

- **Change a parameter** (rake, unlock the Season post-audit, set the yield fee,
  etc.): the Safe schedules the call on the target contract, waits the delay,
  then executes. Publish the intended change so it can be reviewed during the
  window.
- **The keeper still runs** unprivileged: settling matches, `finalizeStart`,
  `voidExpired`, and the WeeklyPrizes flow are permissionless or requester-gated,
  not owner-gated — so day-to-day play is unaffected by the timelock.

## What is NOT covered

- `ReplayVerifier` is **immutable** (no owner) — nothing to hand over.
- The **operator/server signer** stays a hot EOA by necessity (it signs live
  settlements). Governance protects funds + parameters; it does not — and should
  not — put settlement behind a 2-day delay.

# Scaffolds: VRF first-mover & ODIS names

Two mainnet integrations are **scaffolded** — the logic is written and tested;
only the external service (a VRF subscription / an ODIS quota + signer) is
plugged in at mainnet. Neither is wired into the live path yet, so testnet is
unaffected.

## 1. VRF first-mover — `contracts/src/VRFFirstMover.sol` — **SUPERSEDED**

> **This scaffold cannot be activated, and is no longer the plan.** Chainlink
> VRF is not available on Celo (Celo's Chainlink docs cover CCIP only, and Celo
> is absent from Chainlink's VRF v2.5 supported-network list); Supra's dVRF
> lists Celo **testnet** only. There is no production VRF on Celo mainnet, so
> the activation steps below cannot be carried out.
>
> The first-move flip is instead settled by a **two-party commit–reveal** in
> `MatchEscrow`, which needs no oracle: each player commits `keccak256(secret)`
> in the transaction that already stakes them (create / join), and the flip is
> `keccak(secret0, secret1, matchId)`. Neither side can steer it — player 0
> commits before an opponent exists, and player 1 commits without seeing
> secret0 — and there is no window to expire, so it does not depend on keeper
> liveness the way the old blockhash flip did. The contract is the reference;
> `packages/game-server/src/flip-reveal.ts` collects the pair.
>
> `VRFFirstMover.sol` is kept only as a reference implementation should a VRF
> service ship on Celo mainnet later.

The original (now historical) rationale — replacing the blockhash flip with a
Chainlink VRF v2.5 bit no participant or sequencer can bias:

- **What's done:** the full consumer — `requestFirstMover(matchId)` (requester-
  gated, one per match), `rawFulfillRandomWords` (coordinator-gated, idempotent),
  `firstMover(matchId)` / `isFixed`. Owner config for keyHash / subId / gas.
  Minimal VRF v2.5 interface inlined so it compiles with no Chainlink dependency.
  7 unit tests against a mock coordinator (request→fulfil, even/odd → 0/1,
  auth, one-per-match, revert-until-fixed, duplicate-fulfil ignored).
- **To activate (mainnet):**
  1. Swap the inlined `IVRFCoordinatorV2Plus` for the real `VRFConsumerBaseV2Plus`
     + `VRFV2PlusClient` from `chainlink/contracts`.
  2. Create + fund a VRF v2.5 subscription; deploy via
     `script/DeployVRFFirstMover.s.sol` (env: `VRF_COORDINATOR`, `VRF_KEYHASH`,
     `VRF_SUB_ID`); add the contract as a subscription consumer.
  3. `setRequester(keeper, true)`.
  4. In MatchEscrow **v-next**: `finalizeStart` calls `requestFirstMover` and the
     game opens only once `isFixed` — reading `firstMover` in place of the
     blockhash. (The escrow change is deliberately deferred: it's a redeploy, and
     the audit judged the current flip acceptable for a low-stakes single bit.)

## 2. ODIS names — `packages/game-server/src/identity/odis.ts`

`createOdisResolver` used to `throw`. It now returns a **fully-implemented**
`NameResolver` (phone→address via ODIS obfuscation + FederatedAttestations, and
the presence of attestations as a "verified phone" signal). The external
`@celo/identity` plumbing is injected via the `OdisDeps` interface, so the
resolver logic is unit-tested without bundling the heavy SDK (useless anyway
without a funded quota + backend signer).

- **What's done:** the resolver algorithm + graceful degradation (a lookup
  failure → absent name, never a throw). 3 unit tests with mock deps.
- **To activate (mainnet):** provide a real `OdisDeps` wired to `@celo/identity`
  (`OdisUtils.Identifier.getObfuscatedIdentifier` for `obfuscate`, the
  `FederatedAttestations` contract at `ODIS_CONFIG` for the lookups), fund ODIS
  PnP quota (`OdisPayments.payInCUSD`), and keep the signer server-side. The
  exact wiring is documented inline above the `OdisDeps` interface. Until then,
  the app keeps using generated display names (`friendlyName`) as it does today.

# Sample transactions — MatchEscrow v4 (Celo Sepolia)

Real end-to-end money flow on the live v4 escrow, for the MiniPay listing intake
(which asks for verified contracts + sample tx hashes). One full match, settled
by the happy path: two players stake 1 aUSD each, the winner is paid the pot
minus the 11% rake, and the rake routes to the Treasury.

**Contracts**
- MatchEscrow v4 — [`0x34473d4b1dD93314b13605277681b4202C55c4E8`](https://celo-sepolia.blockscout.com/address/0x34473d4b1dD93314b13605277681b4202C55c4E8)
- ReplayVerifier v2 — [`0xF6B27BBDe627eD9f241C3017aCa33bb472064395`](https://celo-sepolia.blockscout.com/address/0xF6B27BBDe627eD9f241C3017aCa33bb472064395)
- Stake token (aUSD) — `0x890b3c804B34BAFf233A227099645cb2EA4434eB`

**Match #1 — stake 1 aUSD/side, winner = player0**

| Step | Actor | Tx |
|---|---|---|
| `createMatch(aUSD, 1e18, session0)` | player0 | [`0xaf08581c…aafbba6b`](https://celo-sepolia.blockscout.com/tx/0xaf08581c2220e0bca404f3f18480cb6eb8f876ee9ec57e5301c59148aafbba6b) |
| `joinMatch(1, session1)` | player1 | [`0x9632b133…d45f468545`](https://celo-sepolia.blockscout.com/tx/0x9632b13358a4e1b88f5bb910993070ced569b81588be9dc80b0e2dd45f468545) |
| `finalizeStart(1)` — first-mover flip | **server keeper** (auto) | [`0x6b161e11…c43b1292d2`](https://celo-sepolia.blockscout.com/tx/0x6b161e11e5923a7b88cd3c8d1a8358740adc734fd7f1e6d6136266c43b1292d2) |
| `settleSigned(1, 0, sig0, sig1)` | either | [`0xd2c52f8c…ce8504ace`](https://celo-sepolia.blockscout.com/tx/0xd2c52f8cf7c49b71da067fb69d07dca4d4f1a122df1d3f996347870ce8504ace) |

Notes:
- **The keeper auto-finalized the start.** `joinMatch` armed the reveal block;
  the game server's `MatchJoined` listener called `finalizeStart` a few blocks
  later without any prompting — evidence the live off-chain infra is running.
- **Settlement is exact.** After `settleSigned` the escrow's aUSD balance is
  `0` (no stuck dust): the 2 aUSD pot split into 1.78 to the winner and 0.22
  (11%) to the Treasury.
- All txs are **legacy (type 0)** — Celo has no `baseFeePerGas`, so viem emits
  legacy txs by default, which is what MiniPay expects.

Regenerate with `scratchpad/sample-match3.sh` (fresh random keys — never reuse
well-known test keys on a public testnet; sweeper bots drain them on arrival).

## Match #1 on v6 — staked friend match (invite-locked)

Proves the v6 friend-stakes path end-to-end on Celo Sepolia: an invite-locked
match rejects strangers, the friend with the link's code joins and wins, and the
11% rake routes to the Treasury exactly as any money match.

- MatchEscrow v6 — `0x6b118F89cf54FFf83A635f188e3ad8d4AaAA8613`

| Step | Actor | Tx |
|---|---|---|
| `createMatchWithInvite` (seat locked to keccak(code)) | operator | [`0xeb4fff16…c872669fcb`](https://celo-sepolia.blockscout.com/tx/0xeb4fff161466462a146cd48153c93e37737472263de765d52fc543c872669fcb) |
| `joinMatchWithCode` (fresh non-owner friend, with the code) | friend | [`0xb86c11d2…b7aeb2a61`](https://celo-sepolia.blockscout.com/tx/0xb86c11d2fe01a36b5cb874514d998e32212a7901c065cd9c1e75170b7aeb2a61) |
| `settleSigned` (winner = friend) | either | [`0x9b970479…10ccaa7c0`](https://celo-sepolia.blockscout.com/tx/0x9b970479c8f58e3087f716b5b4bab55bc77297f879979e74e2dfb3710ccaa7c0) |

Verified on-chain: a stranger's `joinMatch` reverts `invite only` and a wrong
code reverts `bad invite code`; escrow drains to 0; the friend (a fresh
non-owner wallet) receives 1.78 aUSD; the Treasury takes 0.22 aUSD (11% of the
2 aUSD pot). Regenerate with `scratchpad/friend-e2e2.sh` (fresh keys, explicit
operator nonces, `--legacy --gas-price $(cast gas-price)` — forno's estimate
doubles the real price, and its load-balanced reads lag right after a mine, so
read `nextMatchId` from the MatchCreated event, not a bare call).

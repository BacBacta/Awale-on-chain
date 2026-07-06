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

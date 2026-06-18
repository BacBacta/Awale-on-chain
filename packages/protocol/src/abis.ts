// Minimal ABIs the mini-app and server need. Kept hand-written and small so the
// front-end bundle stays light.

export const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

export const matchEscrowAbi = [
  {
    type: "function",
    name: "createMatch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "stake", type: "uint128" },
      { name: "session0", type: "address" },
    ],
    outputs: [{ name: "matchId", type: "uint256" }],
  },
  {
    type: "function",
    name: "joinMatch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "matchId", type: "uint256" },
      { name: "session1", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "settleSigned",
    stateMutability: "nonpayable",
    inputs: [
      { name: "matchId", type: "uint256" },
      { name: "winner", type: "uint8" },
      { name: "sig0", type: "bytes" },
      { name: "sig1", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "nextMatchId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "event",
    name: "MatchJoined",
    inputs: [
      { name: "matchId", type: "uint256", indexed: true },
      { name: "player1", type: "address", indexed: true },
      { name: "startTurn", type: "uint8", indexed: false },
    ],
  },
] as const;

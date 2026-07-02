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
    type: "function",
    name: "rakeBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint16" }],
  },
  {
    type: "function",
    name: "minStake",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint128" }],
  },
  {
    type: "function",
    name: "getMatch",
    stateMutability: "view",
    inputs: [{ name: "matchId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
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
        ],
      },
    ],
  },
  {
    type: "function",
    name: "finalizeStart",
    stateMutability: "nonpayable",
    inputs: [{ name: "matchId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "proposeResult",
    stateMutability: "nonpayable",
    inputs: [
      { name: "matchId", type: "uint256" },
      { name: "winner", type: "uint8" },
      { name: "commitment", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "challenge",
    stateMutability: "nonpayable",
    inputs: [
      { name: "matchId", type: "uint256" },
      {
        name: "t",
        type: "tuple",
        components: [
          { name: "matchId", type: "uint256" },
          { name: "session0", type: "address" },
          { name: "session1", type: "address" },
          { name: "startTurn", type: "uint8" },
          { name: "moves", type: "uint8[]" },
          { name: "sigs", type: "bytes[]" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "finalize",
    stateMutability: "nonpayable",
    inputs: [{ name: "matchId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "event",
    name: "ResultProposed",
    inputs: [
      { name: "matchId", type: "uint256", indexed: true },
      { name: "winner", type: "uint8", indexed: false },
      { name: "challengeDeadline", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "MatchJoined",
    inputs: [
      { name: "matchId", type: "uint256", indexed: true },
      { name: "player1", type: "address", indexed: true },
      { name: "revealBlock", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "StartFinalized",
    inputs: [
      { name: "matchId", type: "uint256", indexed: true },
      { name: "startTurn", type: "uint8", indexed: false },
    ],
  },
  {
    type: "event",
    name: "MatchSettled",
    inputs: [
      { name: "matchId", type: "uint256", indexed: true },
      { name: "winner", type: "uint8", indexed: false },
      { name: "prize", type: "uint256", indexed: false },
    ],
  },
] as const;

// TournamentEscrow: entry-fee Sit-and-Go custody. The client reads/joins; the
// server operator finalises standings.
export const tournamentEscrowAbi = [
  {
    type: "function",
    name: "join",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "finalize",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "winners", type: "address[]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getTournament",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          { name: "entryFee", type: "uint128" },
          { name: "prizePool", type: "uint128" },
          { name: "sponsored", type: "uint128" },
          { name: "maxPlayers", type: "uint32" },
          { name: "playerCount", type: "uint32" },
          { name: "cutBps", type: "uint16" },
          { name: "status", type: "uint8" },
          { name: "joinDeadline", type: "uint64" },
          { name: "refundDeadline", type: "uint64" },
          { name: "creator", type: "address" },
          { name: "payoutBps", type: "uint16[]" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "prizeBreakdown",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      { name: "pool", type: "uint256" },
      { name: "cut", type: "uint256" },
      { name: "prizes", type: "uint256[]" },
    ],
  },
  {
    type: "function",
    name: "nextTournamentId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "event",
    name: "Joined",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "player", type: "address", indexed: true },
      { name: "playerCount", type: "uint32", indexed: false },
    ],
  },
] as const;

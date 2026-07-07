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
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
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
    // v6: friend-link stake match — the seat is reserved for whoever holds the
    // link's secret code (hash committed at create). Same lifecycle otherwise.
    type: "function",
    name: "createMatchWithInvite",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "stake", type: "uint128" },
      { name: "session0", type: "address" },
      { name: "inviteHash", type: "bytes32" },
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
    name: "joinMatchWithCode",
    stateMutability: "nonpayable",
    inputs: [
      { name: "matchId", type: "uint256" },
      { name: "session1", type: "address" },
      { name: "code", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    // 0x0 for a normal open match; non-zero marks an invite-locked seat
    type: "function",
    name: "inviteHash",
    stateMutability: "view",
    inputs: [{ name: "matchId", type: "uint256" }],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "cancelMatch",
    stateMutability: "nonpayable",
    inputs: [{ name: "matchId", type: "uint256" }],
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
    // v7: proposeResult proves a terminal transcript on-chain (no more asserted
    // winner + attacker-chosen commitment)
    type: "function",
    name: "proposeResult",
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
    // v7 forfeit clock: prove it's the opponent's turn on a live game
    type: "function",
    name: "proposeForfeit",
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
    // v7 forfeit clock: answer with the accused's next signed move (prefix + 1)
    type: "function",
    name: "rebutForfeit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "matchId", type: "uint256" },
      {
        name: "t2",
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
    // v7 forfeit clock: window elapsed with no rebuttal -> claimant wins the pot
    type: "function",
    name: "finalizeForfeit",
    stateMutability: "nonpayable",
    inputs: [{ name: "matchId", type: "uint256" }],
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
    type: "function",
    name: "voidExpired",
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
    name: "ForfeitProposed",
    inputs: [
      { name: "matchId", type: "uint256", indexed: true },
      { name: "claimant", type: "uint8", indexed: false },
      { name: "forfeitPly", type: "uint32", indexed: false },
      { name: "deadline", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ForfeitRebutted",
    inputs: [
      { name: "matchId", type: "uint256", indexed: true },
      { name: "forfeitPly", type: "uint32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "MatchCreated",
    inputs: [
      { name: "matchId", type: "uint256", indexed: true },
      { name: "player0", type: "address", indexed: true },
      { name: "token", type: "address", indexed: false },
      { name: "stake", type: "uint128", indexed: false },
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
    name: "createTournament",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "entryFee", type: "uint128" },
      { name: "maxPlayers", type: "uint32" },
      { name: "cutBps", type: "uint16" },
      { name: "joinWindow", type: "uint64" },
      { name: "refundWindow", type: "uint64" },
      { name: "payoutBps", type: "uint16[]" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
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

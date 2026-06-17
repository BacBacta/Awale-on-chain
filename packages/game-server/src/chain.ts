// On-chain settlement client (integration layer).
//
// Wraps the MatchEscrow calls the server makes with viem. Every transaction sets
// `feeCurrency` so the network fee is paid in a stablecoin (CIP-64) — viem is the
// only SDK that exposes this natively, which is why it is mandated here. The
// server signer's key lives server-side only.
//
// This module talks to a live chain, so it is exercised in integration/e2e, not
// in unit tests.

import {
  createWalletClient,
  createPublicClient,
  http,
  type Account,
  type Address,
  type Hex,
} from "viem";
import { celo } from "viem/chains";
import type { Transcript } from "./match.js";

const escrowAbi = [
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
    name: "proposeResult",
    stateMutability: "nonpayable",
    inputs: [
      { name: "matchId", type: "uint256" },
      { name: "winner", type: "uint8" },
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
] as const;

export interface SettlementClientOptions {
  rpcUrl: string;
  escrow: Address;
  account: Account;
  /** feeCurrency adapter address paid for the network fee (CIP-64). */
  feeCurrency?: Address;
}

export class SettlementClient {
  private readonly wallet;
  private readonly publicClient;
  private readonly escrow: Address;
  private readonly feeCurrency?: Address;

  constructor(opts: SettlementClientOptions) {
    this.escrow = opts.escrow;
    this.feeCurrency = opts.feeCurrency;
    this.wallet = createWalletClient({ account: opts.account, chain: celo, transport: http(opts.rpcUrl) });
    this.publicClient = createPublicClient({ chain: celo, transport: http(opts.rpcUrl) });
  }

  /** Happy path: both session keys signed the result. */
  settleSigned(matchId: bigint, winner: number, sig0: Hex, sig1: Hex): Promise<Hex> {
    return this.wallet.writeContract({
      address: this.escrow,
      abi: escrowAbi,
      functionName: "settleSigned",
      args: [matchId, winner, sig0, sig1],
      feeCurrency: this.feeCurrency,
    });
  }

  /** Abandonment/refusal: claim a result and open the challenge window. */
  proposeResult(matchId: bigint, winner: number): Promise<Hex> {
    return this.wallet.writeContract({
      address: this.escrow,
      abi: escrowAbi,
      functionName: "proposeResult",
      args: [matchId, winner],
      feeCurrency: this.feeCurrency,
    });
  }

  /** Pay out a proposed result once its challenge window has elapsed. */
  finalize(matchId: bigint): Promise<Hex> {
    return this.wallet.writeContract({
      address: this.escrow,
      abi: escrowAbi,
      functionName: "finalize",
      args: [matchId],
      feeCurrency: this.feeCurrency,
    });
  }

  /** Dispute path: submit the full signed transcript for on-chain replay. */
  challenge(transcript: Transcript): Promise<Hex> {
    return this.wallet.writeContract({
      address: this.escrow,
      abi: escrowAbi,
      functionName: "challenge",
      args: [
        transcript.matchId,
        {
          matchId: transcript.matchId,
          session0: transcript.session0,
          session1: transcript.session1,
          startTurn: transcript.startTurn,
          moves: transcript.moves,
          sigs: transcript.sigs,
        },
      ],
      feeCurrency: this.feeCurrency,
    });
  }

  waitForReceipt(hash: Hex) {
    return this.publicClient.waitForTransactionReceipt({ hash });
  }
}

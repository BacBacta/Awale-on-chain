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
  encodeAbiParameters,
  keccak256,
  type Account,
  type Address,
  type Hex,
  fallback,
} from "viem";
import { celo, celoSepolia, celoAlfajores } from "viem/chains";
import type { Transcript } from "./match.js";

/** Resolve the viem chain for a deployment's chain id — the wallet client
 *  signs the chain id into every transaction, so a mismatch (e.g. mainnet
 *  hardcoded while deployed on Sepolia) gets every server write rejected
 *  with "invalid chain ID". The return type stays a union of Celo chains so
 *  viem keeps the Celo tx formatters (feeCurrency support). */
function chainFor(id: number): typeof celo | typeof celoSepolia | typeof celoAlfajores {
  if (id === celoSepolia.id) return celoSepolia;
  if (id === celoAlfajores.id) return celoAlfajores;
  return celo;
}

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
      { name: "commitment", type: "bytes32" },
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
    name: "voidExpired",
    stateMutability: "nonpayable",
    inputs: [{ name: "matchId", type: "uint256" }],
    outputs: [],
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
  /** Backup RPC endpoints — the settlement path (finalize/void/settleSigned)
   *  must not die with a single flaky node. */
  fallbackRpcUrls?: string[];
  escrow: Address;
  account: Account;
  /** feeCurrency adapter address paid for the network fee (CIP-64). */
  feeCurrency?: Address;
  /** Deployment chain id (defaults to Celo mainnet). MUST match the RPC —
   *  the signed transaction carries it. */
  chainId?: number;
}

export class SettlementClient {
  private readonly wallet;
  private readonly publicClient;
  private readonly escrow: Address;
  private readonly feeCurrency?: Address;

  constructor(opts: SettlementClientOptions) {
    this.escrow = opts.escrow;
    this.feeCurrency = opts.feeCurrency;
    const chain = chainFor(opts.chainId ?? celo.id);
    const backups = (opts.fallbackRpcUrls ?? []).filter((u) => u && u !== opts.rpcUrl);
    const transport = backups.length
      ? fallback([http(opts.rpcUrl, { timeout: 20_000, retryCount: 1 }), ...backups.map((u) => http(u, { timeout: 15_000, retryCount: 1 }))])
      : http(opts.rpcUrl);
    this.wallet = createWalletClient({ account: opts.account, chain, transport });
    this.publicClient = createPublicClient({ chain, transport });
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
  proposeResult(matchId: bigint, winner: number, transcript: Transcript): Promise<Hex> {
    // Must match ReplayVerifier.transcriptHash: keccak256(abi.encode(matchId, startTurn, moves))
    const commitment = keccak256(
      encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint8" }, { type: "uint8[]" }],
        [matchId, transcript.startTurn, transcript.moves],
      ),
    );
    return this.wallet.writeContract({
      address: this.escrow,
      abi: escrowAbi,
      functionName: "proposeResult",
      args: [matchId, winner, commitment],
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

  /** Refund both stakes from a match that was never settled (past its TTL). */
  voidExpired(matchId: bigint): Promise<Hex> {
    return this.wallet.writeContract({
      address: this.escrow,
      abi: escrowAbi,
      functionName: "voidExpired",
      args: [matchId],
      feeCurrency: this.feeCurrency,
    });
  }

  /** Fix a joined match's first mover from its reveal block's hash. */
  finalizeStart(matchId: bigint): Promise<Hex> {
    return this.wallet.writeContract({
      address: this.escrow,
      abi: escrowAbi,
      functionName: "finalizeStart",
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

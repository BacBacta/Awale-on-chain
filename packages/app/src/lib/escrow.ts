// MatchEscrow interactions from the mini-app. Every write sets `feeCurrency` so
// the network fee is paid in the user's stablecoin (CIP-64) — never CELO.

import { parseUnits, type Address, type Hex } from "viem";
import { matchEscrowAbi, erc20Abi } from "../../../protocol/src/abis.js";

/** Narrow write surface satisfied by a viem WalletClient (cast at the call site). */
export interface WriteClient {
  writeContract(req: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
    account: Address;
    feeCurrency?: Address;
  }): Promise<Hex>;
}

export interface EscrowConfig {
  chainId: number;
  escrow: Address;
  verifier: Address;
  rpcUrl: string;
}

/** Read the deployed-contract wiring from NEXT_PUBLIC_* env (null if unset). */
export function escrowConfig(): EscrowConfig | null {
  const escrow = process.env.NEXT_PUBLIC_ESCROW_ADDRESS;
  const verifier = process.env.NEXT_PUBLIC_VERIFIER_ADDRESS;
  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;
  const chainId = process.env.NEXT_PUBLIC_CHAIN_ID;
  if (!escrow || !verifier || !rpcUrl || !chainId) return null;
  return { chainId: Number(chainId), escrow: escrow as Address, verifier: verifier as Address, rpcUrl };
}

/** Convert a human stake (e.g. "2.5") to base units for the token's decimals. */
export function parseStake(human: string, decimals: number): bigint {
  return parseUnits(human as `${number}`, decimals);
}

export function approve(
  wallet: WriteClient,
  p: { account: Address; token: Address; spender: Address; amount: bigint; feeCurrency?: Address },
): Promise<Hex> {
  return wallet.writeContract({
    address: p.token,
    abi: erc20Abi,
    functionName: "approve",
    args: [p.spender, p.amount],
    account: p.account,
    feeCurrency: p.feeCurrency,
  });
}

export function createMatch(
  wallet: WriteClient,
  p: { account: Address; escrow: Address; token: Address; stake: bigint; session: Address; feeCurrency?: Address },
): Promise<Hex> {
  return wallet.writeContract({
    address: p.escrow,
    abi: matchEscrowAbi,
    functionName: "createMatch",
    args: [p.token, p.stake, p.session],
    account: p.account,
    feeCurrency: p.feeCurrency,
  });
}

export function joinMatch(
  wallet: WriteClient,
  p: { account: Address; escrow: Address; matchId: bigint; session: Address; feeCurrency?: Address },
): Promise<Hex> {
  return wallet.writeContract({
    address: p.escrow,
    abi: matchEscrowAbi,
    functionName: "joinMatch",
    args: [p.matchId, p.session],
    account: p.account,
    feeCurrency: p.feeCurrency,
  });
}

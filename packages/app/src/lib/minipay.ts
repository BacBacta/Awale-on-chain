// MiniPay connection. Inside MiniPay the wallet is injected and auto-connects:
// no "Connect Wallet" button. We never request message signing from the wallet
// (MiniPay forbids it); all signing is done with per-match session keys.

import { createWalletClient, createPublicClient, custom, http, type Address, type Chain, type WalletClient } from "viem";
import { celo, celoSepolia, celoAlfajores } from "viem/chains";

/** Resolve the viem chain for a chainId (the wallet client's chain must match
 *  the wallet's network, or writeContract throws a ChainMismatchError). */
export function chainById(id: number): Chain {
  if (id === celoSepolia.id) return celoSepolia;
  if (id === celoAlfajores.id) return celoAlfajores;
  return celo;
}

export interface InjectedProvider {
  isMiniPay?: boolean;
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
}

/** True when running inside the MiniPay WebView (enables zero-click connect). */
export function isMiniPay(provider?: { isMiniPay?: boolean } | null): boolean {
  return provider?.isMiniPay === true;
}

/** The injected EIP-1193 provider, if any (undefined during SSR). */
export function getInjectedProvider(): InjectedProvider | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { ethereum?: InjectedProvider }).ethereum;
}

/** Zero-click connect: read the address straight from the injected wallet.
 *  `chainId` must match the deployment so writes carry the right chainId. */
export async function connect(
  provider: InjectedProvider,
  chainId: number = celo.id,
): Promise<{ wallet: WalletClient; address: Address }> {
  const wallet = createWalletClient({ chain: chainById(chainId), transport: custom(provider) });
  const [address] = await wallet.getAddresses();
  return { wallet, address };
}

export function publicClient(rpcUrl: string, chainId: number = celo.id) {
  return createPublicClient({ chain: chainById(chainId), transport: http(rpcUrl) });
}

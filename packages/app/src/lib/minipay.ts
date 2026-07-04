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

/** CIP-64 gate. `feeCurrency` (gas paid in stablecoin) is a Celo-specific
 *  transaction type: MiniPay expects it — its users hold no CELO — while
 *  browser wallets like MetaMask reject the unknown tx type outright. Attach
 *  it only when actually running inside MiniPay; everywhere else the wallet
 *  pays native gas as usual. */
export function effectiveFeeCurrency(feeCurrency?: Address): Address | undefined {
  return isMiniPay(getInjectedProvider()) ? feeCurrency : undefined;
}

/** The injected EIP-1193 provider, if any (undefined during SSR). */
export function getInjectedProvider(): InjectedProvider | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { ethereum?: InjectedProvider }).ethereum;
}

/** Connect to the injected wallet. Zero-click inside MiniPay (eth_accounts
 *  already returns the address). Desktop wallets (MetaMask & co) return
 *  nothing until the user approves the site — pass `interactive: true` from
 *  a user-intent path (a button, an invite link) to prompt for access and
 *  steer the wallet onto the right Celo network. Passive mounts stay silent:
 *  no popups on page load. */
export async function connect(
  provider: InjectedProvider,
  chainId: number = celo.id,
  opts: { interactive?: boolean } = {},
): Promise<{ wallet: WalletClient; address: Address }> {
  const chain = chainById(chainId);
  const wallet = createWalletClient({ chain, transport: custom(provider) });
  let [address] = await wallet.getAddresses();
  if (!address && opts.interactive) {
    [address] = await wallet.requestAddresses();
    // a desktop wallet may sit on another network — switch, adding the chain
    // if it's unknown. MiniPay never reaches this branch.
    try {
      if ((await wallet.getChainId()) !== chainId) {
        try {
          await wallet.switchChain({ id: chainId });
        } catch {
          await wallet.addChain({ chain });
          await wallet.switchChain({ id: chainId });
        }
      }
    } catch {
      /* best-effort — the write path will surface a chain mismatch clearly */
    }
  }
  if (!address) throw new Error("wallet not connected");
  return { wallet, address };
}

export function publicClient(rpcUrl: string, chainId: number = celo.id) {
  return createPublicClient({ chain: chainById(chainId), transport: http(rpcUrl) });
}

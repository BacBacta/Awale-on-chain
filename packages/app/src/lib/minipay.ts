// MiniPay connection. Inside MiniPay the wallet is injected and auto-connects:
// no "Connect Wallet" button. We never request message signing from the wallet
// (MiniPay forbids it); all signing is done with per-match session keys.

import { createWalletClient, createPublicClient, custom, http, fallback, type Address, type Chain, type WalletClient } from "viem";
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

// EIP-6963 multi-wallet discovery. `window.ethereum` is a single slot that
// multiple installed wallets fight over; EIP-6963 lets each wallet *announce*
// itself so a dapp can pick the right one. MiniPay still injects
// `window.ethereum` (isMiniPay) and auto-connects, so its zero-click path is
// untouched — this only adds robustness for desktop browsers with 1+ wallets.
interface EIP6963ProviderDetail {
  info: { uuid: string; name: string; rdns: string };
  provider: InjectedProvider;
}
const discovered: EIP6963ProviderDetail[] = [];
let discoveryStarted = false;

function startProviderDiscovery(): void {
  if (discoveryStarted || typeof window === "undefined") return;
  // guard minimal/test window stubs that lack the event API
  if (typeof window.addEventListener !== "function" || typeof window.dispatchEvent !== "function") return;
  discoveryStarted = true;
  window.addEventListener("eip6963:announceProvider", (e: Event) => {
    const detail = (e as CustomEvent<EIP6963ProviderDetail>).detail;
    if (!detail?.provider) return;
    if (!discovered.some((d) => d.info?.uuid === detail.info?.uuid)) discovered.push(detail);
  });
  // ask any already-loaded wallets to (re-)announce themselves
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

/** The injected EIP-1193 provider, if any (undefined during SSR).
 *  MiniPay first (unchanged), then a 6963-announced MiniPay, then
 *  `window.ethereum`, then the first announced wallet. */
export function getInjectedProvider(): InjectedProvider | undefined {
  if (typeof window === "undefined") return undefined;
  startProviderDiscovery();
  const eth = (window as unknown as { ethereum?: InjectedProvider }).ethereum;
  if (eth?.isMiniPay) return eth; // fast path: inside MiniPay, nothing else matters
  const announcedMini = discovered.find((d) => d.provider?.isMiniPay);
  if (announcedMini) return announcedMini.provider;
  return eth ?? discovered[0]?.provider;
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

// Public backup RPCs per chain. forno is load-balanced across nodes that can
// individually drop requests ("Failed to fetch") — and from some mobile
// networks it fails almost permanently, which killed shop purchases at the
// very first allowance read. A viem fallback transport fails over to these
// automatically, app-wide (both verified: right chainId + CORS for our origin).
const BACKUP_RPCS: Record<number, string[]> = {
  [celoSepolia.id]: ["https://celo-sepolia.drpc.org", "https://rpc.ankr.com/celo_sepolia"],
  // mainnet failover — without this, the whole flaky-forno resilience
  // (readWithRetry/fallback) silently vanished on a mainnet launch
  [celo.id]: ["https://celo.drpc.org", "https://rpc.ankr.com/celo", "https://1rpc.io/celo"],
};

export function publicClient(rpcUrl: string, chainId: number = celo.id) {
  const backups = (BACKUP_RPCS[chainId] ?? []).filter((u) => u !== rpcUrl);
  // fail over FAST: with viem's defaults (10s timeout × 3 retries) a dead
  // primary cost ~40s per request before the fallback even got a chance —
  // purchases took a minute. 4s + no per-transport retry bounds the penalty
  // of a dead endpoint to ~4s per hop; readWithRetry/confirmTx retry above.
  const opts = { timeout: 4_000, retryCount: 0 } as const;
  const transport = backups.length
    ? fallback([http(rpcUrl, opts), ...backups.map((u) => http(u, opts))], { retryCount: 1 })
    : http(rpcUrl);
  return createPublicClient({ chain: chainById(chainId), transport });
}

// MiniPay deeplinks. Copy lexicon: "Deposit" / "Network fee" / "Withdraw" —
// never "gas", "onramp", or "crypto" anywhere a user can read.

const BASE = "https://link.minipay.xyz";

/** Add Cash (Deposit) flow — used when the stablecoin balance is zero. */
export function addCashDeeplink(tokens: string[] = ["USDm", "USDC", "USDT"]): string {
  return `${BASE}/add_cash?tokens=${tokens.join(",")}`;
}

/** Transaction Receipt deeplink — shown on a win, with a celebration. */
export function receiptDeeplink(txHash: string, celebrate = true): string {
  return `${BASE}/receipt?tx=${txHash}${celebrate ? "&celebrate" : ""}`;
}

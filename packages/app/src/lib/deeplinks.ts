// MiniPay deeplinks. Copy lexicon: "Deposit" / "Network fee" / "Withdraw" —
// never "gas", "onramp", or "crypto" anywhere a user can read.

import { getInjectedProvider, isMiniPay } from "./minipay.js";

const BASE = "https://link.minipay.xyz";

/** Add Cash (Deposit) flow — used when the stablecoin balance is zero. */
export function addCashDeeplink(tokens: string[] = ["USDm", "USDC", "USDT"]): string {
  return `${BASE}/add_cash?tokens=${tokens.join(",")}`;
}

/**
 * Send the user to MiniPay's Deposit (Add Cash) flow.
 *
 * MiniPay's listing rules require a too-low balance to ROUTE THE USER TO
 * DEPOSIT rather than dead-end on an error message — a wall that says "not
 * enough" with no way forward is exactly what they reject. Outside MiniPay the
 * deeplink means nothing (a desktop browser cannot open it), so this reports
 * whether it actually navigated and the caller falls back to a message.
 *
 * @param tokens which currencies the Deposit screen should offer; defaults to
 *        all three MiniPay stablecoins.
 * @returns true if the user was sent to Deposit.
 */
export function openDeposit(tokens?: string[]): boolean {
  if (typeof window === "undefined") return false;
  if (!isMiniPay(getInjectedProvider())) return false;
  window.location.href = addCashDeeplink(tokens);
  return true;
}

/** Transaction Receipt deeplink — shown on a win, with a celebration. */
export function receiptDeeplink(txHash: string, celebrate = true): string {
  return `${BASE}/receipt?tx=${txHash}${celebrate ? "&celebrate" : ""}`;
}

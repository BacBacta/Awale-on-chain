// Tolerant transaction confirmation for a load-balanced public RPC whose
// nodes lag each other. viem's default receipt waiter throws BlockNotFound /
// TransactionReceiptNotFound when it polls a stale node — the app then
// declared "stake failed" while the transaction had in fact LANDED, which is
// how four out of five pairings died at "Placing your stake…" with money
// locked. Poll patiently; only give up when the chain has truly said nothing
// for a long time.

import { getTransactionReceipt } from "viem/actions";
import type { Hex } from "viem";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until `hash` is mined; returns the receipt (throws on revert or 150s silence). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function confirmTx(client: Client, hash: Hex, label: string): Promise<any> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await getTransactionReceipt(client, { hash });
      if (r) {
        if (r.status === "reverted") throw new Error(`${label} was rejected by the network — nothing was taken.`);
        return r;
      }
    } catch (e) {
      if (e instanceof Error && /rejected by the network/.test(e.message)) throw e;
      /* receipt not visible on this node yet — keep polling */
    }
    await sleep(2500);
  }
  throw new Error(`${label} is taking unusually long — check Your matches before retrying.`);
}

/** Run `send` with retries when the revert is a stale-node artifact (a mined
 *  approve not yet visible where the wallet estimated the tx). */
export async function sendWithStaleRetry(label: string, send: () => Promise<Hex>): Promise<Hex> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await send();
    } catch (e) {
      lastErr = e;
      const text = String(e);
      // user said no in the wallet — don't hammer them with 5 more popups
      if (/user rejected|denied|4001/i.test(text)) throw e;
      // stale allowance/balance view — the next node will know better
      if (/allowance|transfer amount exceeds|insufficient/i.test(text)) {
        await sleep(3500);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

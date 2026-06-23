// Push notifications — the "your turn" nudge that drives async retention.
//
// `LogNotifier` (default) just logs; swap in `WebPushNotifier` (VAPID + the
// `web-push` package) once keys are configured — see
// docs/async-push-milestone.md. The client registers a Service Worker and posts
// its subscription to POST /push/subscribe (src/lib/push.ts).

import type { Address } from "viem";

/** Web Push subscription shape (from the browser PushManager). */
export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface SubscriptionStore {
  add(address: Address, sub: WebPushSubscription): Promise<void>;
  listFor(address: Address): Promise<WebPushSubscription[]>;
}

export class InMemorySubscriptionStore implements SubscriptionStore {
  private readonly byAddr = new Map<string, WebPushSubscription[]>();
  async add(address: Address, sub: WebPushSubscription): Promise<void> {
    const key = address.toLowerCase();
    const list = this.byAddr.get(key) ?? [];
    if (!list.some((s) => s.endpoint === sub.endpoint)) list.push(sub);
    this.byAddr.set(key, list);
  }
  async listFor(address: Address): Promise<WebPushSubscription[]> {
    return this.byAddr.get(address.toLowerCase()) ?? [];
  }
}

export interface Notifier {
  /** Tell `address` it's their turn in `matchId`. */
  notifyTurn(address: Address, matchId: string): Promise<void>;
  /** Tell `address` that `from` challenged them to `matchId`. */
  notifyChallenge(address: Address, from: string, matchId: string): Promise<void>;
}

/** Default no-op-ish notifier — logs the intent. */
export class LogNotifier implements Notifier {
  async notifyTurn(address: Address, matchId: string): Promise<void> {
    console.log(`[notify] your-turn -> ${address} (match ${matchId})`);
  }
  async notifyChallenge(address: Address, from: string, matchId: string): Promise<void> {
    console.log(`[notify] challenge from ${from} -> ${address} (match ${matchId})`);
  }
}

/**
 * Production notifier (scaffold). To enable:
 *   1. `npm i web-push` in the game-server.
 *   2. Generate VAPID keys (`web-push generate-vapid-keys`); set VAPID_PUBLIC_KEY
 *      / VAPID_PRIVATE_KEY (server) and NEXT_PUBLIC_VAPID_PUBLIC_KEY (app).
 *   3. Replace the body below with `webpush.sendNotification(sub, payload)` over
 *      `subs.listFor(address)`, pruning 410/404 (expired) subscriptions.
 */
export class WebPushNotifier implements Notifier {
  constructor(
    private readonly subs: SubscriptionStore,
    private readonly vapid: { publicKey: string; privateKey: string; subject: string },
  ) {}

  async notifyTurn(address: Address, matchId: string): Promise<void> {
    await this.send(address, `would notify your-turn ${address} (match ${matchId})`);
  }
  async notifyChallenge(address: Address, from: string, matchId: string): Promise<void> {
    await this.send(address, `would notify challenge from ${from} -> ${address} (match ${matchId})`);
  }

  private async send(address: Address, intent: string): Promise<void> {
    const subscriptions = await this.subs.listFor(address);
    if (subscriptions.length === 0) return;
    // for (const sub of subscriptions) { try { await webpush.sendNotification(sub, payload, { vapidDetails: ... }); } catch (e) { if (410/404) await prune(sub); } }
    void this.vapid;
    console.warn(`[webpush] not wired: ${intent} (${subscriptions.length} subs)`);
  }
}

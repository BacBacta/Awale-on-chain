// Push notifications — the "your turn" nudge that drives async retention.
//
// `LogNotifier` (default) just logs; swap in `WebPushNotifier` (VAPID + the
// `web-push` package) once keys are configured — see
// docs/async-push-milestone.md. The client registers a Service Worker and posts
// its subscription to POST /push/subscribe (src/lib/push.ts).

import type { Address } from "viem";
import webpush from "web-push";

/** Web Push subscription shape (from the browser PushManager). */
export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface SubscriptionStore {
  add(address: Address, sub: WebPushSubscription): Promise<void>;
  listFor(address: Address): Promise<WebPushSubscription[]>;
  remove(address: Address, endpoint: string): Promise<void>;
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
  async remove(address: Address, endpoint: string): Promise<void> {
    const key = address.toLowerCase();
    this.byAddr.set(key, (this.byAddr.get(key) ?? []).filter((s) => s.endpoint !== endpoint));
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
    vapid: { publicKey: string; privateKey: string; subject: string },
  ) {
    webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  }

  async notifyTurn(address: Address, matchId: string): Promise<void> {
    await this.send(address, {
      title: "Your turn — Awalé",
      body: "Your opponent moved. Tap to play your move.",
      url: `/play?async=${matchId}`,
    });
  }
  async notifyChallenge(address: Address, from: string, matchId: string): Promise<void> {
    await this.send(address, {
      title: "You've been challenged — Awalé",
      body: "A friend challenged you to a game. Tap to play.",
      url: `/play?async=${matchId}`,
    });
  }

  private async send(address: Address, payload: { title: string; body: string; url: string }): Promise<void> {
    const subscriptions = await this.subs.listFor(address);
    if (subscriptions.length === 0) return;
    const body = JSON.stringify(payload);
    await Promise.all(
      subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(sub, body);
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          // 404/410 = the subscription is gone — prune it so we stop trying
          if (code === 404 || code === 410) await this.subs.remove(address, sub.endpoint);
          else console.warn(`[webpush] send failed (${code}): ${(e as Error).message}`);
        }
      }),
    );
  }
}

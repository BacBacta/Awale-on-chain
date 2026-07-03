// Push notifications — the "your turn" / "streak expiring" nudges that drive
// retention. `LogNotifier` (default) just logs; `WebPushNotifier` sends real
// Web Push once VAPID keys are configured. The client registers a Service
// Worker and posts its subscription to POST /push/subscribe (src/lib/push.ts).

import webpush from "web-push";
import type { Address } from "viem";
import type { RedisLike } from "../persistence/redis-store.js";

/** Web Push subscription shape (from the browser PushManager). */
export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface SubscriptionStore {
  add(address: Address, sub: WebPushSubscription): Promise<void>;
  listFor(address: Address): Promise<WebPushSubscription[]>;
  /** Drop one expired/revoked subscription (410/404 from the push service). */
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

const subKey = (a: Address) => `awale:push:${a.toLowerCase()}`;

/** Redis-backed: subscriptions survive restarts/deploys — an in-memory store
 *  silently unsubscribed every player on each deploy, which is the exact
 *  opposite of what a retention channel is for. */
export class RedisSubscriptionStore implements SubscriptionStore {
  constructor(private readonly redis: RedisLike) {}
  async add(address: Address, sub: WebPushSubscription): Promise<void> {
    const list = await this.listFor(address);
    if (!list.some((s) => s.endpoint === sub.endpoint)) list.push(sub);
    await this.redis.set(subKey(address), JSON.stringify(list));
  }
  async listFor(address: Address): Promise<WebPushSubscription[]> {
    const raw = await this.redis.get(subKey(address));
    return raw ? (JSON.parse(raw) as WebPushSubscription[]) : [];
  }
  async remove(address: Address, endpoint: string): Promise<void> {
    const list = (await this.listFor(address)).filter((s) => s.endpoint !== endpoint);
    await this.redis.set(subKey(address), JSON.stringify(list));
  }
}

/** What a notification says and where tapping it lands. `tag` collapses
 *  repeats (a second "your turn" replaces the first instead of stacking). */
export interface Notification {
  title: string;
  body: string;
  url: string;
  tag: string;
}

export interface Notifier {
  /** Send an arbitrary notification to every device `address` registered. */
  notify(address: Address, n: Notification): Promise<void>;
  /** Convenience: tell `address` it's their turn in async match `matchId`. */
  notifyTurn(address: Address, matchId: string): Promise<void>;
}

export function turnNotification(matchId: string): Notification {
  return {
    title: "Your turn — Awalé",
    body: "Your opponent has played. Your move!",
    url: `/play?async=${matchId}`,
    tag: `awale-turn-${matchId}`,
  };
}

/** Default no-op-ish notifier — logs the intent. */
export class LogNotifier implements Notifier {
  async notify(address: Address, n: Notification): Promise<void> {
    console.log(`[notify] ${n.tag} -> ${address}: ${n.title}`);
  }
  async notifyTurn(address: Address, matchId: string): Promise<void> {
    await this.notify(address, turnNotification(matchId));
  }
}

/** Real Web Push delivery. Expired subscriptions (the push service answers
 *  410/404) are pruned so the store doesn't accumulate dead endpoints. */
export class WebPushNotifier implements Notifier {
  constructor(
    private readonly subs: SubscriptionStore,
    private readonly vapid: { publicKey: string; privateKey: string; subject: string },
  ) {}

  async notify(address: Address, n: Notification): Promise<void> {
    const subscriptions = await this.subs.listFor(address);
    if (subscriptions.length === 0) return;
    const payload = JSON.stringify(n);
    for (const sub of subscriptions) {
      try {
        await webpush.sendNotification(sub, payload, {
          vapidDetails: { subject: this.vapid.subject, publicKey: this.vapid.publicKey, privateKey: this.vapid.privateKey },
        });
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) {
          await this.subs.remove(address, sub.endpoint).catch(() => {});
        } else {
          console.warn(`[webpush] send failed for ${address}: ${(err as Error).message}`);
        }
      }
    }
  }

  async notifyTurn(address: Address, matchId: string): Promise<void> {
    await this.notify(address, turnNotification(matchId));
  }
}

// In-app notification inbox — the fallback channel when Web Push can't reach
// the player (MiniPay's webview may not expose service workers at all, and a
// user can simply decline the permission prompt). Every nudge the Notifier
// sends is also recorded here, so the app can show "what happened while you
// were away" the next time it opens. Push is the *reach* channel; the inbox
// is the guarantee.

import type { Address } from "viem";
import type { Notification, Notifier } from "./notifier.js";
import { turnNotification } from "./notifier.js";
import type { RedisLike } from "../persistence/redis-store.js";

export interface InboxItem extends Notification {
  at: number; // epoch ms
}

/** Newest first, capped — an inbox, not an archive. */
const MAX_ITEMS = 20;

export interface InboxStore {
  list(address: Address): Promise<InboxItem[]>;
  save(address: Address, items: InboxItem[]): Promise<void>;
  lastSeen(address: Address): Promise<number>;
  setLastSeen(address: Address, at: number): Promise<void>;
}

export class InMemoryInboxStore implements InboxStore {
  private items = new Map<string, InboxItem[]>();
  private seen = new Map<string, number>();
  async list(address: Address) {
    return this.items.get(address.toLowerCase()) ?? [];
  }
  async save(address: Address, items: InboxItem[]) {
    this.items.set(address.toLowerCase(), items);
  }
  async lastSeen(address: Address) {
    return this.seen.get(address.toLowerCase()) ?? 0;
  }
  async setLastSeen(address: Address, at: number) {
    this.seen.set(address.toLowerCase(), at);
  }
}

const itemsKey = (a: Address) => `awale:inbox:${a.toLowerCase()}`;
const seenKey = (a: Address) => `awale:inbox:seen:${a.toLowerCase()}`;

export class RedisInboxStore implements InboxStore {
  constructor(private readonly redis: RedisLike) {}
  async list(address: Address): Promise<InboxItem[]> {
    const raw = await this.redis.get(itemsKey(address));
    return raw ? (JSON.parse(raw) as InboxItem[]) : [];
  }
  async save(address: Address, items: InboxItem[]): Promise<void> {
    await this.redis.set(itemsKey(address), JSON.stringify(items));
  }
  async lastSeen(address: Address): Promise<number> {
    const raw = await this.redis.get(seenKey(address));
    return raw ? Number(raw) : 0;
  }
  async setLastSeen(address: Address, at: number): Promise<void> {
    await this.redis.set(seenKey(address), String(at));
  }
}

/** Record an item, replacing any older one with the same `tag` — mirrors the
 *  Web Push semantics where a second "your turn" collapses into the first
 *  instead of stacking twenty of them. */
export async function pushToInbox(store: InboxStore, address: Address, n: Notification, at = Date.now()): Promise<void> {
  const items = (await store.list(address)).filter((i) => i.tag !== n.tag);
  items.unshift({ ...n, at });
  await store.save(address, items.slice(0, MAX_ITEMS));
}

/** How the app reads it: items plus the count the player hasn't seen yet. */
export async function inboxSnapshot(store: InboxStore, address: Address): Promise<{ items: InboxItem[]; unseen: number }> {
  const [items, seenAt] = await Promise.all([store.list(address), store.lastSeen(address)]);
  return { items, unseen: items.filter((i) => i.at > seenAt).length };
}

/** Decorator: every notification lands in the inbox first, then goes out on
 *  the wrapped channel (web-push or log). Inbox failures must never block the
 *  push — and vice versa. */
export class InboxNotifier implements Notifier {
  constructor(
    private readonly store: InboxStore,
    private readonly inner: Notifier,
  ) {}

  async notify(address: Address, n: Notification): Promise<void> {
    await pushToInbox(this.store, address, n).catch((e) => console.warn(`[inbox] not recorded: ${(e as Error).message}`));
    await this.inner.notify(address, n);
  }

  async notifyTurn(address: Address, matchId: string): Promise<void> {
    await this.notify(address, turnNotification(matchId));
  }
}

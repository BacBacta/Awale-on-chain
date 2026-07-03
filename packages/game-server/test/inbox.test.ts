import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import { InMemoryInboxStore, InboxNotifier, pushToInbox, inboxSnapshot } from "../src/notifications/inbox.js";
import type { Notification, Notifier } from "../src/notifications/notifier.js";

const A: Address = "0x000000000000000000000000000000000000000a";

const note = (tag: string, title = "t"): Notification => ({ title, body: "b", url: "/", tag });

describe("inbox", () => {
  it("records newest first and collapses repeats by tag (push semantics)", async () => {
    const store = new InMemoryInboxStore();
    await pushToInbox(store, A, note("turn-1", "first"), 1);
    await pushToInbox(store, A, note("streak"), 2);
    await pushToInbox(store, A, note("turn-1", "second"), 3); // replaces, not stacks

    const items = await store.list(A);
    expect(items.map((i) => i.tag)).toEqual(["turn-1", "streak"]);
    expect(items[0].title).toBe("second");
  });

  it("caps the inbox — it's an inbox, not an archive", async () => {
    const store = new InMemoryInboxStore();
    for (let i = 0; i < 30; i++) await pushToInbox(store, A, note(`n-${i}`), i);
    expect((await store.list(A)).length).toBe(20);
    expect((await store.list(A))[0].tag).toBe("n-29"); // newest kept
  });

  it("unseen counts only items newer than the last-seen mark", async () => {
    const store = new InMemoryInboxStore();
    await pushToInbox(store, A, note("a"), 10);
    await pushToInbox(store, A, note("b"), 20);
    expect((await inboxSnapshot(store, A)).unseen).toBe(2);

    await store.setLastSeen(A, 15);
    expect((await inboxSnapshot(store, A)).unseen).toBe(1);
  });

  it("InboxNotifier records then forwards — turn nudges included", async () => {
    const store = new InMemoryInboxStore();
    const forwarded: string[] = [];
    const inner: Notifier = {
      async notify(_a, n) {
        forwarded.push(n.tag);
      },
      async notifyTurn() {
        throw new Error("never called — InboxNotifier routes through notify()");
      },
    };
    const notifier = new InboxNotifier(store, inner);
    await notifier.notify(A, note("prize"));
    await notifier.notifyTurn(A, "42");

    expect(forwarded).toEqual(["prize", "awale-turn-42"]);
    expect((await store.list(A)).map((i) => i.tag)).toEqual(["awale-turn-42", "prize"]);
  });
});

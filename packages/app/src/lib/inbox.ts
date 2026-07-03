// In-app notification inbox — the guaranteed channel. Web Push may be
// unsupported in MiniPay's webview or simply declined; the server records
// every nudge here too, so the app can show what happened while you were away.

import type { Address } from "viem";

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "";

export interface InboxItem {
  title: string;
  body: string;
  url: string;
  tag: string;
  at: number;
}

export function inboxEnabled(): boolean {
  return !!SERVER_URL;
}

export async function getInbox(address: Address): Promise<{ items: InboxItem[]; unseen: number }> {
  const res = await fetch(`${SERVER_URL}/inbox?address=${address}`);
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error ?? "inbox unavailable");
  return data as { items: InboxItem[]; unseen: number };
}

export async function markInboxSeen(address: Address): Promise<void> {
  await fetch(`${SERVER_URL}/inbox/seen`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address }),
  });
}

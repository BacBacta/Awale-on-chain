"use client";

// "While you were away" — surfaces unseen inbox items (your turn, streak
// about to break, league prize) at the top of the home screen. This is the
// retention loop's guaranteed leg: push may never arrive in MiniPay's
// webview, but the player *will* open the app again, and this is the first
// thing they see when they do. Renders nothing when there's nothing new.

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Address } from "viem";
import { Icon } from "./Icon.js";
import { getInbox, markInboxSeen, inboxEnabled, type InboxItem } from "../lib/inbox.js";

export function InboxCard({ address }: { address: Address | null }) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [unseen, setUnseen] = useState(0);

  useEffect(() => {
    if (!address || !inboxEnabled()) return;
    let alive = true;
    getInbox(address)
      .then((s) => {
        if (!alive) return;
        setItems(s.items);
        setUnseen(s.unseen);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [address]);

  if (!address || unseen === 0) return null;

  function dismiss() {
    setUnseen(0);
    if (address) markInboxSeen(address).catch(() => {});
  }

  return (
    <div className="card stack animate-in" style={{ gap: 8 }}>
      <div className="row">
        <span className="chip gold">While you were away</span>
        <button className="btn ghost" onClick={dismiss} style={{ padding: "4px 10px", fontSize: 13 }} aria-label="Dismiss">
          ✕
        </button>
      </div>
      {items.slice(0, 3).map((i) => (
        <Link key={i.tag} className="list-row" href={i.url} onClick={dismiss} style={{ textDecoration: "none" }}>
          <span className="col" style={{ flex: 1, gap: 1 }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>{i.title}</span>
            <span className="faint">{i.body}</span>
          </span>
          <Icon name="arrowRight" size={16} style={{ color: "var(--faint)" }} />
        </Link>
      ))}
    </div>
  );
}

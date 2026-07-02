"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "./Icon.js";

// Persistent bottom navigation. Hidden on the immersive game and tutorial
// screens, which have their own back affordance.
type Tab = { href: string; label: string; icon: IconName; advanced?: boolean };
const TABS: Tab[] = [
  { href: "/", label: "Play", icon: "play" },
  { href: "/matches", label: "Matches", icon: "target" },
  { href: "/tournaments", label: "Cups", icon: "medal", advanced: true },
  { href: "/league", label: "League", icon: "trophy" },
  { href: "/shop", label: "Style", icon: "palette", advanced: true },
  { href: "/stats", label: "Stats", icon: "chart" },
];

const HIDDEN = ["/play", "/learn"];

export function BottomNav() {
  const pathname = usePathname() ?? "/";
  // Progressive disclosure: hide Cups/Style until the player has played once.
  const [played, setPlayed] = useState(false);
  useEffect(() => {
    try {
      setPlayed(localStorage.getItem("awale_played") === "1");
    } catch {
      setPlayed(true);
    }
  }, []);
  if (HIDDEN.some((p) => pathname.startsWith(p))) return null;
  // always show a tab the user is currently on, even if "advanced"
  const tabs = TABS.filter((t) => !t.advanced || played || pathname.startsWith(t.href));

  return (
    <nav
      style={{
        display: "flex",
        padding: "8px 6px calc(8px + env(safe-area-inset-bottom))",
        borderTop: "1px solid var(--line)",
        background: "rgba(10, 9, 7, 0.72)",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
      }}
    >
      {tabs.map((t) => {
        const active = t.href === "/" ? pathname === "/" : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
              padding: "6px 0",
              textDecoration: "none",
              color: active ? "var(--accent)" : "var(--faint)",
              fontWeight: active ? 700 : 500,
              fontSize: 10.5,
              transition: "color 200ms var(--ease-out)",
            }}
          >
            <span
              style={{
                display: "grid",
                placeItems: "center",
                width: 44,
                height: 30,
                borderRadius: 999,
                background: active ? "var(--accent-soft)" : "transparent",
                boxShadow: active ? "inset 0 0 0 1px rgba(76,229,132,0.25)" : "none",
                transition: "background 200ms var(--ease-out)",
              }}
            >
              <Icon name={t.icon} size={20} stroke={active ? 2 : 1.75} />
            </span>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

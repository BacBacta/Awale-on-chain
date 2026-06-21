"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Persistent bottom navigation. Hidden on the immersive game and tutorial
// screens, which have their own back affordance.
const TABS = [
  { href: "/", label: "Play", icon: "🎮" },
  { href: "/matches", label: "Matches", icon: "🎯" },
  { href: "/stats", label: "Stats", icon: "📊" },
] as const;

const HIDDEN = ["/play", "/learn"];

export function BottomNav() {
  const pathname = usePathname() ?? "/";
  if (HIDDEN.some((p) => pathname.startsWith(p))) return null;

  return (
    <nav
      style={{
        display: "flex",
        borderTop: "1px solid var(--line)",
        background: "rgba(13,16,12,0.7)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
      }}
    >
      {TABS.map((t) => {
        const active = t.href === "/" ? pathname === "/" : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 3,
              padding: "10px 0 12px",
              textDecoration: "none",
              color: active ? "var(--accent)" : "var(--faint)",
              fontWeight: active ? 700 : 500,
              fontSize: 11,
              transition: "color 160ms var(--ease-out)",
            }}
          >
            <span style={{ fontSize: 19, filter: active ? "none" : "grayscale(0.5) opacity(0.8)" }}>{t.icon}</span>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

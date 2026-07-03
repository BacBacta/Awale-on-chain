"use client";

// Tournaments were replaced by the weekly league (every cash game counts, top
// 5 split the pot each Monday — see Compete). This route survives only so old
// deep links land somewhere sensible; in-flight brackets still coordinate via
// /play?tournament=<id>.

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function TournamentsMoved() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/compete");
  }, [router]);
  return (
    <main className="pad stack" style={{ flex: 1, gap: 12, alignItems: "center", justifyContent: "center" }}>
      <span className="muted" style={{ textAlign: "center" }}>
        Tournaments have grown into the weekly league — every money game now counts.
      </span>
      <Link className="btn" href="/compete">
        See this week&apos;s race
      </Link>
    </main>
  );
}

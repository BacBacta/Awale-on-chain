"use client";

import { usePathname } from "next/navigation";

// Replays a subtle enter animation on every route change by keying the wrapper
// on the pathname. Keeps the frame's flex column intact (flex: 1).
export function RouteTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div
      key={pathname}
      className="route-enter"
      style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}
    >
      {children}
    </div>
  );
}

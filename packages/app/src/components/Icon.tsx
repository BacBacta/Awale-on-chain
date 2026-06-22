// Crafted line-icon set — replaces system emoji for a premium, consistent look.
// 24px grid, 1.75 stroke, round caps/joins. Inherit color via `currentColor`.

import type { CSSProperties } from "react";

export type IconName =
  | "play"
  | "bolt"
  | "versus"
  | "trophy"
  | "palette"
  | "chart"
  | "plus"
  | "share"
  | "arrowRight"
  | "back"
  | "seed"
  | "wallet"
  | "check"
  | "spinner"
  | "info"
  | "target"
  | "gift"
  | "medal"
  | "user"
  | "sound"
  | "mute";

const PATHS: Record<IconName, React.ReactNode> = {
  play: <path d="M7 5.5v13l11-6.5z" fill="currentColor" stroke="none" />,
  bolt: <path d="M13 3 5 13h5l-1 8 8-10h-5z" />,
  versus: (
    <>
      <path d="M4 6h3l3 6-3 6H4l3-6z" />
      <path d="M20 6h-3l-3 6 3 6h3l-3-6z" />
    </>
  ),
  trophy: (
    <>
      <path d="M7 4h10v5a5 5 0 0 1-10 0z" />
      <path d="M7 5H4v2a3 3 0 0 0 3 3M17 5h3v2a3 3 0 0 1-3 3" />
      <path d="M10 14h4M9 20h6M12 14v6" />
    </>
  ),
  palette: (
    <>
      <path d="M12 3a9 9 0 0 0 0 18c1.5 0 2-1 2-2 0-1.5 1-2 2-2h2a3 3 0 0 0 3-3 8 8 0 0 0-9-9z" />
      <circle cx="7.5" cy="11.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="11" cy="7.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="8.5" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  chart: <path d="M5 19V5M5 19h14M9 19v-6M13 19V9M17 19v-9" />,
  plus: <path d="M12 5v14M5 12h14" />,
  share: (
    <>
      <path d="M12 3v12M8 7l4-4 4 4" />
      <path d="M6 12H5a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-2-2h-1" />
    </>
  ),
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  back: <path d="M19 12H5M11 6l-6 6 6 6" />,
  seed: <path d="M12 3c5 2 8 6 8 11a8 8 0 0 1-16 0c0-5 3-9 8-11z" />,
  wallet: (
    <>
      <rect x="3" y="6" width="18" height="13" rx="3" />
      <path d="M16 12h2" />
    </>
  ),
  check: <path d="M5 12.5 10 17l9-10" />,
  spinner: <path d="M12 3a9 9 0 1 0 9 9" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  gift: (
    <>
      <rect x="4" y="9" width="16" height="11" rx="1.5" />
      <path d="M4 13h16M12 9v11" />
      <path d="M12 9C12 6 10.5 4.5 9 4.5S6.5 7 9 9h3zM12 9c0-3 1.5-4.5 3-4.5S17.5 7 15 9h-3z" />
    </>
  ),
  medal: (
    <>
      <path d="M9 3l3 6 3-6" />
      <circle cx="12" cy="15" r="6" />
      <path d="M12 12.5l1 2 2 .2-1.5 1.4.4 2-1.9-1-1.9 1 .4-2L10 14.7l2-.2z" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </>
  ),
  sound: (
    <>
      <path d="M4 9v6h3l5 4V5L7 9z" />
      <path d="M16 8.5a4 4 0 0 1 0 7M18.5 6a7 7 0 0 1 0 12" />
    </>
  ),
  mute: (
    <>
      <path d="M4 9v6h3l5 4V5L7 9z" />
      <path d="M16 9.5l5 5M21 9.5l-5 5" />
    </>
  ),
};

export function Icon({
  name,
  size = 20,
  stroke = 1.75,
  style,
  className,
}: {
  name: IconName;
  size?: number;
  stroke?: number;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
      style={{ display: "block", flexShrink: 0, ...style }}
    >
      {name === "spinner" ? (
        <g style={{ transformOrigin: "center", animation: "spin 0.8s linear infinite" }}>{PATHS[name]}</g>
      ) : (
        PATHS[name]
      )}
    </svg>
  );
}

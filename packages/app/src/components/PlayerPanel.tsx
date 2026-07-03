"use client";

// A player's identity strip beside the board: avatar, name, captured-seed score,
// and an active-turn highlight. Mirrors the framing of premium board-game apps.

function avatarGradient(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h} 62% 52%), hsl(${(h + 40) % 360} 60% 38%))`;
}

function fmtClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function PlayerPanel({
  name,
  score,
  active,
  you,
  thinking,
  clockMs,
}: {
  name: string;
  score: number;
  active: boolean;
  you?: boolean;
  thinking?: boolean;
  /** Blitz: this player's remaining total time (ms). Omit for untimed play. */
  clockMs?: number | null;
}) {
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  const lowTime = clockMs != null && clockMs < 30_000;
  return (
    <div
      className="row"
      style={{
        gap: 12,
        padding: "10px 14px",
        borderRadius: 14,
        background: active
          ? "linear-gradient(180deg, rgba(61,220,111,0.16), rgba(61,220,111,0.05))"
          : "linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02))",
        boxShadow: active
          ? "inset 0 0 0 1.5px rgba(61,220,111,0.55), 0 6px 20px rgba(61,220,111,0.15)"
          : "inset 0 0 0 1px rgba(255,255,255,0.07)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        transition: "background 220ms var(--ease-out), box-shadow 220ms var(--ease-out)",
      }}
    >
      <div className="row" style={{ gap: 12 }}>
        <div
          aria-hidden
          style={{
            width: 38,
            height: 38,
            borderRadius: "50%",
            background: avatarGradient(name),
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 800,
            fontSize: 16,
            color: "#0b0f0a",
            boxShadow: active ? "0 0 0 2px var(--accent)" : "none",
          }}
        >
          {initial}
        </div>
        <div className="col">
          <span style={{ fontWeight: 700, fontSize: 14 }}>
            {name}
            {/* the suffix disambiguates a friendly name — "You" needs no help */}
            {you && name !== "You" && <span className="faint" style={{ marginLeft: 6 }}>(you)</span>}
          </span>
          <span className="faint">
            {active ? (
              <span style={{ color: "var(--accent)", fontWeight: 650 }}>
                {thinking ? "thinking…" : "to move"}
              </span>
            ) : (
              "waiting"
            )}
          </span>
        </div>
      </div>
      <div className="row" style={{ gap: 10 }}>
        {clockMs != null && (
          <span
            className="chip"
            aria-label="time remaining"
            style={{
              fontVariantNumeric: "tabular-nums",
              fontWeight: 700,
              color: lowTime ? "#ff7a76" : active ? "var(--accent)" : "var(--faint)",
              boxShadow: lowTime ? "inset 0 0 0 1px rgba(255,122,118,0.45)" : undefined,
            }}
          >
            {fmtClock(clockMs)}
          </span>
        )}
        <span className="title score" aria-label={`${score} captured`}>
          {score}
        </span>
      </div>
    </div>
  );
}

import { getStats } from "../../src/lib/stats.js";
import { CELO_MAINNET_TOKENS, formatAmount } from "../../../protocol/src/tokens.js";
import { PlayerStats } from "../../src/components/PlayerStats.js";
import { Leaderboard } from "../../src/components/Leaderboard.js";

// Public stats page — a MiniPay listing requirement. Metrics come from the
// indexer (chunked eth_getLogs over the settlement events). Network fees paid
// and failed-transaction rate need receipt-level data and are shown as "—".
export const revalidate = 60;

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

function decimalsForSymbol(symbol?: string): number {
  const t = symbol ? CELO_MAINNET_TOKENS[symbol as keyof typeof CELO_MAINNET_TOKENS] : undefined;
  return t?.decimals ?? 18;
}

export default async function Stats() {
  const s = await getStats();

  // Operator metrics (MiniPay listing requirement). "—" placeholders are hidden
  // rather than shown raw.
  const rows: { label: string; value: string }[] = [
    { label: "Daily active users", value: String(s.dau) },
    { label: "Monthly active users", value: String(s.mau) },
    { label: "Unique players", value: String(s.uniquePlayers) },
    { label: "Matches (settled / total)", value: `${s.matches.settled} / ${s.matches.created}` },
    {
      label: "D1 / D7 / D30 retention",
      value: `${pct(s.retention.d1)} / ${pct(s.retention.d7)} / ${pct(s.retention.d30)}`,
    },
  ];

  return (
    <main className="pad" style={{ display: "flex", flexDirection: "column", gap: 12, flex: 1 }}>
      <span className="title">Stats</span>

      <PlayerStats />

      <span className="h2" style={{ marginTop: 8 }}>
        Leaderboard
      </span>
      <Leaderboard />

      <span className="h2" style={{ marginTop: 8 }}>
        Global
      </span>
      {rows.map((m) => (
        <div className="card row" key={m.label}>
          <span className="muted">{m.label}</span>
          <span style={{ fontWeight: 700 }}>{m.value}</span>
        </div>
      ))}

      <span className="muted">Volume &amp; protocol revenue per stablecoin</span>
      {s.perToken.length === 0 ? (
        <div className="card muted">No settled matches yet.</div>
      ) : (
        s.perToken.map((t) => {
          const d = decimalsForSymbol(t.symbol);
          return (
            <div className="card row" key={t.token}>
              <span className="muted">{t.symbol ?? `${t.token.slice(0, 6)}…`}</span>
              <span style={{ fontWeight: 700 }}>
                {formatAmount(BigInt(t.volume), d)} vol · {formatAmount(BigInt(t.revenue), d)} rev
              </span>
            </div>
          );
        })
      )}

      <span className="muted" style={{ textAlign: "center" }}>
        Sourced on-chain from settlement events · updated every minute.
      </span>
    </main>
  );
}

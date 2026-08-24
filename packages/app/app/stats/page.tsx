import { getStats, getOpsCounters } from "../../src/lib/stats.js";
import { CELO_MAINNET_TOKENS, formatAmount } from "../../../protocol/src/tokens.js";
import { PlayerStats } from "../../src/components/PlayerStats.js";
import { Leaderboard } from "../../src/components/Leaderboard.js";

// Public stats page — a MiniPay listing requirement.
//
// The operator metrics are PUBLIC and need no wallet. They used to sit behind
// OperatorOnly, which failed the requirement outright: MiniPay asks for a
// stats page whose numbers are "fresh and reachable", and a reviewer has no
// operator wallet, so they saw an empty page. The original worry — a wall of
// zeros at cold start reading as a dead app — is handled by the `empty` guard
// below, which shows em-dashes and an explanatory line instead of "0 users".
//
// Match/volume/revenue figures come from the indexer (chunked eth_getLogs).
// Failed-tx rate and country split cannot come from logs — a revert emits none
// and geography never touches the chain — so they come from the game server's
// anonymous counters, and read "—" when it is unreachable.
export const revalidate = 60;

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

function decimalsForSymbol(symbol?: string): number {
  const t = symbol ? CELO_MAINNET_TOKENS[symbol as keyof typeof CELO_MAINNET_TOKENS] : undefined;
  return t?.decimals ?? 18;
}

export default async function Stats() {
  const [s, ops] = await Promise.all([getStats(), getOpsCounters()]);

  // Operator metrics (MiniPay listing requirement). A wall of raw zeros reads
  // as "dead app" — when the indexer has nothing yet (cold start, or an RPC
  // that can't reach old blocks) show em-dashes, never "0 users".
  const empty = s.uniquePlayers === 0 && s.matches.created === 0;
  const dash = (v: string) => (empty ? "—" : v);
  const rows: { label: string; value: string }[] = [
    { label: "Daily active users", value: dash(String(s.dau)) },
    { label: "Monthly active users", value: dash(String(s.mau)) },
    { label: "Unique players", value: dash(String(s.uniquePlayers)) },
    { label: "Matches (settled / total)", value: dash(`${s.matches.settled} / ${s.matches.created}`) },
    {
      label: "D1 / D7 / D30 retention",
      value: dash(`${pct(s.retention.d1)} / ${pct(s.retention.d7)} / ${pct(s.retention.d30)}`),
    },
    {
      label: "Failed transactions",
      value: ops ? `${(ops.failedTxRate * 100).toFixed(1)}%` : "—",
    },
    {
      label: "Top countries",
      value: ops && ops.topCountries.length > 0 ? ops.topCountries.map((c) => c.country).join(" · ") : "—",
    },
  ];

  return (
    <main className="pad" style={{ display: "flex", flexDirection: "column", gap: 12, flex: 1 }}>
      <span className="title">Stats</span>

      <PlayerStats />

      <div className="col" style={{ gap: 2, marginTop: 8 }}>
        <span className="h2">All-time winners</span>
        <span className="faint" style={{ fontSize: 12 }}>
          Prizes won minus stakes lost, across every settled money game — all players, never resets.
        </span>
      </div>
      <Leaderboard />

      {/* Operator dashboard — deliberately public and wallet-free, because
          MiniPay's readiness review has to be able to read these numbers. */}
      <span className="h2" style={{ marginTop: 8 }}>
        Global
      </span>
        {rows.map((m) => (
          <div className="card row" key={m.label}>
            <span className="muted">{m.label}</span>
            <span style={{ fontWeight: 700 }}>{m.value}</span>
          </div>
        ))}

        <span className="muted">Volume &amp; fees per currency</span>
        {s.perToken.length === 0 ? (
          <div className="card muted">No settled matches on the current contract yet.</div>
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
        {empty
          ? "Early days — these numbers fill in as games settle on-chain."
          : "Computed from public match results · updated every minute."}
      </span>
    </main>
  );
}

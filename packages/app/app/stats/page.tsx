import Link from "next/link";

// Public stats page — a MiniPay listing requirement. Metrics are served from
// the indexer; shown here as the required surface with the copy lexicon
// (Network fee / Stablecoin / protocol revenue). Values are placeholders until
// the indexer (Phase 5) is wired in.

const METRICS: { label: string; value: string }[] = [
  { label: "Daily active users", value: "—" },
  { label: "Monthly active users", value: "—" },
  { label: "D1 / D7 / D30 retention", value: "— / — / —" },
  { label: "Volume per stablecoin", value: "—" },
  { label: "Network fees paid", value: "—" },
  { label: "Protocol revenue", value: "—" },
  { label: "Failed-transaction rate", value: "—" },
];

export default function Stats() {
  return (
    <main className="pad" style={{ display: "flex", flexDirection: "column", gap: 12, flex: 1 }}>
      <div className="row">
        <Link className="muted" href="/">
          ← Back
        </Link>
        <span className="title">Stats</span>
      </div>

      {METRICS.map((m) => (
        <div className="card row" key={m.label}>
          <span className="muted">{m.label}</span>
          <span style={{ fontWeight: 700 }}>{m.value}</span>
        </div>
      ))}

      <span className="muted" style={{ textAlign: "center" }}>
        Sourced on-chain from settlement events.
      </span>
    </main>
  );
}

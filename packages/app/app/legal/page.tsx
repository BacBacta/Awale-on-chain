"use client";

import Link from "next/link";
import { Icon } from "../../src/components/Icon.js";

// Scaffold — the legal copy below is a placeholder and MUST be reviewed and
// finalised by qualified counsel before mainnet / real-money launch
// (see docs/minipay-listing-readiness.md).

const SUPPORT = process.env.NEXT_PUBLIC_SUPPORT_URL ?? "mailto:support@awale.app";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card stack" style={{ gap: 8 }}>
      <span className="h2">{title}</span>
      <div className="muted" style={{ lineHeight: 1.55, display: "flex", flexDirection: "column", gap: 8 }}>
        {children}
      </div>
    </div>
  );
}

export default function Legal() {
  return (
    <main className="pad stack" style={{ flex: 1, gap: 14 }}>
      <span className="title">Legal &amp; support</span>
      <span className="faint" style={{ marginTop: -6 }}>
        Last updated 2026-06-23 · placeholder pending counsel review
      </span>

      <Section title="What Awalé is">
        <span>
          Awalé is a <b>game of pure skill</b> (Oware/Mancala) — there is no element of chance; the better
          player wins. It is a non-custodial mini-app on the Celo network: you hold your own funds, and
          stakes are escrowed by audited smart contracts, not by us.
        </span>
      </Section>

      <Section title="Terms of Service">
        <span>• You must be <b>18+</b> and legally permitted to play skill games for money where you live. You are responsible for compliance with your local laws.</span>
        <span>• Cash matches and tournaments put your stablecoin at stake. Only stake what you can afford to lose. Outcomes are determined solely by play and settled on-chain.</span>
        <span>• A protocol fee (rake/cut) is taken transparently from settled cash matches and tournaments. Free play (vs AI, quick match, puzzles, correspondence) is free.</span>
        <span>• The service is provided “as is”, without warranty. Smart contracts carry inherent risk; an AI and (pending) human security review have been performed but no guarantee of security is given.</span>
        <span>• We may restrict access from jurisdictions where real-money skill gaming is prohibited.</span>
      </Section>

      <Section title="Privacy">
        <span>• We do not take custody of funds and do not collect government identity documents.</span>
        <span>• On-chain activity (matches, stakes, settlements) is public by nature of the blockchain.</span>
        <span>• The app stores minimal data in your browser (session keys, preferences, streaks) and, server-side, your wallet-keyed social graph and async game state to run the game.</span>
        <span>• Optional push notifications require your consent and a subscription token.</span>
      </Section>

      <Section title="Responsible play">
        <span>Set your own limits and take breaks. If gambling-like spending stops being fun, stop. Stake only what you can afford to lose.</span>
      </Section>

      <a className="btn block" href={SUPPORT} style={{ gap: 8 }}>
        <Icon name="info" size={16} /> Contact support
      </a>
      <Link className="btn ghost block" href="/">
        Back to Play
      </Link>
    </main>
  );
}

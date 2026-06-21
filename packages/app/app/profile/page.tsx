"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Address } from "viem";
import { getInjectedProvider, connect } from "../../src/lib/minipay.js";
import { escrowConfig } from "../../src/lib/escrow.js";
import { friendlyName } from "../../src/lib/names.js";
import { shortAddress } from "../../src/lib/identity.js";
import { getEquipped, ALL_SKINS } from "../../src/lib/skins.js";
import { PlayerStats } from "../../src/components/PlayerStats.js";
import { Icon } from "../../src/components/Icon.js";

function avatarGradient(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h} 62% 52%), hsl(${(h + 40) % 360} 60% 38%))`;
}

export default function Profile() {
  const cfg = escrowConfig();
  const [address, setAddress] = useState<Address | null>(null);
  const [equipped, setEquipped] = useState(getEquipped());

  useEffect(() => {
    setEquipped(getEquipped());
    const p = getInjectedProvider();
    if (p) connect(p, cfg?.chainId).then(({ address }) => setAddress(address)).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const name = friendlyName(address);
  const initial = name.trim()[0]?.toUpperCase() ?? "?";
  const boardSkin = ALL_SKINS.find((s) => s.asset === equipped.wood);
  const seedSkin = ALL_SKINS.find((s) => s.asset === equipped.seed);

  return (
    <main className="pad stack" style={{ flex: 1, gap: 16 }}>
      <span className="title">Profile</span>

      {/* identity */}
      <div className="card row animate-in" style={{ gap: 14 }}>
        <div className="row" style={{ gap: 14 }}>
          <div
            aria-hidden
            style={{
              width: 56,
              height: 56,
              borderRadius: "50%",
              background: avatarGradient(name),
              display: "grid",
              placeItems: "center",
              fontWeight: 800,
              fontSize: 24,
              color: "#0b0f0a",
              boxShadow: "0 0 0 2px var(--accent)",
            }}
          >
            {initial}
          </div>
          <div className="col" style={{ gap: 2 }}>
            <span style={{ fontWeight: 750, fontSize: 18 }}>{name}</span>
            <span className="faint">{address ? shortAddress(address) : "Open in MiniPay"}</span>
          </div>
        </div>
      </div>

      {/* record */}
      <span className="section-label">Record</span>
      <PlayerStats />

      {/* equipped skin */}
      <span className="section-label">Equipped</span>
      <Link className="list-row" href="/shop">
        <span
          className="lead"
          style={{
            width: 46,
            height: 46,
            borderRadius: 12,
            background: `url(${equipped.wood}) center/cover`,
            boxShadow: "inset 0 0 0 1px var(--line)",
          }}
        />
        <span className="col" style={{ flex: 1, gap: 1 }}>
          <span style={{ fontWeight: 700, fontSize: 14.5 }}>{boardSkin?.name ?? "Board"}</span>
          <span className="faint">Seeds · {seedSkin?.name ?? "Amber"}</span>
        </span>
        <img src={equipped.seed} alt="" width={28} height={28} style={{ marginRight: 6 }} />
        <Icon name="arrowRight" size={16} style={{ color: "var(--faint)" }} />
      </Link>

      {/* quick links */}
      <span className="section-label">Activity</span>
      <div className="stack" style={{ gap: 8 }}>
        <Link className="list-row" href="/matches">
          <span className="lead neutral">
            <Icon name="target" size={19} />
          </span>
          <span className="col" style={{ flex: 1, gap: 1 }}>
            <span style={{ fontWeight: 700, fontSize: 14.5 }}>Your matches</span>
            <span className="faint">Active & finished games</span>
          </span>
          <Icon name="arrowRight" size={16} style={{ color: "var(--faint)" }} />
        </Link>
      </div>

      <div className="spacer" />
    </main>
  );
}

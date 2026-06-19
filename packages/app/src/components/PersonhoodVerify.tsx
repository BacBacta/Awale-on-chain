"use client";

// Self proof-of-personhood gate (ranked/cash play). MiniPay runs inside a
// mobile WebView, so we use the SDK's "mobile" variant: it renders a deep
// link that opens the Self app already installed on the same phone, rather
// than a QR code meant to be scanned by a second device.

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import type { Address } from "viem";
import type { SelfApp } from "@selfxyz/qrcode";

const SelfQRcodeWrapper = dynamic(() => import("@selfxyz/qrcode").then((m) => m.SelfQRcodeWrapper), {
  ssr: false,
});

const SELF_SCOPE = process.env.NEXT_PUBLIC_SELF_SCOPE;
const SELF_ENDPOINT = process.env.NEXT_PUBLIC_SELF_ENDPOINT;
const SELF_MOCK = process.env.NEXT_PUBLIC_SELF_MOCK_PASSPORT !== "false";
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "11142220") as 42220 | 11142220;

export function PersonhoodVerify({
  account,
  onVerified,
}: {
  account: Address;
  onVerified?: () => void;
}) {
  const [selfApp, setSelfApp] = useState<SelfApp | null>(null);
  const [status, setStatus] = useState<"idle" | "verified" | "error">("idle");

  useEffect(() => {
    if (!SELF_SCOPE || !SELF_ENDPOINT) return;
    let mounted = true;
    import("@selfxyz/qrcode").then(({ SelfAppBuilder }) => {
      if (!mounted) return;
      const app = new SelfAppBuilder({
        appName: "Awalé",
        scope: SELF_SCOPE,
        endpoint: SELF_ENDPOINT,
        userId: account,
        userIdType: "hex",
        devMode: SELF_MOCK,
        chainID: CHAIN_ID,
        disclosures: { minimumAge: 18, ofac: true },
      }).build();
      setSelfApp(app);
    });
    return () => {
      mounted = false;
    };
  }, [account]);

  if (!SELF_SCOPE || !SELF_ENDPOINT) return null; // personhood gating not configured

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span className="muted">Verify you&apos;re human (required for ranked &amp; cash play)</span>
      {status === "verified" && <span>✓ Verified</span>}
      {status === "error" && <span className="muted">Verification failed — try again.</span>}
      {status !== "verified" && selfApp && (
        <SelfQRcodeWrapper
          selfApp={selfApp}
          variant="mobile"
          onSuccess={() => {
            setStatus("verified");
            onVerified?.();
          }}
          onError={() => setStatus("error")}
        />
      )}
    </div>
  );
}

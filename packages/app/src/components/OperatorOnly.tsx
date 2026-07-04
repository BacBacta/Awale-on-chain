"use client";

// Renders its children only when the connected wallet is the operator's.
// This is interface curation, not security: the numbers behind it derive from
// public on-chain data anyway — the point is to keep an ops dashboard out of
// players' faces, where it read as noise (and, at cold start, as "dead app").

import { useEffect, useState } from "react";
import { getInjectedProvider, connect } from "../lib/minipay.js";
import { escrowConfig } from "../lib/escrow.js";

const OPERATOR = (
  process.env.NEXT_PUBLIC_OPERATOR_ADDRESS ?? "0x3154835dEAf9DF60A7aCaf45955236e73aD84502"
).toLowerCase();

export function OperatorOnly({ children }: { children: React.ReactNode }) {
  const [isOperator, setIsOperator] = useState(false);

  useEffect(() => {
    const provider = getInjectedProvider();
    if (!provider) return;
    connect(provider, escrowConfig()?.chainId)
      .then(({ address }) => setIsOperator(address.toLowerCase() === OPERATOR))
      .catch(() => {});
  }, []);

  if (!isOperator) return null;
  return <>{children}</>;
}

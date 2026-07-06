"use client";

import Link from "next/link";

export function Footer() {
  return (
    <footer
      style={{
        padding: "12px 16px",
        borderTop: "1px solid var(--line)",
        background: "rgba(10, 9, 7, 0.5)",
        fontSize: 12,
        color: "var(--faint)",
        display: "flex",
        gap: 16,
        justifyContent: "center",
        flexWrap: "wrap",
      }}
    >
      <Link href="/tos" style={{ color: "inherit", textDecoration: "underline" }}>
        Terms of Service
      </Link>
      <span style={{ opacity: 0.3 }}>·</span>
      <Link href="/privacy" style={{ color: "inherit", textDecoration: "underline" }}>
        Privacy Policy
      </Link>
      <span style={{ opacity: 0.3 }}>·</span>
      <a
        href="mailto:swappilot.exchange@gmail.com"
        style={{ color: "inherit", textDecoration: "underline" }}
      >
        Support
      </a>
    </footer>
  );
}

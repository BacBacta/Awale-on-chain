export default function PrivacyPolicy() {
  return (
    <div className="p-6 max-w-2xl mx-auto prose dark:prose-invert prose-sm">
      <h1>Privacy Policy</h1>
      <p className="text-xs text-gray-500">Last updated: 2026-07-06</p>

      <h2>1. Information We Collect</h2>
      <p>
        Awalé On-Chain collects minimal personal information. We do not store passwords, private keys, or sensitive wallet data.
      </p>
      <ul>
        <li><strong>Wallet Address:</strong> Your on-chain address, visible to all players and on public `/stats`.</li>
        <li><strong>Display Name:</strong> Cached from the Celo ODIS phone-identity service (if available).</li>
        <li><strong>Match History:</strong> All match data (moves, outcomes, stakes) is public on the Celo blockchain.</li>
        <li><strong>Analytics:</strong> Anonymized usage data (page views, game count, revenue) for `/stats`.</li>
      </ul>

      <h2>2. How We Use Your Information</h2>
      <ul>
        <li>To operate the game and settle matches on-chain.</li>
        <li>To display leaderboards and aggregate statistics.</li>
        <li>To prevent fraud and enforce the Terms of Service.</li>
      </ul>

      <h2>3. Data We Do Not Collect</h2>
      <ul>
        <li>Private keys or secrets (never requested or stored).</li>
        <li>IP addresses or device identifiers (unless required by your jurisdiction).</li>
        <li>Location data (beyond MiniPay's geo-gating).</li>
        <li>Cookies or tracking pixels for advertising.</li>
      </ul>

      <h2>4. Blockchain Transparency</h2>
      <p>
        All match data is permanently recorded on the Celo blockchain:
      </p>
      <ul>
        <li>Your wallet address is public.</li>
        <li>Match outcomes, stakes, and timestamps are public.</li>
        <li>Move transcripts are publicly auditable.</li>
      </ul>
      <p>
        We do not control blockchain data; once recorded, it cannot be deleted.
        Review Celo's <a href="https://docs.celo.org" target="_blank" rel="noopener noreferrer">privacy documentation</a> for more.
      </p>

      <h2>5. Third-Party Services</h2>
      <p>
        We use the following services:
      </p>
      <ul>
        <li><strong>MiniPay Wallet:</strong> Injected; we never control or access your wallet.</li>
        <li><strong>Celo RPC Providers:</strong> Public blockchain reads; your address is sent to RPC endpoints.</li>
        <li><strong>ODIS (Celo Payments):</strong> For phone-first display names (opt-in by Celo).</li>
      </ul>
      <p>
        See each service's privacy policy for how they handle your data.
      </p>

      <h2>6. Data Retention</h2>
      <p>
        Match data is retained indefinitely on the blockchain and in our `/stats` indexes.
        You cannot request deletion of blockchain data; it is immutable by design.
      </p>

      <h2>7. Security</h2>
      <p>
        We employ reasonable security measures:
      </p>
      <ul>
        <li>HTTPS for all connections.</li>
        <li>Smart contracts audited and self-reviewed.</li>
        <li>No passwords or secrets stored on our servers.</li>
      </ul>
      <p>
        However, no system is 100% secure. Blockchain and cryptography carry inherent risks.
      </p>

      <h2>8. Your Rights</h2>
      <ul>
        <li><strong>Access:</strong> Your match history is public on the blockchain via any Celo block explorer.</li>
        <li><strong>Deletion:</strong> You cannot delete blockchain data; it is immutable.</li>
        <li><strong>Data Portability:</strong> Export your match history from any block explorer.</li>
      </ul>

      <h2>9. Children</h2>
      <p>
        This Service is not intended for users under 18. If you are under 18, please do not use this Service.
      </p>

      <h2>10. Changes to This Policy</h2>
      <p>
        We may update this Privacy Policy at any time. Continued use of the Service after changes constitutes acceptance.
      </p>

      <h2>11. Contact</h2>
      <p>
        For privacy concerns, contact: <a href="mailto:swappilot.exchange@gmail.com">swappilot.exchange@gmail.com</a>
      </p>
    </div>
  );
}

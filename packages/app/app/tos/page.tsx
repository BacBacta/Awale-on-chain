export default function TermsOfService() {
  return (
    <div className="p-6 max-w-2xl mx-auto prose dark:prose-invert prose-sm">
      <h1>Terms of Service</h1>
      <p className="text-xs text-gray-500">Last updated: 2026-07-06</p>

      <h2>1. Acceptance of Terms</h2>
      <p>
        By using this mini-app ("Service"), you agree to be bound by these Terms of Service.
        If you do not agree to these terms, do not use the Service.
      </p>

      <h2>2. Description of Service</h2>
      <p>
        Awalé On-Chain is a real-money, skill-based Awalé (Oware) game built on the Celo blockchain.
        Players stake stablecoins, and winners are paid on-chain through smart contracts.
      </p>

      <h2>3. User Eligibility</h2>
      <p>
        You must be at least 18 years old and of legal age to enter into contracts.
        The Service is available only to users in jurisdictions where it is legally permitted.
        You are responsible for complying with local laws and regulations.
      </p>

      <h2>4. Smart Contract Risk</h2>
      <p>
        This Service relies on smart contracts deployed on the Celo blockchain.
        Smart contracts carry inherent technical risks, including but not limited to:
      </p>
      <ul>
        <li>Code vulnerabilities or bugs</li>
        <li>Blockchain network forks or failures</li>
        <li>Wallet loss or key compromise</li>
        <li>Stablecoin depegging or issuer failure</li>
      </ul>
      <p>
        By using this Service, you acknowledge these risks and accept full responsibility for any losses.
      </p>

      <h2>5. Stablecoin Custody</h2>
      <p>
        Your stakes are held in the MatchEscrow smart contract.
        Only you (or your opponent, for disputes) can withdraw your stake.
        The smart contract is audited but not insured; loss of funds due to contract bugs is not recoverable.
      </p>

      <h2>6. Dispute Resolution</h2>
      <p>
        Matches are resolved either by mutual agreement (both players sign) or by on-chain dispute.
        Disputes are adjudicated by replaying the signed move transcript on the ReplayVerifier smart contract.
        The contract's decision is final and not subject to appeal.
      </p>

      <h2>7. No Warranty</h2>
      <p>
        THE SERVICE IS PROVIDED "AS-IS" WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
        WE DISCLAIM ALL WARRANTIES, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE,
        AND NON-INFRINGEMENT.
      </p>

      <h2>8. Limitation of Liability</h2>
      <p>
        TO THE FULLEST EXTENT PERMITTED BY LAW, WE SHALL NOT BE LIABLE FOR ANY INDIRECT,
        INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS OR REVENUE.
      </p>

      <h2>9. Prohibited Conduct</h2>
      <p>
        You agree not to:
      </p>
      <ul>
        <li>Attempt to manipulate game outcomes or exploit bugs</li>
        <li>Use automated tools or bots</li>
        <li>Engage in collusion or coordinated play to circumvent rules</li>
        <li>Attempt to access the system in unauthorized ways</li>
      </ul>

      <h2>10. Modifications to Service</h2>
      <p>
        We reserve the right to modify or discontinue this Service at any time.
        Smart contract upgrades may change game rules or economic terms.
      </p>

      <h2>11. Governing Law</h2>
      <p>
        These Terms are governed by the laws applicable where the operator is located.
        Disputes arising from your use of the Service shall be resolved through binding arbitration.
      </p>

      <h2>12. Contact</h2>
      <p>
        For questions or support, contact: <a href="mailto:swappilot.exchange@gmail.com">swappilot.exchange@gmail.com</a>
      </p>
    </div>
  );
}

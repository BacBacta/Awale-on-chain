// Turn raw wallet / contract / RPC errors into short, human messages.
//
// Dumping `ERC20InsufficientAllowance` or a 400-char viem stack at a player is a
// trust killer on a money surface. We pattern-match the common cases and fall
// back to a generic, non-alarming message.

interface Rule {
  test: RegExp;
  msg: string;
}

const RULES: Rule[] = [
  // user-initiated
  { test: /user rejected|user denied|rejected the request|action_rejected|4001/i, msg: "Cancelled in your wallet." },
  // funds
  { test: /insufficient allowance|erc20insufficientallowance/i, msg: "Token approval needed — try again." },
  { test: /insufficient balance|erc20insufficientbalance|transfer amount exceeds balance/i, msg: "Not enough balance for this stake." },
  { test: /insufficient funds/i, msg: "Not enough funds to cover the stake and network fee." },
  // match lifecycle (MatchEscrow reverts)
  { test: /already joined|match: full|not open/i, msg: "This match already has an opponent." },
  { test: /not active|not proposed|already (resolved|settled|voided)/i, msg: "This match is no longer in play." },
  { test: /not a player/i, msg: "This wallet isn't a player in this match." },
  { test: /window closed|match expired|not finalized|start not finalized/i, msg: "This match window has closed." },
  { test: /stake|rake too high|window too short/i, msg: "Invalid match parameters." },
  // network
  { test: /invalid chain id|chain mismatch|does not match the target chain/i, msg: "Wrong network — switch your wallet to Celo and retry." },
  { test: /nonce|replacement transaction underpriced/i, msg: "Network was busy — please retry." },
  { test: /timeout|timed out|network|fetch failed|econnreset/i, msg: "Network hiccup — please retry." },
];

export function humanizeError(e: unknown): string {
  // messages crafted by our own tx layer are already human — pass them through
  const own =
    e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : typeof e === "string" ? e : "";
  if (/taking unusually long|came back automatically|rejected by the network|check Your matches/i.test(own)) return own;
  const raw =
    typeof e === "string"
      ? e
      : e && typeof e === "object" && "message" in e
        ? String((e as { message: unknown }).message)
        : "";
  // viem nests the useful bit in shortMessage / details
  const text = [
    raw,
    e && typeof e === "object" && "shortMessage" in e ? String((e as { shortMessage: unknown }).shortMessage) : "",
    e && typeof e === "object" && "details" in e ? String((e as { details: unknown }).details) : "",
  ].join(" ");

  for (const r of RULES) if (r.test.test(text)) return r.msg;
  return "Something went wrong. Please try again.";
}

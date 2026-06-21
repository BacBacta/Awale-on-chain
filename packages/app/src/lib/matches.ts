// Device-local index of matches this player created or joined, so the app can
// show a "Your matches" surface. Session keys live in sessionStorage (cleared on
// tab close); this durable list lives in localStorage and only holds match ids.

const KEY = "awale.matches";

export function recordLocalMatch(matchId: bigint): void {
  if (typeof localStorage === "undefined") return;
  try {
    const ids = listLocalMatches();
    if (!ids.includes(matchId)) {
      localStorage.setItem(KEY, JSON.stringify([matchId.toString(), ...ids.map((i) => i.toString())]));
    }
  } catch {
    /* ignore quota/serialization issues */
  }
}

export function listLocalMatches(): bigint[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    return (JSON.parse(raw) as string[]).map((s) => BigInt(s));
  } catch {
    return [];
  }
}

// MatchEscrow.Status enum
export const STATUS = {
  None: 0,
  Open: 1,
  Active: 2,
  Proposed: 3,
  Resolved: 4,
  Cancelled: 5,
  Voided: 6,
} as const;

export interface StatusView {
  label: string;
  tone: "" | "positive" | "gold" | "danger";
  /** true while the match is still playable/live. */
  live: boolean;
}

export function statusView(status: number): StatusView {
  switch (status) {
    case STATUS.Open:
      return { label: "Waiting for opponent", tone: "gold", live: true };
    case STATUS.Active:
      return { label: "In progress", tone: "positive", live: true };
    case STATUS.Proposed:
      return { label: "Settling", tone: "gold", live: true };
    case STATUS.Resolved:
      return { label: "Finished", tone: "", live: false };
    case STATUS.Cancelled:
      return { label: "Cancelled", tone: "danger", live: false };
    case STATUS.Voided:
      return { label: "Refunded", tone: "", live: false };
    default:
      return { label: "Unknown", tone: "", live: false };
  }
}

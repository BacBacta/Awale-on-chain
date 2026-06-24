// Real-money eligibility gate. Before any cash stake or tournament entry the
// player must attest they are 18+ and legally allowed to play skill games for
// money where they are. Persisted once (localStorage). This is a product-level
// control; true geo-fencing needs an edge/geo-IP layer (see
// docs/minipay-listing-readiness.md).

const KEY = "awale_cash_eligibility_v1";

export function cashEligible(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function acknowledgeEligibility(): void {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    /* ignore */
  }
}

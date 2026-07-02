// Display identity. The architecture forbids showing a raw 0x… as the primary
// label. Real phone-first names come from ODIS + FederatedAttestations on the
// backend (mainnet, funded quota); until a name resolves we show a deterministic,
// friendly handle derived from the address — never the bare 0x.

const ADJECTIVES = [
  "Swift", "Brave", "Clever", "Bold", "Wise", "Sly", "Calm", "Fierce",
  "Lucky", "Noble", "Quick", "Sharp", "Bright", "Keen", "Royal", "Mighty",
];
const ANIMALS = [
  "Lion", "Falcon", "Cobra", "Panther", "Eagle", "Jackal", "Gazelle", "Rhino",
  "Mamba", "Leopard", "Hawk", "Crane", "Heron", "Oryx", "Caracal", "Serval",
];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A stable, friendly handle for an address (e.g. "Swift Falcon"). */
export function friendlyName(address?: string | null): string {
  if (!address) return "Player";
  const h = hash(address.toLowerCase());
  // unsigned shift: `>>` re-signs the hash and a negative index reads
  // undefined — half of all addresses rendered as e.g. "Royal undefined"
  return `${ADJECTIVES[h % ADJECTIVES.length]} ${ANIMALS[(h >>> 8) % ANIMALS.length]}`;
}

/** Primary display label: a resolved (ODIS) name if present, else the handle. */
export function displayName(address?: string | null, resolved?: string | null): string {
  if (resolved && resolved.trim()) return resolved.trim();
  return friendlyName(address);
}

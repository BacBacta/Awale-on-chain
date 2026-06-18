// Phone-first identity. Never show a raw 0x… as the primary identifier; a
// shortened address is only a faint secondary fallback when no name/phone is
// resolved (via ODIS + FederatedAttestations on the backend).

export interface Identity {
  name?: string;
  phone?: string; // E.164
  address: string;
}

export function shortAddress(address: string): string {
  if (address.length < 11) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Mask a phone number, showing only the country prefix and last two digits. */
export function maskPhone(phone: string): string {
  if (phone.length < 4) return phone;
  const last2 = phone.slice(-2);
  return `${phone.slice(0, 3)}••••${last2}`;
}

/** Primary display label, phone-first; address is only the last resort. */
export function displayName(id: Identity): string {
  if (id.name && id.name.trim()) return id.name.trim();
  if (id.phone && id.phone.trim()) return maskPhone(id.phone.trim());
  return shortAddress(id.address);
}

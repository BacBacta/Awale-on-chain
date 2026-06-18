// E.164 phone normalisation. Display names are phone-first (resolved via ODIS),
// so numbers must be canonicalised before they are used as ODIS identifiers.

/** Normalise to strict E.164 (`+` country-code then digits) or throw. */
export function normalizePhone(raw: string): string {
  const trimmed = raw.replace(/[\s\-().]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(trimmed)) {
    throw new Error("invalid E.164 phone number");
  }
  return trimmed;
}

export function isValidE164(raw: string): boolean {
  try {
    normalizePhone(raw);
    return true;
  } catch {
    return false;
  }
}

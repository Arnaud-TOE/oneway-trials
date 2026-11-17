/**
 * Outbound tripwire.
 *
 * The architecture already keeps the private record out of every cloud call:
 * cloud prompts are built only from public registry text. This module is the
 * second line of defence. Any text registered as private is fingerprinted, and
 * every payload about to leave the device is checked against those fingerprints.
 * A match throws and the request is never sent.
 */

const SHINGLE_WORDS = 6;

export class LeakError extends Error {
  constructor(public readonly destination: string) {
    super(`Blocked: a request to ${destination} contained text from the private record.`);
    this.name = "LeakError";
  }
}

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.%/+-]+/gu, " ")
    .trim();
}

function shingles(text: string, size = SHINGLE_WORDS): Set<string> {
  const words = normalize(text).split(" ").filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + size <= words.length; i++) {
    out.add(words.slice(i, i + size).join(" "));
  }
  return out;
}

export class PrivacyGuard {
  private fingerprints = new Set<string>();
  /** Short private values (names, IDs, dates) that must never appear verbatim. */
  private exactValues = new Set<string>();

  /** Registers private text. Call this before anything else is done with the record. */
  registerPrivateText(text: string): void {
    for (const s of shingles(text)) this.fingerprints.add(s);
  }

  /** Registers a short private value that is too short to fingerprint, such as a name. */
  registerPrivateValue(value: string): void {
    const v = normalize(value);
    if (v.length >= 4) this.exactValues.add(v);
  }

  clear(): void {
    this.fingerprints.clear();
    this.exactValues.clear();
  }

  get isEmpty(): boolean {
    return this.fingerprints.size === 0 && this.exactValues.size === 0;
  }

  /** Returns true when the payload shares a passage with registered private text. */
  containsPrivateText(payload: string): boolean {
    if (this.isEmpty) return false;
    const norm = normalize(payload);
    for (const v of this.exactValues) {
      if (norm.includes(v)) return true;
    }
    if (this.fingerprints.size === 0) return false;
    for (const s of shingles(payload)) {
      if (this.fingerprints.has(s)) return true;
    }
    return false;
  }

  /** Throws LeakError when the payload must not leave the device. */
  assertPublic(payload: string, destination: string): void {
    if (this.containsPrivateText(payload)) throw new LeakError(destination);
  }
}

/** The single guard instance used by the running app. */
export const privacyGuard = new PrivacyGuard();

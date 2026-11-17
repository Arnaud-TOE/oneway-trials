/**
 * Privacy ledger: an append-only, in-memory record of every model call and every
 * network request the engine makes. The interface renders it in two lanes so the
 * person can see exactly what stayed on the device and what left it.
 */

export type Lane = "device" | "outbound";

export type StepKind = "file" | "ocr" | "memory" | "transcribe" | "read-basics" | "read-details" | "search" | "cache" | "compile" | "judge" | "summary" | "explain";

export interface LedgerEntry {
  id: number;
  at: number;
  lane: Lane;
  /** Short description, e.g. "Read your record" or "Compiled trial NCT01234567". */
  label: string;
  /** What kind of step this was. Used to replay a recorded run faithfully. */
  kind?: StepKind;
  /** What the step was about: a trial id, or "trialId:criterionId". */
  ref?: string;
  /** For outbound entries: who received the request. */
  destination?: "Gemini (cloud)" | "ClinicalTrials.gov" | "Firestore (shared cache)";
  /** Requested inference mode, when a model was involved. */
  mode?: string;
  /** Where inference actually ran, as reported by the SDK. */
  source?: "on_device" | "in_cloud";
  ms?: number;
  /**
   * Outbound entries: the exact text that left the device, shown in full.
   * Device entries: never stored here; only a size is recorded.
   */
  payload?: string;
  privateChars?: number;
}

type Listener = (entries: readonly LedgerEntry[]) => void;

class Ledger {
  private entries: LedgerEntry[] = [];
  private listeners = new Set<Listener>();
  private nextId = 1;

  record(entry: Omit<LedgerEntry, "id" | "at">): LedgerEntry {
    const full: LedgerEntry = { ...entry, id: this.nextId++, at: Date.now() };
    this.entries = [...this.entries, full];
    for (const l of this.listeners) l(this.entries);
    return full;
  }

  all(): readonly LedgerEntry[] {
    return this.entries;
  }

  outbound(): readonly LedgerEntry[] {
    return this.entries.filter((e) => e.lane === "outbound");
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.entries = [];
    for (const l of this.listeners) l(this.entries);
  }
}

export const ledger = new Ledger();

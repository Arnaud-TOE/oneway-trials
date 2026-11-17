import { del, get, set } from "idb-keyval";
import type { PersonAnswer } from "../engine/match";
import type { CompiledCriterion, CriterionResult, Profile, RecordLevel } from "../engine/types";

/**
 * What OneWay keeps on this computer when the person asks it to.
 *
 * It is stored in this browser's own storage (IndexedDB) and never sent
 * anywhere. It lets the person come back without the record being read again,
 * see which trials are new since the last visit, and keep their list of trials
 * with their notes. "Forget" deletes all of it. Nothing is kept unless the
 * person says yes.
 */

export const MEMORY_KEY = "oneway-memory-v1";

export type FollowUp = "to-discuss" | "discussed" | "contacted" | "not-for-me";

export const FOLLOW_UP_LABEL: Record<FollowUp, string> = {
  "to-discuss": "To discuss with my doctor",
  discussed: "Discussed with my doctor",
  contacted: "Contacted the study team",
  "not-for-me": "Not for me",
};

export interface SavedTrial {
  nctId: string;
  title: string;
  url: string;
  savedAt: string;
  followUp: FollowUp;
  note: string;
  /** Where it recruits, as shown when it was saved. */
  place: string;
}

/** The model's answers about one trial, kept so they are not asked again. */
export interface TrialCheck {
  /** Ties the answers to the exact criteria they were given for. */
  criteriaSig: string;
  checkedAt: string;
  /** Answers from the model only; plain-code results are always recomputed. */
  results: CriterionResult[];
}

export interface Memory {
  version: 1;
  savedAt: string;
  level: RecordLevel;
  sampleId: string | null;
  record: string;
  profile: Profile;
  query: { condition: string; location: string };
  /** Names of the documents the record came from. Their content is in `record`. */
  documents: string[];
  /** When each trial was first seen, to point out the new ones next time. */
  seen: Record<string, string>;
  checks: Record<string, TrialCheck>;
  saved: Record<string, SavedTrial>;
  answers: Record<string, Record<string, PersonAnswer>>;
}

function isMemory(value: unknown): value is Memory {
  const m = value as Partial<Memory> | null;
  return Boolean(m && m.version === 1 && typeof m.record === "string" && m.profile && m.query && m.saved && m.answers && m.seen && m.checks);
}

/** Reads what is kept on this computer. Returns null when nothing is kept or storage is unavailable. */
export async function loadMemory(): Promise<Memory | null> {
  try {
    const value = await get(MEMORY_KEY);
    return isMemory(value) ? value : null;
  } catch {
    return null;
  }
}

export async function saveMemory(memory: Memory): Promise<boolean> {
  try {
    await set(MEMORY_KEY, memory);
    return true;
  } catch {
    return false;
  }
}

export async function forgetMemory(): Promise<void> {
  try {
    await del(MEMORY_KEY);
  } catch {
    // Nothing kept, or storage blocked: either way nothing remains to delete.
  }
}

/** A short fingerprint of a trial's criteria: kept answers are reused only for the very same criteria. */
export function criteriaSignature(criteria: CompiledCriterion[]): string {
  let h = 5381;
  for (const c of criteria) {
    const s = `${c.id}|${c.kind}|${c.text}|${c.ask ?? ""}\n`;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

/** The model's answers kept for a trial, if they were given for exactly these criteria. */
export function keptAnswers(check: TrialCheck | undefined, criteria: CompiledCriterion[]): CriterionResult[] {
  if (!check || check.criteriaSig !== criteriaSignature(criteria)) return [];
  const ids = new Set(criteria.map((c) => c.id));
  return check.results.filter((r) => r.decidedBy !== "rules" && r.decidedBy !== "person" && ids.has(r.criterion.id));
}

/** "16 November 2026". */
export function dayLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

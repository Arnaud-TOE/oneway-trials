import type { LedgerEntry } from "../engine/ledger";
import type { CriterionResult, Trial, TrialFit } from "../engine/types";
import type { TrialState } from "./session";

/**
 * Small pure helpers behind what the screens show: counts, time estimates,
 * places, and the text handed to the person for their doctor.
 */

export interface Tally {
  fits: number;
  open: number;
  blockers: number;
  noSign: number;
}

export function tally(results: CriterionResult[]): Tally {
  const t: Tally = { fits: 0, open: 0, blockers: 0, noSign: 0 };
  for (const r of results) {
    if (r.assumed) t.noSign++;
    else if (r.outcome === "ok") t.fits++;
    else if (r.outcome === "blocker") t.blockers++;
    else t.open++;
  }
  return t;
}

export type Bucket = TrialFit | "unchecked";

/** Which group a trial belongs to in the overview and its filters. */
export function bucketOf(t: TrialState): Bucket {
  if (t.status === "done" && t.match) return t.match.fit;
  // Plain code can rule a trial out before the model is asked anything.
  if (t.match && t.match.counts.blocker > 0) return "unlikely";
  return "unchecked";
}

export const BUCKET_LABEL: Record<Bucket, string> = {
  worth_discussing: "Worth discussing",
  possible: "Possible",
  unlikely: "Probably not a fit",
  unchecked: "Not checked yet",
};

export function countBuckets(trials: TrialState[]): Record<Bucket, number> {
  const counts: Record<Bucket, number> = { worth_discussing: 0, possible: 0, unlikely: 0, unchecked: 0 };
  for (const t of trials) counts[bucketOf(t)]++;
  return counts;
}

const BUCKET_ORDER: Record<Bucket, number> = { worth_discussing: 0, possible: 1, unchecked: 2, unlikely: 3 };

/**
 * The best news first: worth discussing, possible, not checked yet, then probably
 * not a fit. The registry order is kept within each group, and nothing moves
 * while trials are still being checked, so cards do not jump under the reader.
 */
export function orderForReading(trials: TrialState[], busy: boolean): TrialState[] {
  if (busy) return trials;
  return trials
    .map((t, i) => ({ t, i }))
    .sort((a, b) => BUCKET_ORDER[bucketOf(a.t)] - BUCKET_ORDER[bucketOf(b.t)] || a.i - b.i)
    .map((x) => x.t);
}

/** True while something can still be checked on a trial. */
export function canStillCheck(t: TrialState): boolean {
  return t.status === "waiting" || t.status === "ready" || t.status === "error" || t.status === "compiling";
}

const LAB_LABEL: Record<string, string> = {
  creatinine: "Creatinine",
  bilirubin_total: "Total bilirubin",
  anc: "ANC",
  platelets: "Platelets",
  hemoglobin: "Hemoglobin",
  wbc: "White cells",
  alt: "ALT",
  ast: "AST",
  hba1c: "HbA1c",
  egfr: "eGFR",
  lvef: "LVEF",
};

/** A lab value as a person would write it: "ANC 3 x10^9/L". */
export function labText(lab: { name: string; value: number; unit: string }): string {
  return `${LAB_LABEL[lab.name] ?? lab.name.replace(/_/g, " ")} ${lab.value}${lab.unit ? ` ${lab.unit}` : ""}`;
}

const wordsOf = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * True when an "other condition" only restates the diagnosis, such as
 * "metastatic breast cancer" next to a diagnosis of metastatic breast carcinoma.
 * It must add no word beyond the diagnosis and its general name; "type 2
 * diabetes with nephropathy" adds one, so it is kept.
 */
export function sameCondition(condition: string, primary: string, searchTerm = ""): boolean {
  const words = wordsOf(condition);
  if (words.length === 0) return true;
  const known = new Set([...wordsOf(primary), ...wordsOf(searchTerm)]);
  return words.every((w) => known.has(w));
}

/**
 * The place the record gives, offered as the search location. Only a short
 * place whose words all appear in the record is offered: a model's guess is
 * not. The person still sees it, can change it, and approves before it is sent.
 */
export function suggestedLocation(location: string, record: string): string {
  // "Lives near Chicago" gives "near Chicago", and the registry finds nothing "near Chicago": keep the place only.
  let place = location.replace(/\s+/g, " ").trim().replace(/[.;]+$/, "");
  for (let i = 0; i < 3; i++) {
    place = place.replace(/^(?:lives?|living|based|resides?|residing|near|in|at|around|outside(?:\s+of)?|close\s+to|from|the)\s+/i, "");
  }
  place = place.replace(/\s+(?:area|region|metro(?:politan)?(?:\s+area)?|suburbs?)$/i, "").trim();
  if (place.length < 2 || place.length > 40) return "";
  // Whole words only: "IL" must not count as found inside "Illinois".
  const inRecord = new Set(record.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const words = place.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0 || words.length > 4) return "";
  return words.every((w) => inRecord.has(w)) ? place : "";
}

/** Used when this session has not timed an on-device answer yet. Measured on a laptop with no graphics card. */
export const DEFAULT_MS_PER_CRITERION = 15000;

/**
 * Average time to judge one criterion in this session, so estimates fit this
 * computer. Each on-device call reads one part of the record; a long record in
 * N parts needs up to N calls per criterion.
 */
export function msPerCriterion(entries: readonly LedgerEntry[], parts = 1): number {
  const timed = entries.filter((e) => e.lane === "device" && e.kind === "judge" && typeof e.ms === "number" && e.ms > 0);
  const perCall = timed.length === 0 ? DEFAULT_MS_PER_CRITERION : timed.reduce((sum, e) => sum + (e.ms ?? 0), 0) / timed.length;
  return Math.round(perCall * Math.max(1, parts));
}

/** "about 40 seconds", "about 3 minutes". Deliberately rough. */
export function roughDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 8) return "a few seconds";
  if (seconds < 50) return `about ${Math.round(seconds / 10) * 10} seconds`;
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes === 1 ? "about a minute" : `about ${minutes} minutes`;
}

/** Elapsed time as "0:07" or "2:15". */
export function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export interface Places {
  /** A short line such as "Boston, MA and 11 other sites". */
  label: string;
  /** True when one of the trial's sites matches the place the person searched near. */
  near: boolean;
}

/** Where a trial recruits, with the place the person searched near put first. */
export function placesOf(trial: Trial, searchedNear: string): Places {
  const names = [...new Set(trial.locations.map((l) => [l.city, l.state || l.country].filter(Boolean).join(", ")).filter(Boolean))];
  if (names.length === 0) return { label: "", near: false };
  const wanted = searchedNear.trim().toLowerCase();
  const hit = wanted ? names.find((n) => n.toLowerCase().includes(wanted) || wanted.includes(n.split(",")[0].toLowerCase())) : undefined;
  const first = hit ?? names[0];
  const others = names.length - 1;
  return {
    label: others === 0 ? first : `${first} and ${others} other ${others === 1 ? "site" : "sites"}`,
    near: Boolean(hit),
  };
}

/** Plain text of what to ask a doctor about one trial. Built on the device, copied only when the person asks. */
export function questionsFor(t: TrialState): string {
  const results = t.match?.results ?? [];
  const open = results.filter((r) => r.outcome === "unknown");
  const blockers = results.filter((r) => r.outcome === "blocker");
  const lines = [`${t.trial.title}`, `${t.trial.nctId} · ${t.trial.url}`, ""];
  if (open.length > 0) {
    lines.push("Not in my record, to confirm:");
    for (const r of open) lines.push(`- ${r.criterion.text}`);
    lines.push("");
  }
  if (blockers.length > 0) {
    lines.push("May rule this trial out, to check:");
    for (const r of blockers) lines.push(`- ${r.criterion.text}${r.evidence ? ` (my record: ${r.evidence})` : ""}`);
    lines.push("");
  }
  if (open.length === 0 && blockers.length === 0) lines.push("No open question was found in the criteria checked so far.", "");
  if (t.pending > 0) lines.push(`${t.pending} of this trial's criteria have not been checked yet.`);
  lines.push("Prepared with OneWay. It does not decide who can join a trial; only the trial team can.");
  return lines.join("\n");
}

function icsDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * A calendar reminder to look for new trials again. It names no condition and
 * no treatment: calendars are often synced to a cloud service, and the person's
 * health must not travel with the reminder.
 */
export function reminderIcs(at: Date, appUrl: string, now: Date = new Date()): string {
  const start = new Date(at);
  start.setHours(10, 0, 0, 0);
  const end = new Date(start.getTime() + 15 * 60000);
  const uid = `${now.getTime()}-${Math.random().toString(36).slice(2)}@oneway`;
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//OneWay//Reminder//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${icsDate(now)}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    "SUMMARY:Look again for clinical trials (OneWay)",
    `DESCRIPTION:New trials open every week. Open OneWay in Chrome on this computer: ${appUrl}`,
    `URL:${appUrl}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "DESCRIPTION:Look again for clinical trials",
    "TRIGGER:-PT0M",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

/** Text for the browser tab while work is running, so progress shows from another tab. */
export function tabTitle(phase: string, trials: TrialState[], base = "OneWay — private clinical trial matching"): string {
  if (phase === "reading") return "Reading your record… · OneWay";
  if (phase !== "results") return base;
  const busy = trials.some((t) => t.status === "checking" || t.status === "queued");
  const checked = trials.filter((t) => t.status === "done").length;
  if (busy) return `Checking… ${checked} of ${trials.length} done · OneWay`;
  return checked > 0 ? `${checked} of ${trials.length} trials checked · OneWay` : base;
}

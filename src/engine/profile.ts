import { generate, InferenceMode } from "../lib/hybrid";
import { applyNegationGuard, dropUnmentioned, mergeNeverReceived } from "./evidence";
import { PART_CHARS, readableParts } from "./parts";
import { privacyGuard } from "./privacy";
import { LAB_NAMES, type Lab, type LabName, type Profile, type RecordLevel, type Therapy, type Tri } from "./types";

/** Longest text the on-device model is asked to read in one call. A longer record is read in parts (parts.ts). */
export const MAX_RECORD_CHARS = PART_CHARS;

const BASICS_SYSTEM = `You extract facts from a patient record into JSON. Use only what the record states.
Use null, "unknown" or an empty string when the record does not say.
"primaryCondition" is the main diagnosis as the record describes it.
"searchTerm" is the general name of that disease in at most three words, with no stage, side, subtype or receptor status, such as "breast cancer", "lung cancer", "multiple myeloma" or "type 2 diabetes".`;

const BASICS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["age", "sex", "primaryCondition", "searchTerm", "conditions", "ecog", "pregnant", "location"],
  properties: {
    age: { type: ["integer", "null"] },
    sex: { type: "string", enum: ["female", "male", "unknown"] },
    primaryCondition: { type: "string" },
    searchTerm: { type: "string" },
    conditions: { type: "array", items: { type: "string" }, maxItems: 6 },
    ecog: { type: ["integer", "null"] },
    pregnant: { type: "string", enum: ["yes", "no", "unknown"] },
    location: { type: "string" },
  },
};

const DETAILS_SYSTEM = `You extract treatments and lab values from a patient record into JSON. Use only what the record states.
For each treatment the record names, set status "received" if the patient took it, or "never_received" if the record says the patient did not take it.
For labs, only report these tests when the record gives a number: ${LAB_NAMES.join(", ")}. Copy the value and unit exactly.`;

const DETAILS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["therapies", "labs"],
  properties: {
    therapies: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "status"],
        properties: {
          name: { type: "string" },
          status: { type: "string", enum: ["received", "never_received"] },
        },
      },
    },
    labs: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "value", "unit"],
        properties: {
          name: { type: "string", enum: [...LAB_NAMES] },
          value: { type: "number" },
          unit: { type: "string" },
        },
      },
    },
  },
};

interface Basics {
  age: number | null;
  sex: string;
  primaryCondition: string;
  searchTerm?: string;
  conditions: string[];
  ecog: number | null;
  pregnant: string;
  location: string;
}

interface Details {
  therapies: { name: string; status: string }[];
  labs: { name: string; value: number; unit: string }[];
}

function tri(v: unknown): Tri {
  return v === "yes" || v === "no" ? v : "unknown";
}

/** Keeps only lab values whose number really appears in the record. */
export function verifyLabs(labs: Details["labs"], record: string): Lab[] {
  const out: Lab[] = [];
  const seen = new Set<string>();
  for (const l of labs ?? []) {
    if (!(LAB_NAMES as readonly string[]).includes(l.name)) continue;
    if (typeof l.value !== "number" || !Number.isFinite(l.value)) continue;
    if (seen.has(l.name)) continue;
    const digits = String(l.value);
    const pattern = new RegExp(`(^|[^\\d.])${digits.replace(".", "\\.")}0*($|[^\\d])`);
    if (!pattern.test(record)) continue;
    seen.add(l.name);
    out.push({ name: l.name as LabName, value: l.value, unit: String(l.unit ?? "").trim() });
  }
  return out;
}

/**
 * Keeps the registry search term coarse: letters only, at most four words. This
 * is the one piece of health information the person may choose to send out.
 */
export function coarseSearchTerm(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9 -]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .join(" ");
}

/** Applies every deterministic check to the raw model output. Pure, so it can be tested. */
export function buildProfile(basics: Basics, details: Details, record: string): Profile {
  const age = typeof basics.age === "number" && basics.age >= 0 && basics.age <= 120 && record.includes(String(basics.age)) ? basics.age : null;
  const ecog = typeof basics.ecog === "number" && basics.ecog >= 0 && basics.ecog <= 5 && /ecog|performance status/i.test(record) ? basics.ecog : null;
  const rawTherapies: Therapy[] = (details.therapies ?? []).map((t) => ({
    name: String(t.name ?? "").trim(),
    status: t.status === "never_received" ? "never_received" : "received",
  }));
  return {
    age,
    sex: basics.sex === "female" || basics.sex === "male" ? basics.sex : "unknown",
    primaryCondition: String(basics.primaryCondition ?? "").trim(),
    searchTerm: coarseSearchTerm(String(basics.searchTerm ?? "")),
    conditions: (basics.conditions ?? []).map((c) => String(c).trim()).filter(Boolean),
    ecog,
    pregnant: tri(basics.pregnant),
    location: String(basics.location ?? "").trim(),
    therapies: mergeNeverReceived(applyNegationGuard(dropUnmentioned(rawTherapies, record), record), record),
    labs: verifyLabs(details.labs, record),
  };
}

export interface ExtractProgress {
  step: "basics" | "details" | "done";
}

/** Inference mode for anything that reads the record, by sensitivity. */
export function modeFor(level: RecordLevel) {
  return level === "private" ? InferenceMode.ONLY_ON_DEVICE : InferenceMode.PREFER_ON_DEVICE;
}

export type { Basics, Details };

/**
 * First pass over the record: who the patient is and what the main diagnosis is.
 * Enough to propose a registry search while the second pass is still running.
 *
 * A private record is read strictly on the device (ONLY_ON_DEVICE). If the
 * on-device model is not available this throws: a real record is never sent to
 * the cloud as a fallback. A built-in fictional sample is not private and uses
 * PREFER_ON_DEVICE instead.
 */
/** Reports which part of a long record is being read. */
export type PartProgress = (part: number, parts: number) => void;

function partLabel(base: string, part: number, parts: number): string {
  return parts > 1 ? `${base} (part ${part} of ${parts})` : base;
}

function hasBasics(b: Basics): boolean {
  return b.age !== null && (b.sex === "female" || b.sex === "male") && Boolean(b.primaryCondition?.trim());
}

/**
 * Combines what was read from the parts of a long record: the first value
 * found for each fact, in reading order, and every other condition named.
 * Each value is still checked against the whole record by buildProfile.
 */
export function mergeBasics(list: Basics[]): Basics {
  const first = <T,>(pick: (b: Basics) => T | null | undefined, ok: (v: T) => boolean): T | undefined => {
    for (const b of list) {
      const v = pick(b);
      if (v !== null && v !== undefined && ok(v)) return v;
    }
    return undefined;
  };
  const conditions: string[] = [];
  for (const b of list) {
    for (const c of b.conditions ?? []) if (!conditions.some((x) => x.toLowerCase() === String(c).toLowerCase())) conditions.push(String(c));
  }
  const pregnant = list.some((b) => b.pregnant === "yes") ? "yes" : list.some((b) => b.pregnant === "no") ? "no" : "unknown";
  return {
    age: first((b) => b.age, (v) => typeof v === "number") ?? null,
    sex: first((b) => b.sex, (v) => v === "female" || v === "male") ?? "unknown",
    primaryCondition: first((b) => b.primaryCondition, (v) => String(v).trim() !== "") ?? "",
    searchTerm: first((b) => b.searchTerm, (v) => String(v).trim() !== "") ?? "",
    conditions: conditions.slice(0, 8),
    ecog: first((b) => b.ecog, (v) => typeof v === "number") ?? null,
    pregnant,
    location: first((b) => b.location, (v) => String(v).trim() !== "") ?? "",
  };
}

/** Combines treatments and lab values read from the parts of a long record. */
export function mergeDetails(list: Details[]): Details {
  const therapies: Details["therapies"] = [];
  const labs: Details["labs"] = [];
  for (const d of list) {
    for (const t of d.therapies ?? []) {
      if (!therapies.some((x) => x.name.toLowerCase() === String(t.name).toLowerCase())) therapies.push(t);
    }
    for (const l of d.labs ?? []) if (!labs.some((x) => x.name === l.name)) labs.push(l);
  }
  return { therapies, labs };
}

/**
 * First pass over the record: who the patient is and what the main diagnosis is.
 * Enough to propose a registry search while the second pass is still running.
 * In a long record, the next parts are read only if age, sex or diagnosis is
 * still missing: they are usually at the top.
 *
 * A private record is read strictly on the device (ONLY_ON_DEVICE). If the
 * on-device model is not available this throws: a real record is never sent to
 * the cloud as a fallback. A built-in fictional sample is not private and uses
 * PREFER_ON_DEVICE instead.
 */
export async function extractBasics(record: string, level: RecordLevel = "private", signal?: AbortSignal, onPart?: PartProgress): Promise<Basics> {
  if (level === "private") privacyGuard.registerPrivateText(record);
  const parts = readableParts(record);
  const read: Basics[] = [];
  for (let i = 0; i < parts.length; i++) {
    onPart?.(i + 1, parts.length);
    const res = await generate<Basics>({
      mode: modeFor(level),
      label: partLabel("Read the record: age, sex, diagnosis", i + 1, parts.length),
      kind: "read-basics",
      system: BASICS_SYSTEM,
      prompt: ["Patient record:", parts[i]].join(String.fromCharCode(10)),
      schema: BASICS_SCHEMA,
      signal,
    });
    read.push(res.data);
    if (hasBasics(mergeBasics(read))) break;
  }
  return read.length === 1 ? read[0] : mergeBasics(read);
}

/** Second pass over the record: treatments and lab values, from every part. Same privacy rules as the first. */
export async function extractDetails(record: string, level: RecordLevel = "private", signal?: AbortSignal, onPart?: PartProgress): Promise<Details> {
  if (level === "private") privacyGuard.registerPrivateText(record);
  const parts = readableParts(record);
  const read: Details[] = [];
  for (let i = 0; i < parts.length; i++) {
    onPart?.(i + 1, parts.length);
    const res = await generate<Details>({
      mode: modeFor(level),
      label: partLabel("Read the record: treatments and lab values", i + 1, parts.length),
      kind: "read-details",
      system: DETAILS_SYSTEM,
      prompt: ["Patient record:", parts[i]].join(String.fromCharCode(10)),
      schema: DETAILS_SCHEMA,
      signal,
    });
    read.push(res.data);
  }
  return read.length === 1 ? read[0] : mergeDetails(read);
}

export const NO_DETAILS: Details = { therapies: [], labs: [] };

/** Reads the whole record in both passes and returns the verified profile. */
export async function extractProfile(
  record: string,
  onProgress?: (p: ExtractProgress) => void,
  level: RecordLevel = "private",
): Promise<Profile> {
  onProgress?.({ step: "basics" });
  const basics = await extractBasics(record, level);
  onProgress?.({ step: "details" });
  const details = await extractDetails(record, level);
  onProgress?.({ step: "done" });
  return buildProfile(basics, details, record);
}

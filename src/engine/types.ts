/** "met": the statement is true for the patient. "not_met": it is false. "unknown": the record does not say. */
export type Verdict = "met" | "not_met" | "unknown";
export type Tri = "yes" | "no" | "unknown";

/** Lab tests the deterministic engine understands. Anything else is judged semantically. */
export const LAB_NAMES = [
  "creatinine",
  "bilirubin_total",
  "anc",
  "platelets",
  "hemoglobin",
  "wbc",
  "alt",
  "ast",
  "hba1c",
  "egfr",
  "lvef",
] as const;
export type LabName = (typeof LAB_NAMES)[number];

/** Fields a compiled criterion may reference for a deterministic check. */
export const RULE_FIELDS = ["age", "sex", "ecog", "pregnant", ...LAB_NAMES] as const;
export type RuleField = (typeof RULE_FIELDS)[number];

export interface Therapy {
  name: string;
  /** Explicit status, because "never received X" must not be read as "received X". */
  status: "received" | "never_received";
}

export interface Lab {
  name: LabName;
  value: number;
  unit: string;
}

/** Structured facts extracted on-device from the private record. Never leaves the browser. */
export interface Profile {
  age: number | null;
  sex: "female" | "male" | "unknown";
  /** Main diagnosis as the record describes it. Stays on the device. */
  primaryCondition: string;
  /**
   * General disease name used to search the public registry, e.g. "breast cancer".
   * Deliberately coarse: no stage, side, subtype or receptor status.
   */
  searchTerm: string;
  conditions: string[];
  ecog: number | null;
  pregnant: Tri;
  /** City or region as written in the record, if any. */
  location: string;
  therapies: Therapy[];
  labs: Lab[];
}

export type CriterionKind = "inclusion" | "exclusion";
export type CheckType = "numeric" | "categorical" | "semantic";
export type Operator = ">=" | "<=" | ">" | "<" | "=";

/** One atomic eligibility condition, compiled in the cloud from public registry text. */
export interface CompiledCriterion {
  id: string;
  kind: CriterionKind;
  /** Exact quote of the public source text. Verified against the source before use. */
  text: string;
  /**
   * The same criterion as one plain yes/no question, written by the cloud model
   * for the on-device model. "yes" means the criterion text is true for the patient.
   */
  ask?: string;
  check: CheckType;
  field?: RuleField;
  operator?: Operator;
  /** Numeric threshold for numeric checks. */
  value?: number;
  unit?: string;
  /** Expected category for categorical checks, e.g. "female" or "yes". */
  category?: string;
}

export interface Trial {
  nctId: string;
  title: string;
  summary: string;
  conditions: string[];
  sponsor: string;
  phases: string[];
  studyType: string;
  status: string;
  /** Raw public eligibility text. */
  criteriaText: string;
  minAgeYears: number | null;
  maxAgeYears: number | null;
  sex: "ALL" | "FEMALE" | "MALE";
  healthyVolunteers: boolean;
  locations: {
    facility: string;
    city: string;
    state: string;
    country: string;
    /** The site's own recruiting status, such as "RECRUITING" or "NOT_YET_RECRUITING". */
    status?: string;
    /** Public contacts for this site. */
    contacts?: { name: string; phone: string; email: string }[];
  }[];
  /** Public contacts for the whole trial, as published in the registry. */
  contacts?: { name: string; phone: string; email: string }[];
  /** Date of the last update posted in the registry, "YYYY-MM-DD". */
  updatedOn?: string;
  url: string;
}

/** How a single criterion ended up for this patient. */
export type Outcome = "ok" | "blocker" | "unknown";

export interface CriterionResult {
  criterion: CompiledCriterion;
  verdict: Verdict;
  outcome: Outcome;
  /**
   * Who decided, as reported by the SDK for model answers. For a private record
   * this is plain code or the on-device model, never the cloud. "cloud-model"
   * only happens with a fictional sample on a browser without the on-device model.
   */
  decidedBy: "rules" | "device-model" | "cloud-model" | "person";
  /** Human-readable reason for rule decisions, or a verbatim quote from the record for model decisions. */
  evidence: string;
  /** True when the quote was found word for word in the record. Rule decisions are always verified. */
  evidenceVerified: boolean;
  /**
   * Set when the model answered yes or no but could not quote the record. The
   * verdict is then "unknown", and this keeps what the model leaned towards.
   */
  unsupported?: "met" | "not_met";
  /**
   * True for an exclusion criterion the record gives no sign of. The app shows
   * it as "nothing in your record suggests this", never as a verified fact.
   */
  assumed?: boolean;
  /** What the model literally answered, kept for the evaluation bench. */
  modelAnswer?: "yes" | "no" | "unknown";
  /**
   * A long record read in parts, where one part gives a quoted "yes" and another
   * a quoted "no". The criterion is left open and both quotes are shown.
   */
  conflict?: { yes: string; no: string };
}

export type TrialFit = "worth_discussing" | "possible" | "unlikely";

export interface TrialMatch {
  trial: Trial;
  results: CriterionResult[];
  fit: TrialFit;
  /** `ok` counts verified results only. `assumed` counts exclusions the record gives no sign of. */
  counts: { ok: number; blocker: number; unknown: number; assumed: number };
}

/**
 * How sensitive the record is.
 * - "private": a real record. Read and judged with ONLY_ON_DEVICE; never falls back to the cloud.
 * - "sample": one of the built-in fictional patients. Not private, so PREFER_ON_DEVICE is used
 *   and the cloud may stand in on a computer that cannot run the on-device model.
 */
export type RecordLevel = "private" | "sample";

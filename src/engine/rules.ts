import { LAB_NAMES, type CompiledCriterion, type CriterionResult, type LabName, type Outcome, type Profile, type Verdict } from "./types";

/**
 * Deterministic engine. Numeric and categorical criteria are checked by plain
 * code against the structured profile. No model is involved, so these verdicts
 * cannot be hallucinated and cost no inference time.
 */

const UNIT_ALIASES: Record<string, string> = {
  "mg/dl": "mg/dl",
  "g/dl": "g/dl",
  "x10^9/l": "10^9/l",
  "x 10^9/l": "10^9/l",
  "10^9/l": "10^9/l",
  "×10^9/l": "10^9/l",
  "x10⁹/l": "10^9/l",
  "10⁹/l": "10^9/l",
  "k/ul": "10^9/l",
  "k/µl": "10^9/l",
  "10^3/ul": "10^9/l",
  "10^3/µl": "10^9/l",
  "%": "%",
  percent: "%",
  "u/l": "u/l",
  "iu/l": "u/l",
  "ml/min": "ml/min",
  "ml/min/1.73m2": "ml/min/1.73m2",
  "ml/min/1.73 m2": "ml/min/1.73m2",
  "ml/min/1.73m^2": "ml/min/1.73m2",
  "g/l": "g/l",
  "umol/l": "umol/l",
  "µmol/l": "umol/l",
  "μmol/l": "umol/l",
  "/ul": "/ul",
  "/µl": "/ul",
  "/μl": "/ul",
  "/mm3": "/ul",
  "/mm³": "/ul",
  "cells/ul": "/ul",
  "cells/µl": "/ul",
  "cells/mm3": "/ul",
  "cells/mm³": "/ul",
};

export function normalizeUnit(unit: string | undefined): string {
  const u = (unit ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  return UNIT_ALIASES[u] ?? UNIT_ALIASES[u.replace(/ /g, "")] ?? u.replace(/ /g, "");
}

const COUNTS = { "10^9/l": { "/ul": 1000 }, "/ul": { "10^9/l": 0.001 } };

/**
 * Exact conversions between the units trials and records use for the same test.
 * Seen on a real trial: "Hemoglobin ≥90 g/L" against a record giving 12.1 g/dL.
 * Without a conversion the criterion went to the on-device model, which said the
 * patient was below the threshold. 12.1 g/dL is 121 g/L.
 */
const CONVERSIONS: Partial<Record<LabName, Record<string, Record<string, number>>>> = {
  hemoglobin: { "g/dl": { "g/l": 10 }, "g/l": { "g/dl": 0.1 } },
  creatinine: { "mg/dl": { "umol/l": 88.42 }, "umol/l": { "mg/dl": 1 / 88.42 } },
  bilirubin_total: { "mg/dl": { "umol/l": 17.1 }, "umol/l": { "mg/dl": 1 / 17.1 } },
  platelets: COUNTS,
  anc: COUNTS,
  wbc: COUNTS,
};

/** The lab value in the unit the criterion uses, or null when no exact conversion is known. */
export function convertLab(field: LabName, value: number, from: string, to: string): number | null {
  if (from === to) return value;
  const factor = CONVERSIONS[field]?.[from]?.[to];
  return factor === undefined ? null : Math.round(value * factor * 1000) / 1000;
}

function compare(actual: number, operator: CompiledCriterion["operator"], expected: number): boolean {
  switch (operator) {
    case ">=":
      return actual >= expected;
    case "<=":
      return actual <= expected;
    case ">":
      return actual > expected;
    case "<":
      return actual < expected;
    case "=":
      return actual === expected;
    default:
      return false;
  }
}

/** Translates "is the statement true" into "does this help or block the patient". */
export function outcomeFor(kind: CompiledCriterion["kind"], verdict: Verdict): Outcome {
  if (verdict === "unknown") return "unknown";
  if (kind === "inclusion") return verdict === "met" ? "ok" : "blocker";
  return verdict === "met" ? "blocker" : "ok";
}

function result(c: CompiledCriterion, verdict: Verdict, evidence: string): CriterionResult {
  return {
    criterion: c,
    verdict,
    outcome: outcomeFor(c.kind, verdict),
    decidedBy: "rules",
    evidence,
    evidenceVerified: true,
  };
}

function isLab(field: string): field is LabName {
  return (LAB_NAMES as readonly string[]).includes(field);
}

/** True when plain code can decide this criterion. Everything else goes to the on-device model. */
export function isDeterministic(c: CompiledCriterion): boolean {
  if (c.check === "semantic" || !c.field) return false;
  if (c.check === "numeric") {
    return typeof c.value === "number" && Number.isFinite(c.value) && Boolean(c.operator) && c.field !== "sex" && c.field !== "pregnant";
  }
  return (c.field === "sex" || c.field === "pregnant") && Boolean(c.category);
}

/**
 * Checks one criterion with code. Returns null when the criterion is not
 * deterministic, or when units cannot be compared safely.
 */
export function evaluateRule(c: CompiledCriterion, profile: Profile): CriterionResult | null {
  if (!isDeterministic(c) || !c.field) return null;

  if (c.field === "sex") {
    const want = c.category!.toLowerCase();
    if (want !== "female" && want !== "male") return null;
    if (profile.sex === "unknown") return result(c, "unknown", "Sex is not stated in your record.");
    return result(c, profile.sex === want ? "met" : "not_met", `Your record says: ${profile.sex}.`);
  }

  if (c.field === "pregnant") {
    const want = c.category!.toLowerCase();
    if (want !== "yes" && want !== "no") return null;
    if (profile.pregnant === "unknown") return result(c, "unknown", "Pregnancy status is not stated in your record.");
    return result(c, profile.pregnant === want ? "met" : "not_met", profile.pregnant === "no" ? "Read from your record: not pregnant." : "Read from your record: pregnant.");
  }

  if (c.field === "age") {
    if (profile.age === null) return result(c, "unknown", "Age is not stated in your record.");
    return result(c, compare(profile.age, c.operator, c.value!) ? "met" : "not_met", `Your record says age ${profile.age}.`);
  }

  if (c.field === "ecog") {
    if (profile.ecog === null) return result(c, "unknown", "ECOG performance status is not stated in your record.");
    return result(c, compare(profile.ecog, c.operator, c.value!) ? "met" : "not_met", `Your record says ECOG ${profile.ecog}.`);
  }

  if (isLab(c.field)) {
    const lab = profile.labs.find((l) => l.name === c.field);
    if (!lab) return result(c, "unknown", `No ${c.field.replace(/_/g, " ")} value was found in your record.`);
    const want = normalizeUnit(c.unit);
    const have = normalizeUnit(lab.unit);
    // Without matching or exactly convertible units a numeric comparison would be unsafe; leave it to the semantic pass.
    if (!want || !have) return null;
    const value = convertLab(c.field, lab.value, have, want);
    if (value === null) return null;
    const converted = want === have ? "" : ` (${value} ${c.unit})`;
    return result(
      c,
      compare(value, c.operator, c.value!) ? "met" : "not_met",
      `Your record says ${c.field.replace(/_/g, " ")} ${lab.value} ${lab.unit}${converted}.`,
    );
  }

  return null;
}

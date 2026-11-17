import type { CriterionKind, Verdict } from "../engine/types";

/**
 * Combines the verdicts of the atomic conditions of one annotated criterion.
 *
 * An inclusion criterion split into parts holds only if every part holds:
 * one failing part makes it false. An exclusion criterion split into parts is a
 * list of alternatives: one part that applies makes it true.
 */
export function combine(kind: CriterionKind, parts: Verdict[]): Verdict {
  if (parts.length === 0) return "unknown";
  if (kind === "inclusion") {
    if (parts.includes("not_met")) return "not_met";
    return parts.every((p) => p === "met") ? "met" : "unknown";
  }
  if (parts.includes("met")) return "met";
  return parts.every((p) => p === "not_met") ? "not_met" : "unknown";
}

import { describe, expect, it } from "vitest";
import { combineParts } from "../judge";
import { MAX_PARTS, PART_CHARS, PART_OVERLAP, partsNeeded, rankParts, readableChars, readableParts, recordParts } from "../parts";
import { mergeBasics, mergeDetails } from "../profile";
import type { CompiledCriterion, CriterionResult } from "../types";

const filler = (label: string, lines: number) =>
  Array.from({ length: lines }, (_, i) => `${label} line ${i + 1}: routine follow-up visit, no new complaints, examination unremarkable.`).join("\n");

describe("splitting a long record into parts", () => {
  it("leaves a record that fits in one part exactly as it is", () => {
    const short = "62-year-old woman.\nECOG 1.";
    expect(recordParts(short)).toEqual([short]);
    expect(partsNeeded(short)).toBe(1);
  });

  it("cuts at line breaks, keeps every line, and repeats a little at each joint", () => {
    const record = [filler("Letter A", 80), filler("Letter B", 80), filler("Letter C", 80)].join("\n");
    const parts = recordParts(record);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(PART_CHARS);
    // Every line of the record is in at least one part, whole.
    for (const line of record.split("\n")) expect(parts.some((p) => p.split("\n").includes(line))).toBe(true);
    // Consecutive parts share their joint: the first lines of a part are the last lines of the one before.
    for (let i = 1; i < parts.length; i++) {
      const before = parts[i - 1].split("\n");
      const after = parts[i].split("\n");
      let shared = 0;
      for (let k = 1; k <= Math.min(before.length, after.length); k++) {
        if (before.slice(-k).join("\n") === after.slice(0, k).join("\n")) shared = k;
      }
      expect(shared).toBeGreaterThan(0);
      expect(after.slice(0, shared).join("\n").length).toBeLessThanOrEqual(PART_OVERLAP);
    }
  });

  it("splits a single very long line at sentence ends", () => {
    const line = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} about the patient.`).join(" ");
    const parts = recordParts(line);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(PART_CHARS);
    expect(parts[0].endsWith(".")).toBe(true);
  });

  it("reads at most MAX_PARTS parts and says how much that covers", () => {
    const huge = filler("Page", 900);
    expect(partsNeeded(huge)).toBeGreaterThan(MAX_PARTS);
    expect(readableParts(huge)).toHaveLength(MAX_PARTS);
    const covered = readableChars(huge);
    expect(covered).toBeLessThan(huge.length);
    expect(huge.slice(0, covered).endsWith(readableParts(huge)[MAX_PARTS - 1])).toBe(true);
  });

  it("asks first the parts that share the most words with the question", () => {
    const parts = ["Clinic letter about diabetes and insulin.", "Imaging report: brain MRI shows two brain metastases.", "Lab results."];
    expect(rankParts(parts, "Does this patient have brain metastases?")).toEqual([1, 0, 2]);
    expect(rankParts(parts, "Something unrelated?")).toEqual([0, 1, 2]);
  });
});

const exclusion: CompiledCriterion = { id: "c1", kind: "exclusion", text: "Brain metastases", check: "semantic" };
const inclusion: CompiledCriterion = { id: "c2", kind: "inclusion", text: "Measurable disease", check: "semantic" };
const base = (c: CompiledCriterion): Omit<CriterionResult, "verdict" | "outcome" | "evidence" | "evidenceVerified"> => ({
  criterion: c,
  decidedBy: "device-model",
});

describe("one answer from the answers about each part", () => {
  const noSign: CriterionResult = { ...base(exclusion), verdict: "not_met", outcome: "ok", evidence: "", evidenceVerified: false, assumed: true };
  const foundYes: CriterionResult = { ...base(exclusion), verdict: "met", outcome: "blocker", evidence: "two brain metastases", evidenceVerified: true };
  const leanedYes: CriterionResult = { ...base(exclusion), verdict: "unknown", outcome: "unknown", evidence: "", evidenceVerified: false, unsupported: "met" };

  it("an exclusion has no sign only when every part says so", () => {
    expect(combineParts([noSign, noSign, noSign])).toBe(noSign);
    expect(combineParts([noSign, foundYes])).toBe(foundYes);
    expect(combineParts([noSign, leanedYes, noSign])).toBe(leanedYes);
  });

  it("an inclusion with a quoted yes in one part and a quoted no in another is left open, with both quotes", () => {
    const yes: CriterionResult = { ...base(inclusion), verdict: "met", outcome: "ok", evidence: "measurable liver lesion", evidenceVerified: true };
    const no: CriterionResult = { ...base(inclusion), verdict: "not_met", outcome: "blocker", evidence: "no measurable disease", evidenceVerified: true };
    const open: CriterionResult = { ...base(inclusion), verdict: "unknown", outcome: "unknown", evidence: "", evidenceVerified: false };
    const both = combineParts([no, open, yes]);
    expect(both).toMatchObject({ verdict: "unknown", outcome: "unknown", conflict: { yes: "measurable liver lesion", no: "no measurable disease" } });
    expect(combineParts([open, no])).toBe(no);
    expect(combineParts([open, open])).toBe(open);
  });
});

describe("facts read from several parts", () => {
  const empty = { age: null, sex: "unknown", primaryCondition: "", searchTerm: "", conditions: [], ecog: null, pregnant: "unknown", location: "" };

  it("takes the first value found for each fact, and every condition named", () => {
    const merged = mergeBasics([
      { ...empty, primaryCondition: "breast cancer", searchTerm: "breast cancer", conditions: ["hypertension"] },
      { ...empty, age: 54, sex: "female", conditions: ["Hypertension", "hypothyroidism"], pregnant: "no", location: "Chicago" },
    ]);
    expect(merged).toMatchObject({ age: 54, sex: "female", primaryCondition: "breast cancer", pregnant: "no", location: "Chicago" });
    expect(merged.conditions).toEqual(["hypertension", "hypothyroidism"]);
  });

  it("joins treatments and lab values, keeping the first value of each test", () => {
    const merged = mergeDetails([
      { therapies: [{ name: "letrozole", status: "received" }], labs: [{ name: "creatinine", value: 0.9, unit: "mg/dL" }] },
      {
        therapies: [{ name: "Letrozole", status: "received" }, { name: "tamoxifen", status: "never_received" }],
        labs: [{ name: "creatinine", value: 1.4, unit: "mg/dL" }, { name: "platelets", value: 210, unit: "x10^9/L" }],
      },
    ]);
    expect(merged.therapies.map((t) => t.name)).toEqual(["letrozole", "tamoxifen"]);
    expect(merged.labs).toEqual([
      { name: "creatinine", value: 0.9, unit: "mg/dL" },
      { name: "platelets", value: 210, unit: "x10^9/L" },
    ]);
  });
});

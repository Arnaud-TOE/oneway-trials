import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/firebase", () => ({
  getAi: () => ({}),
  getDeviceAi: () => ({}),
  getDb: () => ({}),
  ensureSignedIn: async () => "anon",
  isFirebaseConfigured: true,
}));

import { questionFor, today, toQuestion, toResult } from "../judge";
import { countOutcomes, fitFor, splitByEngine } from "../match";
import { buildProfile, coarseSearchTerm, verifyLabs } from "../profile";
import type { CompiledCriterion, Profile } from "../types";

const RECORD = `62-year-old woman. ECOG performance status 1. She has never received palbociclib.
Took ribociclib for 14 months. Creatinine 0.9 mg/dL, platelets 210 x10^9/L.`;

describe("profile post-processing", () => {
  it("reproduces and corrects the risk-test extraction error", () => {
    const profile = buildProfile(
      { age: 62, sex: "female", primaryCondition: "breast cancer", searchTerm: "Breast Cancer (HER2-)", conditions: ["breast cancer"], ecog: 1, pregnant: "no", location: "" },
      {
        therapies: [
          { name: "ribociclib", status: "received" },
          { name: "palbociclib", status: "received" },
          { name: "chemotherapy", status: "received" },
        ],
        labs: [
          { name: "creatinine", value: 0.9, unit: "mg/dL" },
          { name: "hemoglobin", value: 13.2, unit: "g/dL" },
        ],
      },
      RECORD,
    );
    expect(profile.therapies).toEqual([
      { name: "ribociclib", status: "received" },
      { name: "palbociclib", status: "never_received" },
    ]);
    expect(profile.searchTerm).toBe("breast cancer her2-");
    // Hemoglobin 13.2 is not in the record: an invented value is discarded.
    expect(profile.labs.map((l) => l.name)).toEqual(["creatinine"]);
  });

  it("discards an age or ECOG the record does not contain", () => {
    const p = buildProfile(
      { age: 45, sex: "female", primaryCondition: "", conditions: [], ecog: 2, pregnant: "unknown", location: "" },
      { therapies: [], labs: [] },
      "A woman with asthma.",
    );
    expect(p.age).toBeNull();
    expect(p.ecog).toBeNull();
  });

  it("keeps the registry search term short and plain", () => {
    expect(coarseSearchTerm("Invasive ductal carcinoma of the left breast, stage IV")).toBe("invasive ductal carcinoma of");
    expect(coarseSearchTerm("  Breast   cancer ")).toBe("breast cancer");
    expect(coarseSearchTerm("")).toBe("");
  });

  it("does not confuse 0.9 with 10.9 when verifying a lab value", () => {
    expect(verifyLabs([{ name: "creatinine", value: 0.9, unit: "mg/dL" }], "Creatinine 10.9 mg/dL")).toEqual([]);
    expect(verifyLabs([{ name: "platelets", value: 210, unit: "" }], "platelets 210")).toHaveLength(1);
  });
});

describe("judgement post-processing", () => {
  const c1: CompiledCriterion = { id: "c1", kind: "inclusion", text: "ECOG 0-2", check: "semantic" };
  const c2: CompiledCriterion = { id: "c2", kind: "inclusion", text: "Prior palbociclib", check: "semantic" };
  const c3: CompiledCriterion = { id: "c3", kind: "exclusion", text: "Brain metastases", check: "semantic" };

  it("keeps a quote that is in the record", () => {
    expect(toResult(c1, { answer: "yes", quote: "ECOG performance status 1" }, RECORD)).toMatchObject({
      verdict: "met",
      outcome: "ok",
      evidenceVerified: true,
    });
  });

  it("turns an answer backed by an invented quote into an open question", () => {
    expect(toResult(c2, { answer: "no", quote: "the patient was palbociclib-naive" }, RECORD)).toMatchObject({
      verdict: "unknown",
      outcome: "unknown",
      evidence: "",
      evidenceVerified: false,
      unsupported: "not_met",
    });
  });

  it("never lets an unquoted answer rule a trial in or out (false blocker seen on a real trial)", () => {
    const falseBlocker = toResult(c1, { answer: "no", quote: "" }, RECORD);
    expect(falseBlocker.outcome).toBe("unknown");
    expect(falseBlocker.unsupported).toBe("not_met");
    const unbackedYes = toResult(c3, { answer: "yes", quote: "" }, RECORD);
    expect(unbackedYes.outcome).toBe("unknown");
    expect(unbackedYes.unsupported).toBe("met");
    expect(toResult(c1, { answer: "yes", quote: "ECOG performance status 1" }, RECORD).unsupported).toBeUndefined();
  });

  it("treats a missing or malformed answer as unknown, never a guess", () => {
    expect(toResult(c3, null, RECORD)).toMatchObject({ verdict: "unknown", outcome: "unknown" });
    expect(toResult(c3, { answer: "eligible", quote: "" }, RECORD).verdict).toBe("unknown");
  });

  it("never shows the model's own words as a quote for an unknown answer", () => {
    const r = toResult(c3, { answer: "unknown", quote: "The record does not mention brain metastases." }, RECORD);
    expect(r.evidence).toBe("");
    const inclusion = toResult(c1, { answer: "unknown", quote: "The record does not mention ECOG." }, RECORD);
    expect(inclusion).toMatchObject({ verdict: "unknown", evidence: "" });
  });

  it("reads a quoted exclusion that applies as a blocker", () => {
    expect(toResult(c3, { answer: "yes", quote: "Took ribociclib for 14 months" }, RECORD).outcome).toBe("blocker");
  });

  it("treats an exclusion the record gives no sign of as an assumption, not as a verified fact", () => {
    const r = toResult(c3, { answer: "no", quote: "" }, RECORD);
    expect(r).toMatchObject({ verdict: "not_met", outcome: "ok", assumed: true, evidenceVerified: false, evidence: "" });
    expect(r.unsupported).toBeUndefined();
    // "unknown" is read the same way: measured, the model's no/unknown choice carries no information here.
    expect(toResult(c3, { answer: "unknown", quote: "" }, RECORD)).toMatchObject({ verdict: "not_met", outcome: "ok", assumed: true });
    // A failed call is not a search that found nothing.
    expect(toResult(c3, null, RECORD).assumed).toBeUndefined();
    // A "yes" to an exclusion still needs exact words from the record.
    const unbacked = toResult(c3, { answer: "yes", quote: "" }, RECORD);
    expect(unbacked).toMatchObject({ verdict: "unknown", outcome: "unknown", unsupported: "met" });
    expect(unbacked.assumed).toBeUndefined();
    // And an unquoted "no" to an inclusion criterion is still an open question.
    expect(toResult(c1, { answer: "no", quote: "" }, RECORD)).toMatchObject({ verdict: "unknown", unsupported: "not_met" });
  });

  it("does not let assumed exclusions alone make a trial worth discussing", () => {
    expect(fitFor({ ok: 0, blocker: 0, unknown: 2, assumed: 9 })).toBe("possible");
    expect(fitFor({ ok: 2, blocker: 0, unknown: 2, assumed: 9 })).toBe("worth_discussing");
    expect(fitFor({ ok: 5, blocker: 1, unknown: 0, assumed: 9 })).toBe("unlikely");
    const assumed = toResult(c3, { answer: "no", quote: "" }, RECORD);
    expect(countOutcomes([assumed])).toEqual({ ok: 0, blocker: 0, unknown: 0, assumed: 1 });
  });

  it("records which model really answered, so the interface cannot mislabel it", () => {
    expect(toResult(c1, { answer: "yes", quote: "" }, RECORD).decidedBy).toBe("device-model");
    expect(toResult(c1, { answer: "yes", quote: "" }, RECORD, "on_device").decidedBy).toBe("device-model");
    expect(toResult(c1, { answer: "yes", quote: "" }, RECORD, "in_cloud").decidedBy).toBe("cloud-model");
  });

  it("asks the cloud-written plain question when there is one", () => {
    const listed: CompiledCriterion = {
      id: "c9",
      kind: "inclusion",
      text: "HER2-positive aBC, HR-positive/HER2-negative aBC, or KRAS mutant aCRC",
      check: "semantic",
      ask: "Does this patient have at least one of these: (a) HER2-positive advanced breast cancer, (b) hormone receptor-positive and HER2-negative advanced breast cancer? Answer yes if any one of them applies.",
    };
    expect(questionFor(listed)).toBe(listed.ask);
    expect(questionFor(c1)).toBe('Is the following true for this patient: "ECOG 0-2"?');
  });

  it("writes today's date in words for time-window criteria", () => {
    expect(today(new Date(2026, 10, 15))).toBe("15 November 2026");
  });

  it("phrases criteria as direct questions", () => {
    expect(toQuestion("Have known and untreated or active central nervous system (CNS) metastases.")).toBe(
      "Does this patient have known and untreated or active central nervous system (CNS) metastases?",
    );
    expect(toQuestion("History of leptomeningeal disease")).toBe("Does this patient have a history of leptomeningeal disease?");
    expect(toQuestion("Are pregnant or breastfeeding")).toBe("Is this patient pregnant or breastfeeding?");
    expect(toQuestion("Active bacterial infection")).toBe("Does this patient have active bacterial infection?");
    expect(toQuestion("ECOG performance status 0-2")).toBe('Is the following true for this patient: "ECOG performance status 0-2"?');
  });
});

describe("trial-level summary", () => {
  const profile: Profile = {
    age: 62,
    sex: "female",
    primaryCondition: "breast cancer",
    searchTerm: "breast cancer",
    conditions: [],
    ecog: 1,
    pregnant: "unknown",
    location: "",
    therapies: [],
    labs: [],
  };

  it("routes numeric criteria to code and the rest to the on-device model", () => {
    const { decided, semantic } = splitByEngine(
      [
        { id: "c1", kind: "inclusion", text: "Age >= 18", check: "numeric", field: "age", operator: ">=", value: 18 },
        { id: "c2", kind: "inclusion", text: "Measurable disease", check: "semantic" },
      ],
      profile,
    );
    expect(decided.map((r) => r.criterion.id)).toEqual(["c1"]);
    expect(semantic.map((c) => c.id)).toEqual(["c2"]);
  });

  it("never calls a trial with a blocker worth discussing", () => {
    expect(fitFor({ ok: 9, blocker: 1, unknown: 0, assumed: 0 })).toBe("unlikely");
    expect(fitFor({ ok: 6, blocker: 0, unknown: 2, assumed: 0 })).toBe("worth_discussing");
    expect(fitFor({ ok: 1, blocker: 0, unknown: 8, assumed: 0 })).toBe("possible");
    expect(fitFor({ ok: 0, blocker: 0, unknown: 0, assumed: 0 })).toBe("possible");
  });

  it("counts outcomes", () => {
    const r = toResult({ id: "c1", kind: "exclusion", text: "x", check: "semantic" }, { answer: "yes", quote: "Took ribociclib for 14 months" }, RECORD);
    expect(countOutcomes([r])).toEqual({ ok: 0, blocker: 1, unknown: 0, assumed: 0 });
  });
});

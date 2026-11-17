import { describe, expect, it } from "vitest";
import { isAboutAnotherCancer, isNegativeStatement, quoteNamesOnlyOwnCancer } from "../evidence";
import { toResult } from "../judge";
import type { CompiledCriterion } from "../types";

/**
 * Seen while recording the built-in example: for exclusions about "another"
 * cancer, the on-device model answered yes and quoted the patient's own cancer.
 */

const LETTER = `55-year-old woman. Hormone receptor-positive, HER2-negative invasive lobular carcinoma of the right breast, diagnosed 2021.
Metastatic recurrence to bone, spine and pelvis, in May 2025. History of papillary thyroid carcinoma in 2015, treated with thyroidectomy.`;
const OWN = "invasive lobular carcinoma of the right breast breast cancer";

const exclusion = (text: string): CompiledCriterion => ({ id: "c1", kind: "exclusion", text, check: "semantic" });

describe("exclusions about another cancer", () => {
  it("recognises them, and only them", () => {
    expect(isAboutAnotherCancer("History of another primary malignancy.")).toBe(true);
    expect(isAboutAnotherCancer("History of another malignancy within 3 years before first dose")).toBe(true);
    expect(isAboutAnotherCancer("Any other active cancer requiring treatment")).toBe(true);
    expect(isAboutAnotherCancer("Second primary malignancy")).toBe(true);
    // In a trial that is not about this cancer, "prior malignancy" includes it: not touched.
    expect(isAboutAnotherCancer("Prior malignancy within 5 years")).toBe(false);
    expect(isAboutAnotherCancer("Symptomatic visceral disease")).toBe(false);
  });

  it("tells the patient's own cancer from another one", () => {
    expect(quoteNamesOnlyOwnCancer("invasive lobular carcinoma of the right breast, diagnosed 2021", OWN)).toBe(true);
    expect(quoteNamesOnlyOwnCancer("Metastatic recurrence to bone, spine and pelvis, in May 2025.", OWN)).toBe(true);
    expect(quoteNamesOnlyOwnCancer("History of papillary thyroid carcinoma in 2015", OWN)).toBe(false);
    expect(quoteNamesOnlyOwnCancer("basal cell carcinoma of the skin removed in 2019", OWN)).toBe(false);
    expect(quoteNamesOnlyOwnCancer("stage IV non-small cell lung cancer, adenocarcinoma", "non-small cell lung cancer lung cancer")).toBe(true);
    // Without a known diagnosis nothing can be told apart: the model's answer stands.
    expect(quoteNamesOnlyOwnCancer("invasive lobular carcinoma", "")).toBe(false);
  });

  it("does not let the patient's own cancer rule a trial out as 'another' cancer", () => {
    const r = toResult(
      exclusion("History of another primary malignancy."),
      { answer: "yes", quote: "invasive lobular carcinoma of the right breast, diagnosed 2021" },
      LETTER,
      "on_device",
      OWN,
    );
    expect(r.outcome).toBe("ok");
    expect(r.assumed).toBe(true);
  });

  it("still rules a trial out on a real other cancer", () => {
    const r = toResult(
      exclusion("History of another primary malignancy."),
      { answer: "yes", quote: "History of papillary thyroid carcinoma in 2015" },
      LETTER,
      "on_device",
      OWN,
    );
    expect(r.outcome).toBe("blocker");
    expect(r.evidenceVerified).toBe(true);
  });

  it("does not let a sentence about an absence prove that an exclusion applies", () => {
    // Seen while recording the built-in example.
    const letter = "She has never received chemotherapy, fulvestrant or everolimus. No brain metastases on MRI, October 2026.";
    const inr = toResult(
      { ...exclusion("Participants with an INR >1.5 unless the patient is receiving non-vitamin K antagonist oral anticoagulants."), ask: "Is the patient's INR above 1.5?" },
      { answer: "yes", quote: "She has never received chemotherapy, fulvestrant or everolimus." },
      letter,
    );
    expect(inr.outcome).toBe("ok");
    expect(inr.assumed).toBe(true);
    // An exclusion worded in the negative can be shown by a negative sentence.
    const noBrainImaging = toResult(
      { ...exclusion("Patients without brain imaging."), ask: "Does the patient have no brain imaging?" },
      { answer: "yes", quote: "No brain metastases on MRI" },
      letter,
    );
    expect(noBrainImaging.outcome).toBe("blocker");
  });

  it("recognises sentences about an absence, narrowly", () => {
    expect(isNegativeStatement("She has never received chemotherapy, fulvestrant or everolimus.")).toBe(true);
    expect(isNegativeStatement("No brain metastases on MRI, October 2026.")).toBe(true);
    expect(isNegativeStatement("He has not been treated before.")).toBe(true);
    expect(isNegativeStatement("palbociclib, not tolerated, stopped after 2 months")).toBe(false);
    expect(isNegativeStatement("New liver lesions on CT on 20 October 2026.")).toBe(false);
  });

  it("changes nothing for other exclusions", () => {
    const r = toResult(
      exclusion("Patients with symptomatic visceral disease."),
      { answer: "yes", quote: "Metastatic recurrence to bone, spine and pelvis, in May 2025." },
      LETTER,
      "on_device",
      OWN,
    );
    expect(r.outcome).toBe("blocker");
  });
});

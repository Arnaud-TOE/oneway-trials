import { describe, expect, it } from "vitest";
import { SAMPLES } from "../../app/samples";
import { applyNegationGuard, findNeverReceived, looksLikeTreatment, mergeNeverReceived } from "../evidence";
import { buildProfile, NO_DETAILS } from "../profile";

const record = (id: string) => SAMPLES.find((s) => s.id === id)!.record;

describe("treatments the record says were never received", () => {
  it("finds them in the built-in patients, word for word", () => {
    expect(findNeverReceived(record("breast"))).toEqual(["palbociclib", "chemotherapy for metastatic disease", "tamoxifen"]);
    expect(findNeverReceived(record("lung"))).toEqual(["chemotherapy", "immunotherapy"]);
    expect(findNeverReceived(record("diabetes"))).toEqual(["insulin", "GLP-1 receptor agonist"]);
  });

  it("finds the sentence the on-device model missed in a clinic letter", () => {
    const letter = "Treatment so far: anastrozole plus palbociclib for 18 months.\nShe has never received chemotherapy for metastatic disease.\nECOG performance status 0.";
    expect(findNeverReceived(letter)).toEqual(["chemotherapy for metastatic disease"]);
  });

  it("understands the usual ways of saying it", () => {
    expect(findNeverReceived("He hasn't received any prior chemotherapy.")).toEqual(["chemotherapy"]);
    expect(findNeverReceived("No prior radiotherapy or surgery to the chest.")).toEqual(["radiotherapy", "surgery to the chest"]);
    expect(findNeverReceived("Chemotherapy-naive. Not on insulin.")).toEqual(["insulin", "Chemotherapy"]);
    expect(findNeverReceived("She has not been treated with pembrolizumab before randomization.")).toEqual(["pembrolizumab"]);
    expect(findNeverReceived("Has never taken a statin.")).toEqual(["statin"]);
  });

  it("ignores negations that are not about treatments", () => {
    expect(findNeverReceived("No history of pancreatitis. He has never had a heart attack. Never smoked.")).toEqual([]);
    expect(findNeverReceived("The results have not been received yet. She has not taken her medication as prescribed.")).toEqual([]);
    expect(findNeverReceived("He has never used tobacco.")).toEqual([]);
    expect(looksLikeTreatment("osimertinib")).toBe(true);
    expect(looksLikeTreatment("heart attack")).toBe(false);
  });

  it("adds them to what the model read, keeping the more precise name", () => {
    const merged = mergeNeverReceived(
      [
        { name: "anastrozole", status: "received" },
        { name: "chemotherapy", status: "never_received" },
      ],
      "Anastrozole since 2024. She has never received chemotherapy for metastatic disease or tamoxifen.",
    );
    expect(merged).toEqual([
      { name: "anastrozole", status: "received" },
      { name: "chemotherapy for metastatic disease", status: "never_received" },
      { name: "tamoxifen", status: "never_received" },
    ]);
  });

  it("keeps a received treatment and a narrower one never received side by side", () => {
    const merged = mergeNeverReceived(
      [{ name: "chemotherapy", status: "received" }],
      "Received adjuvant chemotherapy in 2019. She has never received chemotherapy for metastatic disease.",
    );
    expect(merged).toEqual([
      { name: "chemotherapy", status: "received" },
      { name: "chemotherapy for metastatic disease", status: "never_received" },
    ]);
  });

  it("overrules a 'never received' that no sentence of the record supports", () => {
    // The letter the on-device model got wrong while recording the built-in example.
    const letter =
      "Metastatic recurrence to bone in May 2025.\nFirst-line treatment: palbociclib plus letrozole from June 2025, stopped in October 2026 for\ndisease progression new liver lesions on CT, 20 October 2026.\nShe has never received chemotherapy, fulvestrant or everolimus.";
    const guarded = applyNegationGuard(
      [
        { name: "palbociclib", status: "never_received" },
        { name: "letrozole", status: "received" },
        { name: "fulvestrant", status: "never_received" },
      ],
      letter,
    );
    expect(guarded).toEqual([
      { name: "palbociclib", status: "received" },
      { name: "letrozole", status: "received" },
      { name: "fulvestrant", status: "never_received" },
    ]);
  });

  it("keeps the model's 'never received' when a sentence could support it", () => {
    for (const text of [
      "Palbociclib was discussed but not started.",
      "Palbociclib was offered; she declined.",
      "She is palbociclib-naive.",
      "Palbociclib: no.",
    ]) {
      expect(applyNegationGuard([{ name: "palbociclib", status: "never_received" }], text)).toEqual([{ name: "palbociclib", status: "never_received" }]);
    }
  });

  it("is applied when the profile is built, even when the model returned nothing", () => {
    const basics = { age: 54, sex: "female" as const, primaryCondition: "breast cancer", searchTerm: "breast cancer", conditions: [], ecog: null, pregnant: "unknown" as const, location: "" };
    const profile = buildProfile(basics, NO_DETAILS, "54-year-old woman. She has never received chemotherapy for metastatic disease.");
    expect(profile.therapies).toEqual([{ name: "chemotherapy for metastatic disease", status: "never_received" }]);
  });
});

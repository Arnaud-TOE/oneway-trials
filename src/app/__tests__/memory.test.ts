import { describe, expect, it } from "vitest";
import { countOutcomes, fitFor, withPersonAnswers } from "../../engine/match";
import { parseStudy } from "../../engine/trials";
import type { CompiledCriterion, CriterionResult, Trial, TrialMatch } from "../../engine/types";
import { criteriaSignature, keptAnswers } from "../memory";
import { reminderIcs } from "../view";

const trial = { nctId: "NCT00000001" } as Trial;
const criteria: CompiledCriterion[] = [
  { id: "c1", kind: "inclusion", text: "Metastatic breast cancer", check: "semantic" },
  { id: "c2", kind: "inclusion", text: "PIK3CA mutation", check: "semantic" },
  { id: "c3", kind: "exclusion", text: "Brain metastases", check: "semantic" },
];
const result = (c: CompiledCriterion, patch: Partial<CriterionResult>): CriterionResult => ({
  criterion: c,
  verdict: "unknown",
  outcome: "unknown",
  decidedBy: "device-model",
  evidence: "",
  evidenceVerified: false,
  ...patch,
});
const matchOf = (results: CriterionResult[]): TrialMatch => {
  const counts = countOutcomes(results);
  return { trial, results, fit: fitFor(counts), counts };
};

describe("the person's own answers", () => {
  const raw = matchOf([
    result(criteria[0], { verdict: "met", outcome: "ok", evidenceVerified: true, evidence: "metastatic breast cancer" }),
    result(criteria[1], {}),
    result(criteria[2], { verdict: "not_met", outcome: "ok", assumed: true }),
  ]);

  it("lays an answer over an open question, marked as the person's", () => {
    const shown = withPersonAnswers(raw, criteria, { c2: "yes" });
    expect(shown.results[1]).toMatchObject({ decidedBy: "person", verdict: "met", outcome: "ok", evidenceVerified: false });
    expect(shown.counts).toEqual({ ok: 2, blocker: 0, unknown: 0, assumed: 1 });
    expect(shown.fit).toBe("worth_discussing");
    // What code and the model found is untouched, so the answer can be taken back.
    expect(raw.results[1].decidedBy).toBe("device-model");
    expect(withPersonAnswers(raw, criteria, {})).toBe(raw);
  });

  it("turns an exclusion the person says applies into something that may rule the trial out", () => {
    const shown = withPersonAnswers(raw, criteria, { c3: "yes" });
    expect(shown.results[2]).toMatchObject({ outcome: "blocker", decidedBy: "person" });
    expect(shown.fit).toBe("unlikely");
  });

  it("can answer a criterion the model has not been asked about yet", () => {
    const partial = matchOf([raw.results[0]]);
    const shown = withPersonAnswers(partial, criteria, { c2: "no" });
    expect(shown.results.map((r) => r.criterion.id)).toEqual(["c1", "c2"]);
    expect(shown.results[1]).toMatchObject({ outcome: "blocker" });
  });
});

describe("answers kept from an earlier visit", () => {
  const modelAnswer = result(criteria[1], { verdict: "met", outcome: "ok", evidenceVerified: true, evidence: "PIK3CA H1047R" });
  const check = { criteriaSig: criteriaSignature(criteria), checkedAt: "2026-11-10T10:00:00Z", results: [modelAnswer] };

  it("are reused for exactly the same criteria", () => {
    expect(keptAnswers(check, criteria)).toEqual([modelAnswer]);
  });

  it("are dropped when the trial's criteria changed", () => {
    const changed = criteria.map((c) => (c.id === "c2" ? { ...c, text: "PIK3CA or AKT1 mutation" } : c));
    expect(keptAnswers(check, changed)).toEqual([]);
    expect(keptAnswers(undefined, criteria)).toEqual([]);
  });

  it("never include plain-code results or the person's answers, which are recomputed", () => {
    const mixed = { ...check, results: [modelAnswer, result(criteria[0], { decidedBy: "rules" }), result(criteria[2], { decidedBy: "person" })] };
    expect(keptAnswers(mixed, criteria)).toEqual([modelAnswer]);
  });
});

describe("calendar reminder", () => {
  it("names no condition and no treatment, because calendars are often synced to the cloud", () => {
    const ics = reminderIcs(new Date("2026-12-01T09:00:00Z"), "https://oneway-trials.web.app/", new Date("2026-11-17T09:00:00Z"));
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("SUMMARY:Look again for clinical trials (OneWay)");
    expect(ics).toContain("URL:https://oneway-trials.web.app/");
    expect(ics).not.toMatch(/cancer|diabetes|chemo|NCT\d/i);
    expect(ics.split("\r\n").length).toBeGreaterThan(10);
  });
});

describe("contacts published in the registry", () => {
  it("are read for the trial and for each site, keeping only those with a phone or an email", () => {
    const t = parseStudy({
      protocolSection: {
        identificationModule: { nctId: "NCT07174336", briefTitle: "A study" },
        eligibilityModule: { eligibilityCriteria: "Inclusion Criteria:\n* Adults" },
        statusModule: { overallStatus: "RECRUITING", lastUpdatePostDateStruct: { date: "2026-11-04" } },
        contactsLocationsModule: {
          centralContacts: [{ name: "Trial questions", phone: "1-317-615-4559", email: "trials@example.org" }, { name: "No way to reach" }],
          locations: [{ facility: "Clinic A", city: "Boston", state: "Massachusetts", status: "RECRUITING", contacts: [{ phone: "617-555-0100" }, { name: "Dr. A" }] }],
        },
      },
    })!;
    expect(t.contacts).toEqual([{ name: "Trial questions", phone: "1-317-615-4559", email: "trials@example.org" }]);
    expect(t.locations[0]).toMatchObject({ status: "RECRUITING", contacts: [{ name: "", phone: "617-555-0100", email: "" }] });
    expect(t.updatedOn).toBe("2026-11-04");
  });
});

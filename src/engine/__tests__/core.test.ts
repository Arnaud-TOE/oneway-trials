import { describe, expect, it } from "vitest";
import sample from "../__fixtures__/ctgov-sample.json";
import { cacheKey, cleanAsk, isVerbatim, namesOnlySex, sanitizeCompiled } from "../compileCore";
import { applyNegationGuard, dropUnmentioned, verifyQuote } from "../evidence";
import { LeakError, PrivacyGuard } from "../privacy";
import { evaluateRule, isDeterministic, normalizeUnit, outcomeFor } from "../rules";
import { buildSearchUrl, isInterventional, parseAgeYears, parseStudy, prefilter, searchTrials } from "../trials";
import { privacyGuard } from "../privacy";
import type { CompiledCriterion, Profile } from "../types";

const RECORD = `62-year-old woman with HER2-negative metastatic breast cancer.
First-line treatment: ribociclib plus letrozole for 14 months, stopped for disease progression.
She has never received palbociclib, chemotherapy for metastatic disease, or tamoxifen.
ECOG performance status 1. Labs: creatinine 0.9 mg/dL, platelets 210 x10^9/L.`;

const profile: Profile = {
  age: 62,
  sex: "female",
  primaryCondition: "HER2-negative metastatic breast cancer",
  searchTerm: "breast cancer",
  conditions: ["metastatic breast cancer"],
  ecog: 1,
  pregnant: "unknown",
  location: "Boston",
  therapies: [],
  labs: [
    { name: "creatinine", value: 0.9, unit: "mg/dL" },
    { name: "platelets", value: 210, unit: "x10^9/L" },
  ],
};

function crit(partial: Partial<CompiledCriterion>): CompiledCriterion {
  return { id: "c1", kind: "inclusion", text: "t", check: "semantic", ...partial };
}

describe("privacy tripwire", () => {
  it("blocks a payload that carries a passage of the private record", () => {
    const guard = new PrivacyGuard();
    guard.registerPrivateText(RECORD);
    const leaking = "Summarise: She has never received palbociclib, chemotherapy for metastatic disease, or tamoxifen.";
    expect(guard.containsPrivateText(leaking)).toBe(true);
    expect(() => guard.assertPublic(leaking, "Gemini (cloud)")).toThrow(LeakError);
  });

  it("catches a leak even when case and punctuation are changed", () => {
    const guard = new PrivacyGuard();
    guard.registerPrivateText(RECORD);
    expect(guard.containsPrivateText("FIRST-LINE TREATMENT   ribociclib plus letrozole for 14 months")).toBe(true);
  });

  it("lets public registry text through", () => {
    const guard = new PrivacyGuard();
    guard.registerPrivateText(RECORD);
    const publicText = "Inclusion Criteria: ECOG performance status 0-2. Serum creatinine no greater than 1.5 mg/dL. Age 18 years or older.";
    expect(guard.containsPrivateText(publicText)).toBe(false);
    expect(() => guard.assertPublic(publicText, "Gemini (cloud)")).not.toThrow();
  });

  it("blocks short private values registered exactly", () => {
    const guard = new PrivacyGuard();
    guard.registerPrivateValue("Jane Okafor");
    expect(guard.containsPrivateText("patient jane okafor asked about trials")).toBe(true);
  });

  it("is inert until something private is registered", () => {
    expect(new PrivacyGuard().containsPrivateText(RECORD)).toBe(false);
  });
});

describe("deterministic rules", () => {
  it("decides numeric thresholds without a model", () => {
    const r = evaluateRule(crit({ check: "numeric", field: "age", operator: ">=", value: 18 }), profile);
    expect(r?.verdict).toBe("met");
    expect(r?.decidedBy).toBe("rules");
    expect(evaluateRule(crit({ check: "numeric", field: "ecog", operator: "<=", value: 0 }), profile)?.verdict).toBe("not_met");
  });

  it("compares labs when units match or convert exactly, and leaves the rest to the model", () => {
    const ok = evaluateRule(crit({ check: "numeric", field: "creatinine", operator: "<=", value: 1.5, unit: "mg/dL" }), profile);
    expect(ok?.verdict).toBe("met");
    // 0.9 mg/dL is 79.6 µmol/L.
    const converted = evaluateRule(crit({ check: "numeric", field: "creatinine", operator: "<=", value: 133, unit: "µmol/L" }), profile);
    expect(converted?.verdict).toBe("met");
    expect(converted?.evidence).toContain("79.578 µmol/L");
    const unknownUnit = evaluateRule(crit({ check: "numeric", field: "creatinine", operator: "<=", value: 1.5, unit: "x ULN" }), profile);
    expect(unknownUnit).toBeNull();
  });

  it("converts hemoglobin and blood counts between the units trials use", () => {
    // Seen while recording the built-in example: "Hemoglobin ≥90 g/L" against 12.1 g/dL went to the model, which got it wrong.
    const p: Profile = {
      ...profile,
      labs: [
        { name: "hemoglobin", value: 12.1, unit: "g/dL" },
        { name: "platelets", value: 198, unit: "×10^9/L" },
        { name: "anc", value: 2.8, unit: "x10^9/L" },
      ],
    };
    expect(evaluateRule(crit({ check: "numeric", field: "hemoglobin", operator: ">=", value: 90, unit: "g/L" }), p)?.verdict).toBe("met");
    expect(evaluateRule(crit({ check: "numeric", field: "hemoglobin", operator: ">=", value: 130, unit: "g/L" }), p)?.verdict).toBe("not_met");
    expect(evaluateRule(crit({ check: "numeric", field: "platelets", operator: ">=", value: 100000, unit: "/mm3" }), p)?.verdict).toBe("met");
    expect(evaluateRule(crit({ check: "numeric", field: "anc", operator: ">=", value: 1500, unit: "cells/µL" }), p)?.verdict).toBe("met");
  });

  it("treats equivalent unit spellings as the same unit", () => {
    expect(normalizeUnit("x10^9/L")).toBe(normalizeUnit("10^9/L"));
    const r = evaluateRule(crit({ check: "numeric", field: "platelets", operator: ">=", value: 100, unit: "10^9/L" }), profile);
    expect(r?.verdict).toBe("met");
  });

  it("answers unknown, not a guess, when the record lacks the value", () => {
    const r = evaluateRule(crit({ check: "numeric", field: "hemoglobin", operator: ">=", value: 9, unit: "g/dL" }), profile);
    expect(r?.verdict).toBe("unknown");
    expect(r?.outcome).toBe("unknown");
  });

  it("handles sex and pregnancy categories", () => {
    expect(evaluateRule(crit({ check: "categorical", field: "sex", category: "male" }), profile)?.verdict).toBe("not_met");
    expect(evaluateRule(crit({ kind: "exclusion", check: "categorical", field: "pregnant", category: "yes" }), profile)?.verdict).toBe("unknown");
  });

  it("leaves semantic criteria to the on-device model", () => {
    expect(isDeterministic(crit({ check: "semantic" }))).toBe(false);
    expect(evaluateRule(crit({ check: "semantic" }), profile)).toBeNull();
  });

  it("maps verdicts to outcomes by criterion kind", () => {
    expect(outcomeFor("inclusion", "met")).toBe("ok");
    expect(outcomeFor("inclusion", "not_met")).toBe("blocker");
    expect(outcomeFor("exclusion", "met")).toBe("blocker");
    expect(outcomeFor("exclusion", "not_met")).toBe("ok");
    expect(outcomeFor("exclusion", "unknown")).toBe("unknown");
  });
});

describe("evidence checks", () => {
  it("keeps a quote found word for word, ignoring case and line breaks", () => {
    expect(verifyQuote("ecog performance status 1", RECORD)).not.toBe("");
    expect(verifyQuote("stopped for disease\nprogression", RECORD)).not.toBe("");
  });

  it("accepts a real quote whose spacing the model altered (seen on a real trial)", () => {
    const record = "Diagnosed 2023 with hormone receptor-positive (ER 90%, PR 40%),\nHER2-negative (IHC 1+) carcinoma.";
    // The model dropped the space that replaced the line break.
    expect(verifyQuote("hormone receptor-positive (ER 90%, PR 40%),HER2-negative (IHC 1+)", record)).not.toBe("");
    // Two real fragments joined by an ellipsis.
    expect(verifyQuote("Diagnosed 2023 ... HER2-negative (IHC 1+)", record)).not.toBe("");
    // One real fragment and one invented fragment is still rejected.
    expect(verifyQuote("Diagnosed 2023 ... HER2-positive", record)).toBe("");
    expect(verifyQuote("...", record)).toBe("");
  });

  it("rejects a paraphrase that is not in the record (measured in the risk test)", () => {
    expect(verifyQuote("Her second-line treatment with ribociclib plus letrozole progressed", RECORD)).toBe("");
  });

  it("marks a negated therapy as never received (measured in the risk test)", () => {
    const fixed = applyNegationGuard(
      [
        { name: "ribociclib", status: "received" },
        { name: "palbociclib", status: "received" },
        { name: "tamoxifen", status: "received" },
      ],
      RECORD,
    );
    expect(fixed.find((t) => t.name === "ribociclib")?.status).toBe("received");
    expect(fixed.find((t) => t.name === "palbociclib")?.status).toBe("never_received");
    expect(fixed.find((t) => t.name === "tamoxifen")?.status).toBe("never_received");
  });

  it("drops therapies the record never mentions", () => {
    const kept = dropUnmentioned([{ name: "letrozole", status: "received" }, { name: "pembrolizumab", status: "received" }], RECORD);
    expect(kept.map((t) => t.name)).toEqual(["letrozole"]);
  });
});

describe("registry client", () => {
  it("parses registry ages", () => {
    expect(parseAgeYears("18 Years")).toBe(18);
    expect(parseAgeYears("6 Months")).toBe(0.5);
    expect(parseAgeYears(undefined)).toBeNull();
    expect(parseAgeYears("N/A")).toBeNull();
  });

  it("parses real ClinicalTrials.gov records", () => {
    const trials = (sample as { studies: unknown[] }).studies.map((s) => parseStudy(s as Record<string, unknown>));
    expect(trials.length).toBeGreaterThan(0);
    for (const t of trials) {
      expect(t).not.toBeNull();
      expect(t!.nctId).toMatch(/^NCT\d{8}$/);
      expect(t!.criteriaText.length).toBeGreaterThan(50);
      expect(t!.url).toContain(t!.nctId);
      expect(["ALL", "FEMALE", "MALE"]).toContain(t!.sex);
    }
    expect(isInterventional(trials[0]!)).toBe(true);
  });

  it("rejects records without eligibility text", () => {
    expect(parseStudy({ protocolSection: { identificationModule: { nctId: "NCT00000001" } } })).toBeNull();
  });

  it("sends only the condition and location to the registry, never age or sex", () => {
    const url = buildSearchUrl({ condition: "breast cancer", location: "Boston" });
    const params = new URL(url).searchParams;
    expect(params.get("query.cond")).toBe("breast cancer");
    expect(params.get("query.locn")).toBe("Boston");
    expect([...params.keys()].sort()).toEqual(["fields", "filter.overallStatus", "pageSize", "query.cond", "query.locn"]);
    expect(url).not.toMatch(/62|female/i);
  });

  it("refuses a registry query that is a passage of the record or is not a short term", async () => {
    const fetchSpy = async () => {
      throw new Error("the network must not be reached");
    };
    privacyGuard.clear();
    privacyGuard.registerPrivateText("Diagnosed with invasive ductal carcinoma of the left breast, now metastatic to bone.");
    await expect(searchTrials({ condition: "invasive ductal carcinoma of the left breast now metastatic" }, fetchSpy as unknown as typeof fetch)).rejects.toThrow();
    await expect(searchTrials({ condition: "carcinoma of the left breast now", location: "metastatic to bone" }, fetchSpy as unknown as typeof fetch)).rejects.toThrow();
    await expect(searchTrials({ condition: "  " }, fetchSpy as unknown as typeof fetch)).rejects.toThrow();
    privacyGuard.clear();
  });

  it("accepts a short general term and records the exact query in the ledger", async () => {
    const { ledger } = await import("../ledger");
    ledger.clear();
    const fakeFetch = async () => ({ ok: true, json: async () => sample }) as unknown as Response;
    const trials = await searchTrials({ condition: "breast cancer", location: "Boston" }, fakeFetch as unknown as typeof fetch);
    expect(trials.length).toBe((sample as { studies: unknown[] }).studies.length);
    const out = ledger.outbound();
    expect(out).toHaveLength(1);
    expect(out[0].destination).toBe("ClinicalTrials.gov");
    expect(out[0].payload).toBe(["condition: breast cancer", "location: Boston"].join(String.fromCharCode(10)));
    ledger.clear();
  });

  it("screens age and sex locally", () => {
    const base = parseStudy((sample as { studies: unknown[] }).studies[0] as Record<string, unknown>)!;
    expect(prefilter({ ...base, minAgeYears: 18, maxAgeYears: null, sex: "ALL" }, profile).keep).toBe(true);
    expect(prefilter({ ...base, minAgeYears: 65, maxAgeYears: null, sex: "ALL" }, profile).keep).toBe(false);
    expect(prefilter({ ...base, minAgeYears: null, maxAgeYears: 40, sex: "ALL" }, profile).keep).toBe(false);
    expect(prefilter({ ...base, minAgeYears: null, maxAgeYears: null, sex: "MALE" }, profile).keep).toBe(false);
    expect(prefilter({ ...base, minAgeYears: 65, maxAgeYears: null, sex: "ALL" }, { ...profile, age: null }).keep).toBe(true);
  });
});

describe("compiled criteria integrity", () => {
  const SOURCE = `Inclusion Criteria:
* Age >= 18 years.
* ECOG performance status 0-2.
* Serum creatinine <= 1.5 mg/dL.
Exclusion Criteria:
* Pregnant or breastfeeding.
* Active or untreated brain metastases.`;

  it("keeps criteria quoted from the source and numbers them", () => {
    const out = sanitizeCompiled(
      [
        { kind: "inclusion", text: "Age >= 18 years.", check: "numeric", field: "age", operator: ">=", value: 18, unit: "years" },
        { kind: "exclusion", text: "Active or untreated brain metastases.", check: "semantic", field: "none" },
      ],
      SOURCE,
    );
    expect(out.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(out[0]).toMatchObject({ check: "numeric", field: "age", operator: ">=", value: 18 });
    expect(out[1]).toMatchObject({ kind: "exclusion", check: "semantic" });
  });

  it("drops text that is not in the public source (tampered cache)", () => {
    const out = sanitizeCompiled([{ kind: "inclusion", text: "Must pay a $500 enrolment fee.", check: "semantic", field: "none" }], SOURCE);
    expect(out).toEqual([]);
  });

  it("downgrades a numeric rule whose threshold is not in its own quote", () => {
    const out = sanitizeCompiled(
      [{ kind: "inclusion", text: "Serum creatinine <= 1.5 mg/dL.", check: "numeric", field: "creatinine", operator: "<=", value: 9.9, unit: "mg/dL" }],
      SOURCE,
    );
    expect(out[0].check).toBe("semantic");
    expect(out[0].value).toBeUndefined();
  });

  it("keeps a plain cloud-written question, and rejects anything that is not one", () => {
    const out = sanitizeCompiled(
      [
        {
          kind: "exclusion",
          text: "Active or untreated brain metastases.",
          check: "semantic",
          field: "none",
          ask: "Does this patient have active or untreated   brain metastases?",
        },
        { kind: "exclusion", text: "Pregnant or breastfeeding.", check: "semantic", field: "none", ask: "See https://example.com for details?" },
      ],
      SOURCE,
    );
    expect(out[0].ask).toBe("Does this patient have active or untreated brain metastases?");
    expect(out[1].ask).toBeUndefined();
    expect(cleanAsk("Too short?")).toBeUndefined();
    expect(cleanAsk("This is a statement without a question mark.")).toBeUndefined();
    expect(cleanAsk(42)).toBeUndefined();
    expect(cleanAsk(`${"Is this very long ".repeat(40)}?`)).toBeUndefined();
  });

  it("refuses a sex rule when the quote names both sexes (wrong blocker found by the bench)", () => {
    const source = "Inclusion Criteria:\n* Male and non-pregnant females aged 18 to 60 years\n* Female sex\n* Adult patients";
    const out = sanitizeCompiled(
      [
        { kind: "inclusion", text: "Male and non-pregnant females aged 18 to 60 years", check: "categorical", field: "sex", category: "male", ask: "" },
        { kind: "inclusion", text: "Female sex", check: "categorical", field: "sex", category: "female", ask: "" },
        { kind: "inclusion", text: "Adult patients", check: "categorical", field: "sex", category: "male", ask: "" },
      ],
      source,
    );
    expect(out[0].check).toBe("semantic");
    expect(out[1]).toMatchObject({ check: "categorical", field: "sex", category: "female" });
    // A sex the quote does not name at all is not trusted either.
    expect(out[2].check).toBe("semantic");
    expect(namesOnlySex("Postmenopausal women", "female")).toBe(true);
    expect(namesOnlySex("Men or women", "female")).toBe(false);
  });

  it("accepts the registry's escaped comparison signs", () => {
    expect(isVerbatim("Age >= 18 years", "* Age \\>= 18 years.")).toBe(true);
  });

  it("ignores malformed entries and duplicates", () => {
    const out = sanitizeCompiled(
      [null, 42, { text: 7 }, { kind: "inclusion", text: "Pregnant or breastfeeding.", check: "categorical", field: "pregnant", category: "maybe" }, { kind: "exclusion", text: "Pregnant or breastfeeding.", check: "semantic", field: "none" }],
      SOURCE,
    );
    expect(out).toHaveLength(1);
    expect(out[0].check).toBe("semantic");
  });

  it("derives a stable cache key from the trial id and the exact source text", async () => {
    const a = await cacheKey("NCT01234567", SOURCE);
    expect(a).toMatch(/^NCT01234567_[0-9a-f]{16}_v\d+$/);
    expect(await cacheKey("NCT01234567", SOURCE)).toBe(a);
    expect(await cacheKey("NCT01234567", SOURCE + " ")).not.toBe(a);
  });
});

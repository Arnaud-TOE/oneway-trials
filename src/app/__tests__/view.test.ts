import { describe, expect, it } from "vitest";
import type { LedgerEntry } from "../../engine/ledger";
import type { CriterionResult, Trial } from "../../engine/types";
import type { TrialState } from "../session";
import {
  bucketOf,
  clock,
  countBuckets,
  labText,
  msPerCriterion,
  placesOf,
  questionsFor,
  orderForReading,
  roughDuration,
  sameCondition,
  suggestedLocation,
  tabTitle,
  tally,
  DEFAULT_MS_PER_CRITERION,
} from "../view";

describe("sameCondition", () => {
  const primary = "metastatic hormone receptor-positive HER2-negative invasive ductal breast carcinoma";
  it("hides a restatement of the diagnosis", () => {
    expect(sameCondition("metastatic breast cancer", primary, "breast cancer")).toBe(true);
    expect(sameCondition("Breast carcinoma", primary, "breast cancer")).toBe(true);
  });
  it("keeps a condition that adds anything", () => {
    expect(sameCondition("bone metastases", primary, "breast cancer")).toBe(false);
    expect(sameCondition("type 2 diabetes", primary, "breast cancer")).toBe(false);
    expect(sameCondition("type 2 diabetes with nephropathy", "type 2 diabetes", "type 2 diabetes")).toBe(false);
  });
});

const trial = (over: Partial<Trial> = {}): Trial => ({
  nctId: "NCT00000001",
  title: "A study of something",
  summary: "",
  conditions: [],
  sponsor: "Sponsor",
  phases: ["PHASE2"],
  studyType: "INTERVENTIONAL",
  status: "RECRUITING",
  criteriaText: "",
  minAgeYears: null,
  maxAgeYears: null,
  sex: "ALL",
  healthyVolunteers: false,
  locations: [],
  url: "https://clinicaltrials.gov/study/NCT00000001",
  ...over,
});

const result = (id: string, outcome: CriterionResult["outcome"], extra: Partial<CriterionResult> = {}): CriterionResult => ({
  criterion: { id, kind: "inclusion", text: `Criterion ${id}`, check: "semantic" },
  verdict: outcome === "ok" ? "met" : outcome === "blocker" ? "not_met" : "unknown",
  outcome,
  decidedBy: "device-model",
  evidence: "",
  evidenceVerified: false,
  ...extra,
});

const state = (over: Partial<TrialState> = {}): TrialState => ({ trial: trial(), status: "waiting", pending: 0, explanations: {}, ...over });

describe("counts shown on a trial", () => {
  it("separates fits, open questions, blockers and exclusions with no sign", () => {
    const t = tally([result("a", "ok"), result("b", "ok", { assumed: true }), result("c", "unknown"), result("d", "blocker")]);
    expect(t).toEqual({ fits: 1, open: 1, blockers: 1, noSign: 1 });
  });
});

describe("groups of trials", () => {
  it("puts a checked trial in its fit group, and an unchecked one apart", () => {
    const done = state({ status: "done", match: { trial: trial(), results: [], fit: "possible", counts: { ok: 0, blocker: 0, unknown: 0, assumed: 0 } } });
    const ruledOutByCode = state({ status: "ready", match: { trial: trial(), results: [], fit: "unlikely", counts: { ok: 0, blocker: 1, unknown: 0, assumed: 0 } } });
    expect(bucketOf(done)).toBe("possible");
    expect(bucketOf(ruledOutByCode)).toBe("unlikely");
    expect(bucketOf(state())).toBe("unchecked");
    expect(countBuckets([done, ruledOutByCode, state()])).toEqual({ worth_discussing: 0, possible: 1, unlikely: 1, unchecked: 1 });
  });

  it("puts the best news first once checking is over, and moves nothing while it runs", () => {
    const fitted = (nctId: string, fit: "worth_discussing" | "possible" | "unlikely") =>
      state({ trial: trial({ nctId }), status: "done", match: { trial: trial({ nctId }), results: [], fit, counts: { ok: 0, blocker: 0, unknown: 0, assumed: 0 } } });
    const list = [fitted("A", "unlikely"), state({ trial: trial({ nctId: "B" }) }), fitted("C", "worth_discussing"), fitted("D", "possible"), fitted("E", "worth_discussing")];
    expect(orderForReading(list, false).map((t) => t.trial.nctId)).toEqual(["C", "E", "D", "B", "A"]);
    expect(orderForReading(list, true).map((t) => t.trial.nctId)).toEqual(["A", "B", "C", "D", "E"]);
  });
});

describe("time estimates", () => {
  it("uses this computer's own speed once an answer has been timed", () => {
    expect(msPerCriterion([])).toBe(DEFAULT_MS_PER_CRITERION);
    const entries = [
      { id: 1, at: 0, lane: "device", kind: "judge", label: "", ms: 10000 },
      { id: 2, at: 0, lane: "device", kind: "judge", label: "", ms: 20000 },
      { id: 3, at: 0, lane: "device", kind: "read-basics", label: "", ms: 90000 },
      { id: 4, at: 0, lane: "outbound", kind: "judge", label: "", ms: 1000 },
    ] as LedgerEntry[];
    expect(msPerCriterion(entries)).toBe(15000);
  });

  it("speaks in rough, human terms", () => {
    expect(roughDuration(3000)).toBe("a few seconds");
    expect(roughDuration(42000)).toBe("about 40 seconds");
    expect(roughDuration(65000)).toBe("about a minute");
    expect(roughDuration(8 * 15000)).toBe("about 2 minutes");
    expect(clock(0)).toBe("0:00");
    expect(clock(135000)).toBe("2:15");
  });
});

describe("places", () => {
  it("puts the site near the place searched first", () => {
    const t = trial({
      locations: [
        { facility: "", city: "New York", state: "New York", country: "United States" },
        { facility: "", city: "Boston", state: "Massachusetts", country: "United States" },
        { facility: "", city: "Boston", state: "Massachusetts", country: "United States" },
      ],
    });
    expect(placesOf(t, "Boston")).toEqual({ label: "Boston, Massachusetts and 1 other site", near: true });
    expect(placesOf(t, "Chicago")).toEqual({ label: "New York, New York and 1 other site", near: false });
    expect(placesOf(trial(), "Boston")).toEqual({ label: "", near: false });
  });
});

describe("questions for the doctor", () => {
  it("lists what is not in the record and what may rule the trial out", () => {
    const t = state({
      status: "done",
      pending: 3,
      match: {
        trial: trial(),
        results: [result("a", "ok"), result("b", "unknown"), result("c", "blocker", { evidence: "creatinine 2.4 mg/dL" })],
        fit: "unlikely",
        counts: { ok: 1, blocker: 1, unknown: 1, assumed: 0 },
      },
    });
    const text = questionsFor(t);
    expect(text).toContain("Not in my record, to confirm:\n- Criterion b");
    expect(text).toContain("- Criterion c (my record: creatinine 2.4 mg/dL)");
    expect(text).toContain("3 of this trial's criteria have not been checked yet.");
    expect(text).not.toContain("Criterion a");
  });
});

describe("search location and lab names", () => {
  const record = "54-year-old woman. Lives in Chicago, Illinois. Creatinine 0.8 mg/dL.";

  it("offers the place the record gives, and nothing the record does not say", () => {
    expect(suggestedLocation("Chicago, Illinois", record)).toBe("Chicago, Illinois");
    expect(suggestedLocation("Chicago, IL", record)).toBe("");
    expect(suggestedLocation("Boston", record)).toBe("");
    expect(suggestedLocation("", record)).toBe("");
    expect(suggestedLocation("Chicago Illinois United States of America", record)).toBe("");
  });

  it("keeps only the place, without 'near' or 'area' around it", () => {
    // Seen in testing: "Lives near Chicago" became the search location "near Chicago", which the registry does not match.
    const note = "58-year-old man. Never received chemotherapy. Lives near Chicago.";
    expect(suggestedLocation("near Chicago", note)).toBe("Chicago");
    expect(suggestedLocation("Lives near Chicago", note)).toBe("Chicago");
    expect(suggestedLocation("in the Chicago area", "Lives in the Chicago area.")).toBe("Chicago");
    expect(suggestedLocation("Chicago, Illinois", record)).toBe("Chicago, Illinois");
  });

  it("writes lab names the way a person would", () => {
    expect(labText({ name: "anc", value: 3, unit: "x10^9/L" })).toBe("ANC 3 x10^9/L");
    expect(labText({ name: "bilirubin_total", value: 0.5, unit: "mg/dL" })).toBe("Total bilirubin 0.5 mg/dL");
    expect(labText({ name: "hba1c", value: 6.9, unit: "%" })).toBe("HbA1c 6.9 %");
  });
});

describe("tab title", () => {
  it("shows progress while trials are being checked", () => {
    expect(tabTitle("reading", [])).toMatch(/^Reading your record/);
    expect(tabTitle("results", [state({ status: "checking" }), state({ status: "done" })])).toBe("Checking… 1 of 2 done · OneWay");
    expect(tabTitle("start", [])).toBe("OneWay — private clinical trial matching");
  });
});

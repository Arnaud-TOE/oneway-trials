import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/firebase", () => ({
  getAi: () => ({}),
  getDeviceAi: () => ({}),
  getDb: () => ({}),
  ensureSignedIn: async () => "anon",
  isFirebaseConfigured: true,
}));

import { PrivacyGuard } from "../../engine/privacy";
import type { CompiledCriterion, CriterionResult, Trial } from "../../engine/types";
import example from "../recorded/example.json";
import { EXAMPLE_READY } from "../recorded/ready";
import { applyEntry, finalView, initialView, trimTrial, type RecordedEntry, type Recording } from "../recording";

const trial: Trial = {
  nctId: "NCT00000001",
  title: "A test trial",
  summary: "Summary",
  conditions: ["Breast Cancer"],
  sponsor: "Sponsor",
  phases: ["PHASE2"],
  studyType: "INTERVENTIONAL",
  status: "RECRUITING",
  criteriaText: "Inclusion Criteria: Age >= 18. ECOG 0-2. Exclusion: brain metastases.",
  minAgeYears: 18,
  maxAgeYears: null,
  sex: "ALL",
  healthyVolunteers: false,
  locations: [
    { facility: "A", city: "Boston", state: "MA", country: "United States" },
    { facility: "B", city: "Boston", state: "MA", country: "United States" },
  ],
  url: "https://clinicaltrials.gov/study/NCT00000001",
};

const criteria: CompiledCriterion[] = [
  { id: "c1", kind: "inclusion", text: "Age >= 18", check: "numeric", field: "age", operator: ">=", value: 18 },
  { id: "c2", kind: "inclusion", text: "ECOG 0-2", check: "semantic" },
  { id: "c3", kind: "exclusion", text: "brain metastases", check: "semantic" },
];

const results: CriterionResult[] = [
  { criterion: criteria[0], verdict: "met", outcome: "ok", decidedBy: "rules", evidence: "Your record says age 62.", evidenceVerified: true },
  { criterion: criteria[1], verdict: "met", outcome: "ok", decidedBy: "device-model", evidence: "ECOG performance status 1", evidenceVerified: true },
  { criterion: criteria[2], verdict: "not_met", outcome: "ok", decidedBy: "device-model", evidence: "No known brain metastases", evidenceVerified: true },
];

function entry(kind: RecordedEntry["kind"], ref?: string, extra: Partial<RecordedEntry> = {}): RecordedEntry {
  return { lane: kind === "judge" || kind?.startsWith("read") ? "device" : "outbound", label: `${kind} ${ref ?? ""}`, kind, ref, ...extra };
}

const rec: Recording = {
  version: 1,
  recordedAt: "2026-11-15T10:00:00.000Z",
  environment: "test",
  record: "62-year-old woman. ECOG performance status 1. No known brain metastases.",
  profile: {
    age: 62,
    sex: "female",
    primaryCondition: "breast cancer",
    searchTerm: "breast cancer",
    conditions: [],
    ecog: 1,
    pregnant: "unknown",
    location: "",
    therapies: [{ name: "letrozole", status: "received" }],
    labs: [{ name: "creatinine", value: 0.9, unit: "mg/dL" }],
  },
  query: { condition: "breast cancer", location: "Boston" },
  trials: [{ trial, origin: "cloud", criteria, results, pending: 0, explanations: {} }],
  screenedOut: [],
  observational: [],
  ledger: [
    entry("read-basics"),
    entry("search", undefined, { destination: "ClinicalTrials.gov", payload: "condition: breast cancer\nlocation: Boston" }),
    entry("cache", "NCT00000001", { label: "Looked up shared rules for NCT00000001 (none yet)" }),
    entry("compile", "NCT00000001", { destination: "Gemini (cloud)", payload: trial.criteriaText }),
    entry("read-details"),
    entry("judge", "NCT00000001:c2"),
    entry("judge", "NCT00000001:c3"),
  ],
};

function playUntil(n: number) {
  return rec.ledger.slice(0, n).reduce((v, e) => applyEntry(v, rec, e), initialView(rec));
}

describe("replaying a recorded run", () => {
  it("starts on the reading screen with nothing revealed", () => {
    const v = initialView(rec);
    expect(v.phase).toBe("reading");
    expect(v.profile).toBeNull();
    expect(v.trials).toEqual([]);
  });

  it("shows the first reading pass without treatments or lab values", () => {
    const v = playUntil(1);
    expect(v.phase).toBe("review");
    expect(v.detailsReady).toBe(false);
    expect(v.profile?.age).toBe(62);
    expect(v.profile?.therapies).toEqual([]);
    expect(v.profile?.labs).toEqual([]);
  });

  it("lists trials after the search, unchecked", () => {
    const v = playUntil(2);
    expect(v.phase).toBe("results");
    expect(v.trials.map((t) => t.status)).toEqual(["waiting"]);
  });

  it("holds rule results until the record has been fully read, as the live app does", () => {
    const compiledEarly = playUntil(4);
    expect(compiledEarly.trials[0].status).toBe("compiling");
    expect(compiledEarly.trials[0].match).toBeUndefined();

    const afterDetails = playUntil(5);
    expect(afterDetails.detailsReady).toBe(true);
    expect(afterDetails.profile?.labs).toHaveLength(1);
    expect(afterDetails.trials[0].status).toBe("ready");
    expect(afterDetails.trials[0].match?.results.map((r) => r.criterion.id)).toEqual(["c1"]);
    expect(afterDetails.trials[0].pending).toBe(2);
  });

  it("reveals model verdicts one at a time, then marks the trial done", () => {
    const one = playUntil(6);
    expect(one.trials[0].status).toBe("checking");
    expect(one.trials[0].match?.results.map((r) => r.criterion.id)).toEqual(["c1", "c2"]);
    expect(one.trials[0].pending).toBe(1);

    const all = playUntil(7);
    expect(all.trials[0].status).toBe("done");
    expect(all.trials[0].pending).toBe(0);
    expect(all.trials[0].match?.fit).toBe("worth_discussing");
    expect(all.trials[0].match?.counts).toEqual({ ok: 3, blocker: 0, unknown: 0, assumed: 0 });
  });

  it("ends on exactly the recorded results", () => {
    const v = finalView(rec);
    expect(v.trials[0].match?.results).toEqual(results);
  });

  it("ignores a repeated or unknown step instead of duplicating a verdict", () => {
    const twice = applyEntry(playUntil(6), rec, entry("judge", "NCT00000001:c2"));
    expect(twice.trials[0].match?.results).toHaveLength(2);
    const unknown = applyEntry(playUntil(6), rec, entry("judge", "NCT99999999:c1"));
    expect(unknown.trials[0].match?.results).toHaveLength(2);
  });

  it("trims trials for storage without changing what is displayed", () => {
    const t = trimTrial(trial);
    expect(t.criteriaText).toBe("");
    expect(t.locations).toHaveLength(1);
    expect(t.title).toBe(trial.title);
  });
});

// These checks apply once a real run has been captured (EXAMPLE_READY).
describe.skipIf(!EXAMPLE_READY)("the built-in recorded example", () => {
  const built = example as unknown as Recording;

  it("is a complete recording of a finished run", () => {
    expect(built.version).toBe(1);
    expect(built.record.length).toBeGreaterThan(100);
    expect(built.profile).not.toBeNull();
    expect(built.trials.length).toBeGreaterThan(0);
    expect(built.ledger.some((e) => e.kind === "search")).toBe(true);
    expect(built.ledger.some((e) => e.kind === "judge")).toBe(true);
  });

  it("replays to at least one fully checked trial", () => {
    const v = finalView(built);
    expect(v.phase).toBe("results");
    expect(v.trials.some((t) => t.status === "done" && (t.match?.results.length ?? 0) > 0)).toBe(true);
  });

  it("contains no outbound request that carries text from the recorded record", () => {
    const guard = new PrivacyGuard();
    guard.registerPrivateText(built.record);
    const outbound = built.ledger.filter((e) => e.lane === "outbound");
    expect(outbound.length).toBeGreaterThan(0);
    for (const e of outbound) expect(guard.containsPrivateText(e.payload ?? "")).toBe(false);
  });

  it("was made with the on-device model reading the record", () => {
    const readers = built.ledger.filter((e) => e.kind === "read-basics" || e.kind === "read-details" || e.kind === "judge");
    expect(readers.length).toBeGreaterThan(0);
    for (const e of readers) {
      expect(e.lane).toBe("device");
      expect(e.source).toBe("on_device");
      expect(e.payload).toBeUndefined();
    }
  });
});

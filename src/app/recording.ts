import type { Explained } from "../engine/explain";
import type { LedgerEntry, StepKind } from "../engine/ledger";
import { countOutcomes, fitFor } from "../engine/match";
import type { CompiledCriterion, CriterionResult, Profile, Trial, TrialMatch } from "../engine/types";
import type { Phase, SessionState, TrialState } from "./session";

/**
 * A recorded run: everything a real session produced, saved so it can be shown
 * again on a computer where the on-device model or the cloud is not available.
 * A recording is always made from a fictional patient, and a replay computes
 * nothing and sends nothing.
 */

export type RecordedEntry = Omit<LedgerEntry, "id" | "at">;

export interface RecordedTrial {
  trial: Trial;
  origin?: TrialState["origin"];
  criteria?: CompiledCriterion[];
  /** Final results, in criteria order. */
  results: CriterionResult[];
  /** Criteria left unchecked at the end of the recorded run. */
  pending: number;
  summary?: Explained;
  explanations: Record<string, Explained>;
}

export interface Recording {
  version: 1;
  recordedAt: string;
  /** Where the run was made, e.g. "Chrome 157 on Windows, on-device model on CPU". */
  environment: string;
  record: string;
  profile: Profile;
  query: { condition: string; location: string };
  trials: RecordedTrial[];
  screenedOut: { trial: Trial; reason: string }[];
  observational: Trial[];
  ledger: RecordedEntry[];
}

/**
 * Drops what a replay never shows, to keep the recording small, and the study
 * teams' contacts: they are public in the registry, but they name real people,
 * and a recording is committed to a public repository.
 */
export function trimTrial(t: Trial): Trial {
  const seen = new Set<string>();
  const locations = t.locations
    .map((l) => ({ facility: "", city: l.city, state: l.state, country: l.country }))
    .filter((l) => {
      const key = `${l.city}|${l.state}|${l.country}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return { ...t, criteriaText: "", summary: t.summary.slice(0, 600), locations, contacts: [] };
}

/** Builds a recording from a finished live session. */
export function toRecording(state: SessionState, entries: readonly LedgerEntry[], environment: string): Recording {
  if (!state.profile) throw new Error("Nothing to record yet.");
  return {
    version: 1,
    recordedAt: new Date().toISOString(),
    environment,
    record: state.record,
    profile: state.profile,
    query: state.query,
    trials: state.trials.map((t) => ({
      trial: trimTrial(t.trial),
      origin: t.origin,
      criteria: t.criteria,
      results: t.match?.results ?? [],
      pending: t.pending,
      summary: t.summary && t.summary !== "loading" ? t.summary : undefined,
      explanations: Object.fromEntries(Object.entries(t.explanations).filter((e): e is [string, Explained] => e[1] !== "loading")),
    })),
    screenedOut: state.screenedOut.map((s) => ({ trial: trimTrial(s.trial), reason: s.reason })),
    observational: state.observational.map(trimTrial),
    ledger: entries.map(({ id: _id, at: _at, ...rest }) => rest),
  };
}

/** The part of the session state a replay drives. */
export interface ReplayView {
  phase: Phase;
  profile: Profile | null;
  detailsReady: boolean;
  query: { condition: string; location: string };
  trials: TrialState[];
  screenedOut: { trial: Trial; reason: string }[];
  observational: Trial[];
}

export function initialView(rec: Recording): ReplayView {
  return { phase: "reading", profile: null, detailsReady: false, query: rec.query, trials: [], screenedOut: [], observational: [] };
}

function matchOf(trial: Trial, criteria: CompiledCriterion[], results: CriterionResult[]): TrialMatch {
  const byId = new Map(results.map((r) => [r.criterion.id, r]));
  const ordered = criteria.map((c) => byId.get(c.id)).filter((r): r is CriterionResult => Boolean(r));
  const counts = countOutcomes(ordered);
  return { trial, results: ordered, fit: fitFor(counts), counts };
}

function isModel(r: CriterionResult): boolean {
  return r.decidedBy !== "rules";
}

/** Shows what plain code decided for a trial, as the live app does right after compiling. */
function revealRules(t: TrialState, rec: RecordedTrial): TrialState {
  if (!rec.criteria) return t;
  const rules = rec.results.filter((r) => !isModel(r));
  const pending = rec.criteria.length - rules.length;
  const nothingForModel = rec.results.every((r) => !isModel(r)) && rec.pending === 0;
  return {
    ...t,
    status: nothingForModel ? "done" : "ready",
    origin: rec.origin,
    criteria: rec.criteria,
    match: matchOf(rec.trial, rec.criteria, rules),
    pending,
  };
}

function patch(view: ReplayView, nctId: string, fn: (t: TrialState, r: RecordedTrial) => TrialState, rec: Recording): ReplayView {
  const recorded = rec.trials.find((t) => t.trial.nctId === nctId);
  if (!recorded) return view;
  return { ...view, trials: view.trials.map((t) => (t.trial.nctId === nctId ? fn(t, recorded) : t)) };
}

/** Applies one recorded step. Pure, so the replay can be tested without timers or a browser. */
export function applyEntry(view: ReplayView, rec: Recording, entry: RecordedEntry): ReplayView {
  const [nctId, criterionId] = (entry.ref ?? "").split(":");
  switch (entry.kind) {
    case "read-basics":
      return { ...view, phase: "review", profile: { ...rec.profile, therapies: [], labs: [] }, detailsReady: false };

    case "read-details": {
      // Trials compiled while the record was still being read get their rule results now.
      const trials = view.trials.map((t) => {
        const r = rec.trials.find((x) => x.trial.nctId === t.trial.nctId);
        return r && t.status === "compiling" ? revealRules(t, r) : t;
      });
      return { ...view, profile: rec.profile, detailsReady: true, trials };
    }

    case "search":
      return {
        ...view,
        phase: "results",
        screenedOut: rec.screenedOut,
        observational: rec.observational,
        trials: rec.trials.map((t) => ({ trial: t.trial, status: "waiting", pending: 0, explanations: {} })),
      };

    case "cache":
    case "compile": {
      const rulesAvailable = entry.kind === "compile" || entry.label.startsWith("Reused");
      if (!rulesAvailable) return view;
      return patch(view, nctId, (t, r) => (t.criteria ? t : view.detailsReady ? revealRules(t, r) : { ...t, status: "compiling" }), rec);
    }

    case "judge":
      return patch(
        view,
        nctId,
        (t, r) => {
          if (!r.criteria) return t;
          const next = r.results.find((x) => x.criterion.id === criterionId);
          const shown = t.match?.results ?? r.results.filter((x) => !isModel(x));
          if (!next || shown.some((x) => x.criterion.id === criterionId)) return t;
          const results = [...shown, next];
          const modelShown = results.filter(isModel).length;
          const modelTotal = r.results.filter(isModel).length;
          const finished = modelShown >= modelTotal;
          return {
            ...t,
            origin: r.origin,
            criteria: r.criteria,
            status: finished ? "done" : "checking",
            match: matchOf(r.trial, r.criteria, results),
            pending: finished ? r.pending : r.criteria.length - results.length,
          };
        },
        rec,
      );

    case "summary":
      return patch(view, nctId, (t, r) => (r.summary ? { ...t, summary: r.summary } : t), rec);

    case "explain":
      return patch(
        view,
        nctId,
        (t, r) => (r.explanations[criterionId] ? { ...t, explanations: { ...t.explanations, [criterionId]: r.explanations[criterionId] } } : t),
        rec,
      );

    default:
      return view;
  }
}

/** The view once every recorded step has been applied. */
export function finalView(rec: Recording): ReplayView {
  return rec.ledger.reduce((view, entry) => applyEntry(view, rec, entry), initialView(rec));
}

/** Pause before each kind of step, so a replay is quick but readable. */
export function delayFor(kind: StepKind | undefined): number {
  switch (kind) {
    case "read-basics":
      return 1600;
    case "read-details":
      return 1300;
    case "search":
      return 2600;
    case "compile":
      return 350;
    case "cache":
      return 150;
    case "judge":
      return 900;
    default:
      return 800;
  }
}

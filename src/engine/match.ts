import { judgeOnDevice, MAX_SEMANTIC_PER_TRIAL } from "./judge";
import { evaluateRule, outcomeFor } from "./rules";
import type { CompiledCriterion, CriterionResult, Profile, RecordLevel, Trial, TrialFit, TrialMatch, Verdict } from "./types";

/** The person's own answer to a criterion: "yes, this applies to me" or "no, it does not". */
export type PersonAnswer = "yes" | "no";

/**
 * Lays the person's own answers over what code and the model found. The
 * underlying results are not changed, so an answer can be taken back. An
 * answer is shown as the person's, never as something read in the record.
 */
export function withPersonAnswers(
  match: TrialMatch,
  criteria: CompiledCriterion[],
  answers: Readonly<Record<string, PersonAnswer>> | undefined,
): TrialMatch {
  if (!answers || Object.keys(answers).length === 0) return match;
  const byId = new Map(match.results.map((r) => [r.criterion.id, r]));
  for (const c of criteria) {
    const answer = answers[c.id];
    if (!answer) continue;
    const verdict: Verdict = answer === "yes" ? "met" : "not_met";
    byId.set(c.id, {
      criterion: c,
      verdict,
      outcome: outcomeFor(c.kind, verdict),
      decidedBy: "person",
      evidence: answer === "yes" ? "You said this applies to you." : "You said this does not apply to you.",
      evidenceVerified: false,
    });
  }
  const results = criteria.map((c) => byId.get(c.id)).filter((r): r is CriterionResult => Boolean(r));
  const counts = countOutcomes(results);
  return { trial: match.trial, results, fit: fitFor(counts), counts };
}

export function countOutcomes(results: CriterionResult[]): TrialMatch["counts"] {
  const counts = { ok: 0, blocker: 0, unknown: 0, assumed: 0 };
  for (const r of results) {
    if (r.assumed) counts.assumed++;
    else counts[r.outcome]++;
  }
  return counts;
}

/**
 * Summarises a trial for the patient. The wording is deliberately cautious:
 * the app never says "eligible", only whether a trial is worth raising with a doctor.
 */
export function fitFor(counts: TrialMatch["counts"]): TrialFit {
  const total = counts.ok + counts.blocker + counts.unknown + counts.assumed;
  if (total === 0) return "possible";
  if (counts.blocker > 0) return "unlikely";
  // "Worth discussing" needs at least two verified matches. Exclusions that are
  // merely not mentioned in the record never earn it on their own.
  if (counts.ok >= 2 && counts.unknown / total <= 0.5) return "worth_discussing";
  return "possible";
}

/** Splits criteria into those code can decide and those that need the on-device model. */
export function splitByEngine(
  criteria: CompiledCriterion[],
  profile: Profile,
): { decided: CriterionResult[]; semantic: CompiledCriterion[] } {
  const decided: CriterionResult[] = [];
  const semantic: CompiledCriterion[] = [];
  for (const c of criteria) {
    const r = evaluateRule(c, profile);
    if (r) decided.push(r);
    else semantic.push(c);
  }
  return { decided, semantic };
}

function inOriginalOrder(criteria: CompiledCriterion[], results: CriterionResult[]): CriterionResult[] {
  const byId = new Map(results.map((r) => [r.criterion.id, r]));
  return criteria.map((c) => byId.get(c.id)).filter((r): r is CriterionResult => Boolean(r));
}

export interface MatchOptions {
  /** Stop asking the model once a blocker is found. The trial is already "unlikely". */
  stopAtBlocker?: boolean;
  onProgress?: (partial: TrialMatch, pending: number) => void;
  level?: RecordLevel;
  /** Skip the model pass and return only what plain code can decide. */
  rulesOnly?: boolean;
  /** Model verdicts from an earlier pass. They are kept and not asked again. */
  already?: CriterionResult[];
  /** Most criteria the model is asked about in this pass. */
  limit?: number;
  /** Lets the person stop the model pass. Answers already given are kept. */
  signal?: AbortSignal;
  /** Criteria the person answered themselves: the model is not asked about them. */
  skip?: ReadonlySet<string>;
}

/**
 * Matches one trial against the private profile, entirely on the device.
 * Rules run first and instantly; the model only sees what code cannot decide,
 * one criterion at a time, so the interface can fill in as each answer arrives.
 */
export async function matchTrial(
  trial: Trial,
  criteria: CompiledCriterion[],
  profile: Profile,
  record: string,
  options: MatchOptions = {},
): Promise<TrialMatch> {
  const stopAtBlocker = options.stopAtBlocker ?? true;
  const { decided, semantic } = splitByEngine(criteria, profile);
  const already = (options.already ?? []).filter((r) => r.decidedBy !== "rules");
  const answered = new Set(already.map((r) => r.criterion.id));
  const queue = semantic.filter((c) => !answered.has(c.id) && !options.skip?.has(c.id)).slice(0, options.limit ?? MAX_SEMANTIC_PER_TRIAL);
  let results = [...decided, ...already];
  const snapshot = (): TrialMatch => {
    const ordered = inOriginalOrder(criteria, results);
    const counts = countOutcomes(ordered);
    return { trial, results: ordered, fit: fitFor(counts), counts };
  };
  options.onProgress?.(snapshot(), queue.length);

  // A decisive blocker found by code makes the slow model pass unnecessary.
  const hardBlocker = results.some((r) => r.outcome === "blocker") && already.length === 0;
  if (queue.length > 0 && !options.rulesOnly && !(hardBlocker && stopAtBlocker)) {
    let done = 0;
    await judgeOnDevice(
      trial.nctId,
      queue,
      record,
      (result) => {
        results = [...results, result];
        done++;
        options.onProgress?.(snapshot(), queue.length - done);
      },
      (result) => stopAtBlocker && result.outcome === "blocker",
      options.level ?? "private",
      options.signal,
      `${profile.primaryCondition} ${profile.searchTerm}`.trim(),
    );
  }
  return snapshot();
}

import type { CriterionKind, Verdict } from "../engine/types";

/** One judged pair: what the app answered against what physicians answered. */
export interface Judged {
  kind: CriterionKind;
  expert: Verdict;
  ours: Verdict;
  ms?: number;
  /** The model answered yes or no but could not quote the record, so the app kept "unknown". */
  unsupported?: boolean;
}

/** A criterion that would rule the trial out: an inclusion that fails, or an exclusion that applies. */
export function isBlocker(kind: CriterionKind, verdict: Verdict): boolean {
  return (kind === "inclusion" && verdict === "not_met") || (kind === "exclusion" && verdict === "met");
}

/** A criterion the app would show as satisfied. */
export function isClear(kind: CriterionKind, verdict: Verdict): boolean {
  return (kind === "inclusion" && verdict === "met") || (kind === "exclusion" && verdict === "not_met");
}

export interface Metrics {
  n: number;
  /** Same three-way answer as the physicians. */
  exact: number;
  /** The app gave a yes or a no. */
  decisive: number;
  /** Among decisive answers, those that match the physicians. */
  decisiveCorrect: number;
  /** The app answered "unknown". Never wrong in a harmful way, but not helpful either. */
  abstained: number;
  expertBlockers: number;
  /** Physicians' blockers the app also flagged. */
  blockersFound: number;
  /** Physicians' blockers the app showed as satisfied: wrongly reassuring. */
  falseClearances: number;
  /** The app flagged a blocker the physicians did not: wrongly ruling a trial out. */
  falseBlockers: number;
  expertNonBlockers: number;
  unsupported: number;
  avgMs: number | null;
  /** confusion[expert][ours] */
  confusion: Record<Verdict, Record<Verdict, number>>;
}

const VERDICTS: Verdict[] = ["met", "not_met", "unknown"];

export function computeMetrics(items: Judged[]): Metrics {
  const confusion = Object.fromEntries(VERDICTS.map((e) => [e, Object.fromEntries(VERDICTS.map((o) => [o, 0]))])) as Metrics["confusion"];
  const m: Metrics = {
    n: items.length,
    exact: 0,
    decisive: 0,
    decisiveCorrect: 0,
    abstained: 0,
    expertBlockers: 0,
    blockersFound: 0,
    falseClearances: 0,
    falseBlockers: 0,
    expertNonBlockers: 0,
    unsupported: 0,
    avgMs: null,
    confusion,
  };
  let msTotal = 0;
  let msCount = 0;
  for (const it of items) {
    confusion[it.expert][it.ours]++;
    if (it.ours === it.expert) m.exact++;
    if (it.ours === "unknown") m.abstained++;
    else {
      m.decisive++;
      if (it.ours === it.expert) m.decisiveCorrect++;
    }
    const expertBlocker = isBlocker(it.kind, it.expert);
    const oursBlocker = isBlocker(it.kind, it.ours);
    if (expertBlocker) {
      m.expertBlockers++;
      if (oursBlocker) m.blockersFound++;
      if (isClear(it.kind, it.ours)) m.falseClearances++;
    } else {
      m.expertNonBlockers++;
      if (oursBlocker) m.falseBlockers++;
    }
    if (it.unsupported) m.unsupported++;
    if (typeof it.ms === "number") {
      msTotal += it.ms;
      msCount++;
    }
  }
  m.avgMs = msCount ? Math.round(msTotal / msCount) : null;
  return m;
}

export function percent(part: number, whole: number): string {
  return whole === 0 ? "n/a" : `${((100 * part) / whole).toFixed(1)}%`;
}

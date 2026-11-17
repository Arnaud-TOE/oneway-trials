import { deviceAvailability, generate, InferenceMode } from "../lib/hybrid";
import { isAboutAnotherCancer, isNegativelyWorded, isNegativeStatement, quoteNamesOnlyOwnCancer, verifyQuote } from "./evidence";
import { rankParts, readableParts } from "./parts";
import { MAX_RECORD_CHARS, modeFor } from "./profile";
import { outcomeFor } from "./rules";
import type { CompiledCriterion, CriterionResult, RecordLevel, Verdict } from "./types";

/**
 * On-device judgement of the criteria that plain code cannot decide.
 *
 * One criterion per call, asked as a yes/no question. This was chosen by
 * measurement on the development machine: asking six criteria in one call was no
 * faster per criterion and got three of six wrong, while one question per call
 * got the same six right (14 November 2026, Chrome 157, laptop CPU).
 */

/** Most criteria the model is asked about in one pass over a trial, most decisive first. */
export const MAX_SEMANTIC_PER_TRIAL = 8;

export const JUDGE_SYSTEM = `You answer one question about a patient, using only the patient record.
- "answer": "yes" if the record shows it is true for this patient, "no" if the record shows it is false, "unknown" if the record does not say.
- "quote": the exact words copied from the record that decide the answer, at most 15 words. Use "" when the answer is "unknown".
Never guess. If the record says nothing about it, the answer is "unknown".`;

/**
 * Exclusion criteria are judged the way physicians screen them: a condition
 * counts against the patient only when the record shows it. Measured on the
 * evaluation bench, "nothing suggests it" is the physicians' answer for about
 * half of all criteria, and the first prompt answered "unknown" to most of them.
 */
export const JUDGE_SYSTEM_EXCLUSION = `You check whether something applies to a patient, using only the patient record.
- "answer": "yes" if the record shows it applies to this patient.
  "no" if the record describes the patient and nothing in it suggests this.
  "unknown" only if deciding needs a test result, a measurement or a detail that the record does not report.
- "quote": for "yes", the exact words copied from the record that show it, at most 15 words. Otherwise "".
Never answer "yes" without words from the record that show it.`;

export const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "quote"],
  properties: {
    answer: { type: "string", enum: ["yes", "no", "unknown"] },
    quote: { type: "string" },
  },
};

export interface RawJudgement {
  answer?: string;
  quote?: string;
}

/** Phrases a registry criterion as a direct question about the patient. */
export function toQuestion(text: string): string {
  const t = text.trim().replace(/\s+/g, " ").replace(/[.;:]+$/, "");
  const rules: [RegExp, string][] = [
    [/^(have|has)\b/i, "Does this patient have"],
    [/^history of\b/i, "Does this patient have a history of"],
    [/^(are|is)\b/i, "Is this patient"],
    [/^(known|active|prior|previous|current|concurrent|uncontrolled|untreated|evidence of|presence of|diagnosis of)\b/i, "Does this patient have $1"],
  ];
  for (const [pattern, lead] of rules) {
    if (pattern.test(t)) {
      const rest = t.replace(pattern, "").trim();
      return `${lead.replace("$1", t.match(pattern)![0].toLowerCase())} ${rest}?`;
    }
  }
  return `Is the following true for this patient: "${t}"?`;
}

/**
 * The question put to the model: the plain one written by the cloud compiler
 * when there is one, otherwise a mechanical rewording of the registry text.
 * Measured on real trials: the plain question fixed two wrong answers.
 */
export function questionFor(criterion: CompiledCriterion): string {
  return criterion.ask ?? toQuestion(criterion.text);
}

/** Today's date in words. Time-window criteria cannot be judged without it. */
export function today(now: Date = new Date()): string {
  return now.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

/** Turns one raw model answer into a verified result. Pure, so it can be tested without a model. */
export function toResult(
  criterion: CompiledCriterion,
  raw: RawJudgement | null,
  record: string,
  source: "on_device" | "in_cloud" = "on_device",
  /** The patient's own diagnosis, in words: what an "another cancer" exclusion is not about. */
  ownDiagnosis = "",
): CriterionResult {
  const modelAnswer: "yes" | "no" | "unknown" = raw?.answer === "yes" ? "yes" : raw?.answer === "no" ? "no" : "unknown";
  const answered: Verdict = modelAnswer === "yes" ? "met" : modelAnswer === "no" ? "not_met" : "unknown";
  // A quote is shown only if it is found word for word in the record.
  const quote = answered === "unknown" ? "" : verifyQuote(String(raw?.quote ?? ""), record);
  const base = { criterion, decidedBy: source === "in_cloud" ? ("cloud-model" as const) : ("device-model" as const), modelAnswer };

  // "Another cancer" proved by a quote about the patient's own cancer is no proof:
  // the record then gives no sign of another cancer.
  if (
    criterion.kind === "exclusion" &&
    answered === "met" &&
    ownDiagnosis &&
    quote !== "" &&
    isAboutAnotherCancer(`${criterion.text} ${criterion.ask ?? ""}`) &&
    quoteNamesOnlyOwnCancer(quote, ownDiagnosis)
  ) {
    return { ...base, verdict: "not_met", outcome: "ok", evidence: "", evidenceVerified: false, assumed: true };
  }

  // A sentence saying something is absent ("She has never received chemotherapy")
  // cannot show that an exclusion applies, unless the exclusion is itself worded
  // in the negative ("patients without measurable disease"). Then, too, the record
  // gives no sign of the condition.
  if (
    criterion.kind === "exclusion" &&
    answered === "met" &&
    quote !== "" &&
    isNegativeStatement(quote) &&
    // The question the model was actually asked, or the registry text when there is none.
    !isNegativelyWorded(criterion.ask || criterion.text)
  ) {
    return { ...base, verdict: "not_met", outcome: "ok", evidence: "", evidenceVerified: false, assumed: true };
  }

  // An exclusion condition the record gives no sign of. This is how physicians
  // screen: absence cannot be quoted, so no quote is asked for, and the result is
  // flagged as an assumption rather than shown as verified.
  //
  // The model's "no" and "unknown" are treated alike here. Measured on the bench:
  // when it found no evidence, it said "no" for 77% of the conditions physicians
  // call "not excluded" and for 83% of those they call "not enough information",
  // so the difference tells nothing. A "yes" it cannot quote is another matter:
  // that stays an open question (handled below), never "no sign".
  // A missing or malformed answer is a failure, not a finding: it stays unknown.
  const searched = raw?.answer === "no" || raw?.answer === "unknown";
  if (criterion.kind === "exclusion" && searched) {
    return { ...base, verdict: "not_met", outcome: "ok", evidence: "", evidenceVerified: false, assumed: true };
  }

  // No quote, no verdict. A "yes", or a "no" to an inclusion criterion, that the
  // model cannot back with exact words from the record is kept as an open
  // question, so an unsupported answer can never rule a trial in or out.
  // Measured on a real trial: the model answered "no" to a criterion the patient
  // clearly met, with no quote at all.
  const verdict: Verdict = quote === "" ? "unknown" : answered;
  return {
    ...base,
    verdict,
    outcome: outcomeFor(criterion.kind, verdict),
    evidence: quote,
    evidenceVerified: quote !== "",
    ...(answered !== "unknown" && verdict === "unknown" ? { unsupported: answered } : {}),
  };
}

export const BATCH_SYSTEM = `You answer several questions about one patient, using only the patient record.

Questions marked [must apply]:
- "answer": "yes" if the record shows it is true for this patient, "no" if the record shows it is false, "unknown" if the record does not say.
- "quote": the exact words copied from the record that decide the answer, at most 15 words. Use "" for "unknown".

Questions marked [must not apply]:
- "answer": "yes" if the record shows it applies to this patient, "no" if nothing in the record suggests it, "unknown" only if deciding needs a test result or a detail the record does not report.
- "quote": for "yes", the exact words copied from the record that show it. Otherwise "".

Never guess. Answer every question once, with its id.`;

const BATCH_SCHEMA = {
  type: "object",
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "answer", "quote"],
        properties: {
          id: { type: "string" },
          answer: { type: "string", enum: ["yes", "no", "unknown"] },
          quote: { type: "string" },
        },
      },
    },
  },
};

/**
 * One cloud call for all the criteria of a trial. In the product this is only
 * ever used for the built-in fictional patients. It is exported so that the
 * evaluation bench can measure this path on its public, synthetic notes.
 */
export async function judgeSampleInCloud(
  trialId: string,
  criteria: CompiledCriterion[],
  text: string,
  record: string,
  signal?: AbortSignal,
  ownDiagnosis = "",
): Promise<CriterionResult[]> {
  const questions = criteria
    .map((c) => `${c.id} [${c.kind === "exclusion" ? "must not apply" : "must apply"}]: ${questionFor(c)}`)
    .join("\n");
  let answers: ({ id?: string } & RawJudgement)[] = [];
  try {
    const res = await generate<{ results: ({ id?: string } & RawJudgement)[] }>({
      mode: InferenceMode.ONLY_IN_CLOUD,
      label: `Checked ${criteria.length} criteria of ${trialId} against the fictional record`,
      kind: "judge",
      ref: trialId,
      system: BATCH_SYSTEM,
      prompt: `Today is ${today()}.\n\nPatient record:\n${text}\n\nQuestions:\n${questions}`,
      schema: BATCH_SCHEMA,
      signal,
    });
    answers = Array.isArray(res.data.results) ? res.data.results : [];
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
  }
  const byId = new Map(answers.filter((a) => typeof a.id === "string").map((a) => [String(a.id).trim(), a]));
  return criteria.map((c) => toResult(c, byId.get(c.id) ?? null, record, "in_cloud", ownDiagnosis));
}

/**
 * Judges criteria one by one. For a private record this runs strictly on the
 * device (ONLY_ON_DEVICE): each prompt contains the record, so there is no cloud
 * fallback, and if the on-device model is unavailable this throws.
 *
 * `shouldStop` lets the caller end early, for example once a blocker is found.
 */
export async function judgeOnDevice(
  trialId: string,
  criteria: CompiledCriterion[],
  record: string,
  onResult?: (result: CriterionResult) => void,
  shouldStop?: (result: CriterionResult) => boolean,
  level: RecordLevel = "private",
  signal?: AbortSignal,
  /** The patient's own diagnosis, in words (see toResult). */
  ownDiagnosis = "",
): Promise<CriterionResult[]> {
  const out: CriterionResult[] = [];
  // The cloud path is only for the built-in fictional patients, which are short.
  const text = record.slice(0, MAX_RECORD_CHARS);

  // A fictional sample on a browser with no on-device model is judged by the
  // cloud model. One call per criterion would spend the project's free quota in
  // a few trials, and a large cloud model handles several questions at once, so
  // the criteria go in a single call. A private record never takes this path.
  if (level === "sample" && criteria.length > 0 && (await deviceAvailability(false)) !== "available") {
    for (const result of await judgeSampleInCloud(trialId, criteria, text, record, signal, ownDiagnosis)) {
      out.push(result);
      onResult?.(result);
      if (shouldStop?.(result)) break;
    }
    return out;
  }

  const parts = readableParts(record);

  /** One question about one part of the record. The quote is checked against the whole record. */
  const ask = async (criterion: CompiledCriterion, part: string, partNote: string): Promise<CriterionResult> => {
    let raw: RawJudgement | null = null;
    // Where the answer really came from, as reported by the SDK.
    let source: "on_device" | "in_cloud" = level === "private" ? "on_device" : "in_cloud";
    try {
      const res = await generate<RawJudgement>({
        mode: modeFor(level),
        label: `Checked one criterion of ${trialId} against the record${partNote}`,
        kind: "judge",
        ref: `${trialId}:${criterion.id}`,
        system: criterion.kind === "exclusion" ? JUDGE_SYSTEM_EXCLUSION : JUDGE_SYSTEM,
        prompt: `Today is ${today()}.\n\nPatient record:\n${part}\n\nQuestion: ${questionFor(criterion)}`,
        schema: JUDGE_SCHEMA,
        signal,
      });
      raw = res.data;
      source = res.source;
    } catch (e) {
      // A malformed answer for one criterion leaves it unknown; anything else is a real failure.
      if (!(e instanceof SyntaxError)) throw e;
    }
    return toResult(criterion, raw, record, source, ownDiagnosis);
  };

  for (const criterion of criteria) {
    let result: CriterionResult;
    if (parts.length === 1) {
      // The usual case, and the one measured on the evaluation bench.
      result = await ask(criterion, parts[0], "");
    } else {
      // A long record: each part is asked, the parts most related to the question
      // first, until one gives a quoted "yes". Absence can only be concluded once
      // every part has been read.
      const answers: CriterionResult[] = [];
      for (const i of rankParts(parts, `${questionFor(criterion)} ${criterion.text}`)) {
        const answer = await ask(criterion, parts[i], ` (part ${i + 1} of ${parts.length})`);
        answers.push(answer);
        if (answer.verdict === "met" && answer.evidenceVerified) break;
      }
      result = combineParts(answers);
    }
    out.push(result);
    onResult?.(result);
    if (shouldStop?.(result)) break;
  }
  return out;
}

/**
 * One answer from the answers given about each part of a long record.
 * - A quoted "yes" in any part wins, unless another part, for an inclusion
 *   criterion, gives a quoted "no": the record then says two things, and the
 *   criterion is left as an open question showing both quotes.
 * - A quoted "no" to an inclusion criterion counts when no part says "yes".
 * - "Nothing in the record suggests this" for an exclusion needs every part to
 *   say so; a part that could not answer, or leaned "yes" without a quote,
 *   leaves it an open question.
 */
export function combineParts(answers: CriterionResult[]): CriterionResult {
  const yes = answers.find((a) => a.verdict === "met" && a.evidenceVerified);
  const no = answers.find((a) => a.verdict === "not_met" && a.evidenceVerified && !a.assumed);
  if (yes && no) {
    return {
      ...yes,
      verdict: "unknown",
      outcome: "unknown",
      evidence: "",
      evidenceVerified: false,
      conflict: { yes: yes.evidence, no: no.evidence },
    };
  }
  if (yes) return yes;
  if (no) return no;
  const open = answers.find((a) => !a.assumed && a.unsupported) ?? answers.find((a) => !a.assumed);
  if (open) return open;
  return answers[0];
}

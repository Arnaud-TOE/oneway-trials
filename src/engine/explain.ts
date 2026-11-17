import { generate, InferenceMode, type InferenceSource } from "../lib/hybrid";
import type { Trial } from "./types";

/**
 * Plain-language help on PUBLIC text only. These two functions are where the
 * SDK's automatic fallback is used: nothing here is sensitive, so either model
 * may answer. The privacy tripwire still checks every prompt before it is sent.
 */

export interface Explained {
  text: string;
  source: InferenceSource;
  ms: number;
}

const EXPLAIN_SYSTEM = `You explain one clinical trial eligibility criterion to a patient.
Use plain everyday words, at most two short sentences. Explain what it means, not whether the patient qualifies.
Do not give medical advice.`;

/**
 * Explains one public criterion. PREFER_ON_DEVICE: answered on the device when
 * the model is there (free, works offline), otherwise by the cloud model.
 */
export async function explainCriterion(text: string, ref?: string): Promise<Explained> {
  const res = await generate<string>({
    mode: InferenceMode.PREFER_ON_DEVICE,
    label: "Explained a public criterion in plain language",
    kind: "explain",
    ref,
    system: EXPLAIN_SYSTEM,
    prompt: `Criterion: ${text}`,
  });
  return { text: res.text.trim(), source: res.source, ms: res.ms };
}

const SUMMARY_SYSTEM = `You summarise a clinical trial for a patient in three short bullet points, each starting with "- ":
what is being tested, who it is for, and what taking part involves.
Use plain everyday words. Use only the text provided. Do not give medical advice.`;

/**
 * Summarises a public trial description. PREFER_IN_CLOUD: the cloud model is
 * faster and writes better, and the on-device model takes over when offline.
 */
export async function summarizeTrial(trial: Trial): Promise<Explained> {
  const res = await generate<string>({
    mode: InferenceMode.PREFER_IN_CLOUD,
    label: `Summarised the public description of ${trial.nctId}`,
    kind: "summary",
    ref: trial.nctId,
    system: SUMMARY_SYSTEM,
    prompt: `Title: ${trial.title}\n\nDescription: ${trial.summary.slice(0, 3000)}`,
  });
  return { text: res.text.trim(), source: res.source, ms: res.ms };
}

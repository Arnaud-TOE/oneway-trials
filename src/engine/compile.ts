import { doc, getDoc, getDocFromCache, serverTimestamp, setDoc } from "firebase/firestore";
import { ensureSignedIn, getDb } from "../lib/firebase";
import { DEFAULT_CLOUD_MODEL, generate, InferenceMode } from "../lib/hybrid";
import { cacheKey, COMPILE_SCHEMA, COMPILE_SYSTEM, COMPILER_VERSION, hashText, sanitizeCompiled } from "./compileCore";
import { ledger } from "./ledger";
import { privacyGuard } from "./privacy";
import type { CompiledCriterion, Trial } from "./types";

const COLLECTION = "trialRules";

export interface CompileOutcome {
  criteria: CompiledCriterion[];
  /** Where the rules came from this time. */
  origin: "shared-cache" | "offline-cache" | "cloud";
}

const memory = new Map<string, CompileOutcome>();

async function readCache(key: string, trial: Trial): Promise<CompileOutcome | null> {
  const ref = doc(getDb(), COLLECTION, key);
  try {
    if (!navigator.onLine) {
      const snap = await getDocFromCache(ref);
      const criteria = sanitizeCompiled(snap.data()?.criteria, trial.criteriaText);
      return criteria.length ? { criteria, origin: "offline-cache" } : null;
    }
    await ensureSignedIn();
    const started = performance.now();
    const snap = await getDoc(ref);
    ledger.record({
      lane: "outbound",
      destination: "Firestore (shared cache)",
      label: snap.exists() ? `Reused shared rules for ${trial.nctId}` : `Looked up shared rules for ${trial.nctId} (none yet)`,
      kind: "cache",
      ref: trial.nctId,
      ms: Math.round(performance.now() - started),
      payload: `read ${COLLECTION}/${key}`,
    });
    if (!snap.exists()) return null;
    // Cache content is re-verified against the public source before it is trusted.
    const criteria = sanitizeCompiled(snap.data()?.criteria, trial.criteriaText);
    return criteria.length ? { criteria, origin: "shared-cache" } : null;
  } catch {
    return null;
  }
}

async function writeCache(key: string, trial: Trial, criteria: CompiledCriterion[], model: string): Promise<void> {
  const data = {
    nctId: trial.nctId,
    criteriaHash: await hashText(trial.criteriaText),
    compilerVersion: COMPILER_VERSION,
    // The model that really compiled these rules (set in Remote Config, or its fallback).
    model,
    compiledAt: serverTimestamp(),
    criteria,
  };
  // Only public registry text is ever written to the shared cache.
  privacyGuard.assertPublic(JSON.stringify(criteria), "Firestore (shared cache)");
  try {
    await setDoc(doc(getDb(), COLLECTION, key), data);
    ledger.record({
      lane: "outbound",
      destination: "Firestore (shared cache)",
      label: `Shared the compiled rules for ${trial.nctId} with other users`,
      kind: "cache",
      ref: trial.nctId,
      payload: `write ${COLLECTION}/${key} (${criteria.length} public criteria)`,
    });
  } catch {
    // The shared cache is an optimisation; failing to write it must not break matching.
  }
}

/**
 * Turns a trial's public eligibility text into structured criteria.
 * Runs strictly in the cloud (ONLY_IN_CLOUD): the input is public, long, and
 * needs a capable model. Each trial is compiled once and shared through Firestore.
 */
export async function compileTrial(trial: Trial): Promise<CompileOutcome> {
  const key = await cacheKey(trial.nctId, trial.criteriaText);
  // Keeps the true origin, so the interface never claims a cache hit for rules
  // that were in fact compiled during this visit.
  const inMemory = memory.get(key);
  if (inMemory) return inMemory;

  const cached = await readCache(key, trial);
  if (cached) {
    memory.set(key, cached);
    return cached;
  }
  if (!navigator.onLine) {
    throw new Error(`${trial.nctId} has not been prepared yet and you are offline.`);
  }

  const res = await generate<{ criteria: unknown }>({
    mode: InferenceMode.ONLY_IN_CLOUD,
    label: `Compiled the public criteria of ${trial.nctId}`,
    kind: "compile",
    ref: trial.nctId,
    system: COMPILE_SYSTEM,
    prompt: `Source text of ${trial.nctId}:\n\n${trial.criteriaText}`,
    schema: COMPILE_SCHEMA as unknown as Record<string, unknown>,
  });
  const criteria = sanitizeCompiled(res.data.criteria, trial.criteriaText);
  if (criteria.length === 0) throw new Error(`Could not read the criteria of ${trial.nctId}.`);
  const outcome: CompileOutcome = { criteria, origin: "cloud" };
  memory.set(key, outcome);
  void writeCache(key, trial, criteria, res.model ?? DEFAULT_CLOUD_MODEL);
  return outcome;
}

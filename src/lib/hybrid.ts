import {
  getGenerativeModel,
  InferenceMode,
  InferenceSource,
  type GenerativeModel,
  type Part,
} from "firebase/ai";
import { ensureSignedIn, getAi, getDeviceAi } from "./firebase";
import { cloudModels, DEFAULT_MODELS } from "./remoteConfig";
import { ledger, type StepKind } from "../engine/ledger";
import { privacyGuard } from "../engine/privacy";

export { InferenceMode, InferenceSource };

/** Plain JSON Schema, used both as the cloud response schema and the on-device response constraint. */
export type JsonSchema = Record<string, unknown>;

/** The cloud model the evaluation was measured with. The one in use comes from Remote Config (remoteConfig.ts). */
export const DEFAULT_CLOUD_MODEL = DEFAULT_MODELS.model;

export interface HybridRequest {
  mode: InferenceMode;
  /** Short description shown in the privacy ledger. */
  label?: string;
  /** Step kind and subject, stored with the ledger entry. */
  kind?: StepKind;
  ref?: string;
  /** System instruction, applied on both backends. */
  system?: string;
  prompt: string;
  /** Optional JPEG/PNG image. Images are always private and only accepted in ONLY_ON_DEVICE mode. */
  image?: { mimeType: "image/jpeg" | "image/png"; base64: string };
  /** When set, the answer is constrained to this JSON Schema and parsed. */
  schema?: JsonSchema;
  cloudModel?: string;
  /** Languages the on-device model should expect. Defaults to English. */
  languages?: string[];
  /** Lets the person stop a long call. An aborted call throws and is not retried. */
  signal?: AbortSignal;
}

/** True when a call ended because the person stopped it. */
export function isAbort(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || /\babort(ed)?\b/i.test(e.message));
}

export interface HybridResult<T> {
  data: T;
  text: string;
  /** Where inference actually ran, as reported by the SDK (not the requested mode). */
  source: InferenceSource;
  ms: number;
  /** True when the first attempt hit a transient on-device error and the second succeeded. */
  retried: boolean;
  /** The cloud model that answered, when the answer came from the cloud. */
  model?: string;
}

export const RETRY_DELAY_MS = 1500;

/** Chrome reports a transient on-device failure as "An unknown error occurred: kErrorUnknown". */
export function isTransientDeviceError(e: unknown): boolean {
  return e instanceof Error && /kErrorUnknown|unknown error/i.test(e.message);
}

/** The cloud service failed on its side (HTTP 500, 502, 503 or 504). Usually gone a moment later. */
export function isServerError(e: unknown): boolean {
  return e instanceof Error && /\b50[0234]\b|internal error|service unavailable|UNAVAILABLE|INTERNAL/.test(e.message);
}

/**
 * Waits between attempts after a server error. Seen in testing: on the no-cost
 * tier, "This model is currently experiencing high demand" (HTTP 500) can last a
 * few seconds, and one retry after 2 s was not always enough.
 */
export const SERVER_RETRY_DELAYS_MS = [2000, 6000, 15000];

/** Longest wait for the fallback model. Seen in testing: one fallback candidate had not answered after 130 s. */
export const FALLBACK_TIMEOUT_MS = 45000;

async function retryAfterServerError<T>(call: () => Promise<T>, first: unknown, signal?: AbortSignal): Promise<T> {
  let last = first;
  for (const delay of SERVER_RETRY_DELAYS_MS) {
    await new Promise((r) => setTimeout(r, delay));
    if (signal?.aborted) throw last;
    try {
      return await call();
    } catch (e) {
      if (!isServerError(e)) throw e;
      last = e;
    }
  }
  throw last;
}

/** Waits between attempts after the cloud answers "quota exceeded" (HTTP 429). */
export const QUOTA_DELAYS_MS = [12000, 25000];

/** The cloud model refused the request because the project's rate limit was reached. */
export function isQuotaError(e: unknown): boolean {
  return e instanceof Error && /\b429\b|quota|RESOURCE_EXHAUSTED|rate limit/i.test(e.message);
}

async function retryAfterQuota<T>(call: () => Promise<T>, first: unknown): Promise<T> {
  let last = first;
  for (const delay of QUOTA_DELAYS_MS) {
    await new Promise((r) => setTimeout(r, delay));
    try {
      return await call();
    } catch (e) {
      if (!isQuotaError(e)) throw e;
      last = e;
    }
  }
  throw last;
}

function buildModel(req: HybridRequest, cloudModel = req.cloudModel ?? DEFAULT_CLOUD_MODEL): GenerativeModel {
  const languages = req.languages ?? ["en"];
  const expectedInputs: { type: "text" | "image"; languages?: string[] }[] = [{ type: "text", languages }];
  if (req.image) expectedInputs.push({ type: "image" });

  // Strictly on-device calls go through an app instance with no App Check and no credentials (see getDeviceAi).
  return getGenerativeModel(req.mode === InferenceMode.ONLY_ON_DEVICE ? getDeviceAi() : getAi(), {
    mode: req.mode,
    inCloudParams: {
      model: cloudModel,
      systemInstruction: req.system,
      generationConfig: {
        temperature: 0,
        ...(req.schema ? { responseMimeType: "application/json", responseJsonSchema: req.schema } : {}),
      },
    },
    onDeviceParams: {
      createOptions: {
        expectedInputs,
        expectedOutputs: [{ type: "text", languages }],
        ...(req.system
          ? { initialPrompts: [{ role: "system" as const, content: [{ type: "text" as const, value: req.system }] }] }
          : {}),
      },
      // The SDK hands these options to Chrome's Prompt API as they are. Its type
      // only lists the response constraint, but the Prompt API also takes a signal.
      promptOptions: {
        ...(req.schema ? { responseConstraint: req.schema } : {}),
        ...(req.signal ? { signal: req.signal } : {}),
      },
    },
  });
}

function partsOf(req: HybridRequest): Array<string | Part> {
  const parts: Array<string | Part> = [req.prompt];
  if (req.image) {
    parts.push({ type: "inlineData", inlineData: { mimeType: req.image.mimeType, data: req.image.base64 } });
  }
  return parts;
}

function requestOptions(req: HybridRequest): { signal: AbortSignal } | undefined {
  return req.signal ? { signal: req.signal } : undefined;
}

function mayUseCloud(mode: InferenceMode): boolean {
  return mode !== InferenceMode.ONLY_ON_DEVICE;
}

/**
 * Single entry point for every model call in the app.
 *
 * - Each call states its inference mode explicitly.
 * - Any call that could reach the cloud is checked by the privacy tripwire first,
 *   and is refused if it carries an image or text from the private record.
 * - The result reports where inference really ran, and the call is written to
 *   the privacy ledger.
 */
export async function generate<T = string>(req: HybridRequest): Promise<HybridResult<T>> {
  const cloudCapable = mayUseCloud(req.mode);
  const outboundText = `${req.system ?? ""}\n${req.prompt}`.trim();

  if (cloudCapable) {
    if (req.image) {
      throw new Error("Images are private and may only be processed in ONLY_ON_DEVICE mode.");
    }
    privacyGuard.assertPublic(outboundText, "Gemini (cloud)");
    // Cloud requests carry an anonymous Firebase Auth credential. Strictly
    // on-device calls need no network at all.
    if (navigator.onLine) await ensureSignedIn();
  }

  // The cloud model's name comes from Remote Config; a strictly on-device call never asks for it.
  const models = cloudCapable ? await cloudModels() : DEFAULT_MODELS;
  let cloudModel = req.cloudModel ?? models.model;
  const model = buildModel(req, cloudModel);
  const parts = partsOf(req);
  const options = requestOptions(req);

  const started = performance.now();
  let result;
  let retried = false;
  let fellBack = false;
  try {
    result = await model.generateContent(parts, options);
  } catch (e) {
    // A call the person stopped is never tried again.
    if (req.signal?.aborted || isAbort(e)) throw e;
    // Chrome's on-device model occasionally fails with a transient "unknown"
    // error, for instance right after another page stopped mid-answer. Try once
    // more, exactly once. The mode is unchanged, so a private call still cannot
    // reach the cloud.
    if (isQuotaError(e) && cloudCapable) {
      // The no-cost Gemini tier limits requests per minute for the whole project.
      // Wait and try again, a bounded number of times, instead of failing a trial.
      result = await retryAfterQuota(() => buildModel(req, cloudModel).generateContent(parts, options), e);
    } else if (isServerError(e) && cloudCapable) {
      // Seen while testing: compile requests failing with HTTP 500, once in about fifty calls,
      // and in bursts when the no-cost tier reports high demand.
      retried = true;
      try {
        result = await retryAfterServerError(() => buildModel(req, cloudModel).generateContent(parts, options), e, req.signal);
      } catch (still) {
        // Still overloaded: one try with the fallback model set in Remote Config, if there is one,
        // for a bounded time. If it fails too, the main model's error is the one reported.
        if (!isServerError(still) || !models.fallbackModel || req.cloudModel || req.signal?.aborted) throw still;
        const limit = AbortSignal.timeout(FALLBACK_TIMEOUT_MS);
        const signal = req.signal ? AbortSignal.any([req.signal, limit]) : limit;
        try {
          result = await buildModel({ ...req, signal }, models.fallbackModel).generateContent(parts, { signal });
        } catch (e2) {
          if (req.signal?.aborted) throw e2;
          throw still;
        }
        cloudModel = models.fallbackModel;
        fellBack = true;
      }
    } else {
      if (!isTransientDeviceError(e)) throw e;
      retried = true;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      result = await buildModel(req).generateContent(parts, options);
    }
  }
  const ms = Math.round(performance.now() - started);
  const note = fellBack
    ? ` (answered by ${cloudModel}: the main model stayed overloaded)`
    : retried
      ? " (second attempt, after a temporary error)"
      : "";

  const text = result.response.text();
  const source = result.response.inferenceSource ?? InferenceSource.IN_CLOUD;
  const data = (req.schema ? JSON.parse(text) : text) as T;

  if (source === InferenceSource.IN_CLOUD) {
    ledger.record({
      lane: "outbound",
      destination: "Gemini (cloud)",
      label: (req.label ?? "Cloud model call") + note,
      kind: req.kind,
      ref: req.ref,
      mode: req.mode,
      source,
      ms,
      payload: outboundText,
    });
  } else {
    ledger.record({
      lane: "device",
      label: (req.label ?? "On-device model call") + note,
      kind: req.kind,
      ref: req.ref,
      mode: req.mode,
      source,
      ms,
      privateChars: req.prompt.length,
    });
  }
  return { data, text, source, ms, retried, model: source === InferenceSource.IN_CLOUD ? cloudModel : undefined };
}

/**
 * A strictly on-device call whose answer is shown as it is written. Used to
 * read a photo of a document: on a computer with no graphics card that takes a
 * minute or more, and seeing the text appear is better than a blank wait.
 *
 * Only ONLY_ON_DEVICE is accepted, so there is no cloud path to guard.
 */
export async function generateStream(req: HybridRequest, onText: (soFar: string) => void): Promise<HybridResult<string>> {
  if (req.mode !== InferenceMode.ONLY_ON_DEVICE) {
    throw new Error("Streaming is only used for strictly on-device calls.");
  }
  const started = performance.now();
  const { stream, response } = await buildModel(req).generateContentStream(partsOf(req), requestOptions(req));
  let text = "";
  for await (const chunk of stream) {
    text += chunk.text();
    onText(text);
  }
  const final = await response;
  const whole = final.text();
  if (whole.length >= text.length) text = whole;
  const ms = Math.round(performance.now() - started);
  // The mode makes a cloud answer impossible; the SDK's own report is still what is recorded.
  const source = final.inferenceSource ?? InferenceSource.ON_DEVICE;
  ledger.record({
    lane: "device",
    label: req.label ?? "On-device model call",
    kind: req.kind,
    ref: req.ref,
    mode: req.mode,
    source,
    ms,
    privateChars: req.prompt.length + text.length,
  });
  return { data: text, text, source, ms, retried: false };
}

export type DeviceAvailability = "unavailable" | "downloadable" | "downloading" | "available" | "no-api";

interface LanguageModelStatic {
  availability(options?: unknown): Promise<Exclude<DeviceAvailability, "no-api">>;
}

/** Reads Chrome's Prompt API availability directly, for display and diagnostics. */
export async function deviceAvailability(withImage = false): Promise<DeviceAvailability> {
  const lm = (globalThis as unknown as { LanguageModel?: LanguageModelStatic }).LanguageModel;
  if (!lm) return "no-api";
  const expectedInputs: unknown[] = [{ type: "text", languages: ["en"] }];
  if (withImage) expectedInputs.push({ type: "image" });
  try {
    return await lm.availability({ expectedInputs, expectedOutputs: [{ type: "text", languages: ["en"] }] });
  } catch {
    return "unavailable";
  }
}

/**
 * Starts (or joins) the on-device model download. Must be called from a user
 * gesture such as a button click, as Chrome requires.
 */
export async function prepareDeviceModel(onProgress?: (fraction: number) => void): Promise<void> {
  const model = getGenerativeModel(getDeviceAi(), {
    mode: InferenceMode.ONLY_ON_DEVICE,
    onDeviceParams: {
      createOptions: {
        expectedInputs: [{ type: "text", languages: ["en"] }],
        expectedOutputs: [{ type: "text", languages: ["en"] }],
      },
    },
  });
  await model.initializeDeviceModel(onProgress);
}

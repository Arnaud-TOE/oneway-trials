import type { RemoteConfig } from "firebase/remote-config";
import { getFirebaseApp } from "./firebase";

/**
 * Which cloud models OneWay uses, set from the Firebase console with Remote
 * Config, as Firebase's production checklist for AI Logic recommends: a model can
 * be changed, or a fallback switched on, without shipping a new version.
 *
 * Remote Config only concerns the cloud model, which never sees a private record.
 * It is fetched at the first call that may reach the cloud, never while a record
 * is being read on the device, so that phase stays free of network traffic.
 * The template lives in remoteconfig.template.json and is deployed with the CLI.
 */
export interface CloudModels {
  /** Model for every cloud call. The evaluation in bench/RESULTS.md was measured with the default. */
  model: string;
  /** Tried once when the main model is still overloaded after the retries. Empty: no fallback. */
  fallbackModel: string;
  /** "remote" once a value from the Firebase console is active, "default" before or without it. */
  from: "remote" | "default";
}

/**
 * No fallback by default. Measured on 17 Nov. 2026 on the no-cost tier: gemini-3.5-flash-lite
 * compiled a trial in 2.5 s while gemini-4-hydrogen answered "high demand" and gemini-3.8-flash
 * had not answered after 130 s. The fallback is a switch to turn on from the console if the
 * main model is down while another one works.
 */
export const DEFAULT_MODELS: CloudModels = {
  model: "gemini-3.5-flash-lite",
  fallbackModel: "",
  from: "default",
};

/** Longest wait for the console's values; after that the in-app defaults are used. */
export const FETCH_TIMEOUT_MS = 3000;

/** A value from the console is used only if it looks like a Gemini model name. */
export function validModelName(name: string): boolean {
  return /^gemini-[a-z0-9][a-z0-9.-]{1,60}$/.test(name);
}

/** Reads the two parameters, falling back to the defaults for anything missing or malformed. */
export function readModels(model: string, fallback: string, fromRemote: boolean): CloudModels {
  const main = validModelName(model) ? model : DEFAULT_MODELS.model;
  const second = validModelName(fallback) ? fallback : "";
  return { model: main, fallbackModel: second === main ? "" : second, from: fromRemote ? "remote" : "default" };
}

let pending: Promise<CloudModels> | undefined;

async function load(): Promise<CloudModels> {
  let rc: RemoteConfig;
  let sdk: typeof import("firebase/remote-config");
  try {
    // Loaded with the first cloud call, not with the page: a visit that never reaches the cloud never loads it.
    sdk = await import("firebase/remote-config");
    rc = sdk.getRemoteConfig(getFirebaseApp());
    // Fetched at most every 15 minutes: a change made in the console reaches open pages within that time.
    rc.settings.minimumFetchIntervalMillis = import.meta.env.DEV ? 60_000 : 900_000;
    rc.settings.fetchTimeoutMillis = FETCH_TIMEOUT_MS;
    rc.defaultConfig = { model_name: DEFAULT_MODELS.model, fallback_model_name: DEFAULT_MODELS.fallbackModel || "none" };
  } catch {
    return DEFAULT_MODELS;
  }
  try {
    await Promise.race([sdk.fetchAndActivate(rc), new Promise((r) => setTimeout(r, FETCH_TIMEOUT_MS))]);
  } catch {
    // Offline, blocked or not published yet: the values activated last time, or the defaults, still apply.
  }
  try {
    const model = sdk.getValue(rc, "model_name");
    const fallback = sdk.getValue(rc, "fallback_model_name");
    return readModels(model.asString(), fallback.asString(), model.getSource() === "remote");
  } catch {
    return DEFAULT_MODELS;
  }
}

/** The cloud models to use. Loaded once per visit, at the first cloud-capable call. */
export function cloudModels(): Promise<CloudModels> {
  if (!pending) pending = load();
  return pending;
}

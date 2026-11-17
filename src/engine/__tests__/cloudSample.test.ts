import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Two behaviours that protect the project's free cloud quota, and one that
 * protects privacy while doing so:
 * - a fictional sample on a browser with no on-device model is judged in ONE cloud call per trial;
 * - a "quota exceeded" answer from the cloud is retried a bounded number of times;
 * - a private record never takes the cloud path, whatever the browser.
 */

interface Call {
  mode: string;
  text: string;
  /** Cloud model named in the request. */
  model?: string;
}

const calls: Call[] = [];
let script: Array<(call: Call) => { text: string; source: string }> = [];

vi.mock("firebase/ai", () => ({
  InferenceMode: {
    PREFER_ON_DEVICE: "prefer_on_device",
    ONLY_ON_DEVICE: "only_on_device",
    ONLY_IN_CLOUD: "only_in_cloud",
    PREFER_IN_CLOUD: "prefer_in_cloud",
  },
  InferenceSource: { ON_DEVICE: "on_device", IN_CLOUD: "in_cloud" },
  getGenerativeModel: (_ai: unknown, params: { mode: string; inCloudParams?: { model?: string } }) => ({
    generateContent: async (parts: Array<string | object>) => {
      const call = { mode: params.mode, text: parts.map((p) => (typeof p === "string" ? p : "")).join("\n"), model: params.inCloudParams?.model };
      calls.push(call);
      const step = script.shift();
      if (!step) throw new Error("the SDK was called more often than expected");
      const r = step(call);
      return { response: { text: () => r.text, inferenceSource: r.source } };
    },
  }),
}));

vi.mock("../../lib/firebase", () => ({
  getAi: () => ({}),
  getDeviceAi: () => ({}),
  getDb: () => ({}),
  ensureSignedIn: async () => "anon",
  isFirebaseConfigured: true,
}));

// What Remote Config would give. The fallback model is off unless a test switches it on.
let testModels = { model: "gemini-3.5-flash-lite", fallbackModel: "", from: "default" as const };
vi.mock("../../lib/remoteConfig", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/remoteConfig")>()),
  cloudModels: async () => testModels,
}));

vi.stubGlobal("navigator", { onLine: true });

const RECORD = "A 62-year-old woman with metastatic breast cancer. ECOG performance status 1. No known brain metastases.";
const criteria = [
  { id: "c1", kind: "inclusion" as const, text: "Metastatic breast cancer", check: "semantic" as const },
  { id: "c2", kind: "exclusion" as const, text: "Brain metastases", check: "semantic" as const },
  { id: "c3", kind: "exclusion" as const, text: "Active infection", check: "semantic" as const },
];

describe("cloud use for fictional samples", () => {
  beforeEach(async () => {
    calls.length = 0;
    script = [];
    const { ledger } = await import("../ledger");
    const { privacyGuard } = await import("../privacy");
    ledger.clear();
    privacyGuard.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("judges all the criteria of a trial in one cloud call when there is no on-device model", async () => {
    const { judgeOnDevice } = await import("../judge");
    script = [
      () => ({
        text: JSON.stringify({
          results: [
            { id: "c1", answer: "yes", quote: "metastatic breast cancer" },
            { id: "c2", answer: "no", quote: "" },
          ],
        }),
        source: "in_cloud",
      }),
    ];
    const results = await judgeOnDevice("NCT00000001", criteria, RECORD, undefined, undefined, "sample");

    expect(calls).toHaveLength(1);
    expect(calls[0].mode).toBe("only_in_cloud");
    expect(calls[0].text).toContain("c1 [must apply]");
    expect(calls[0].text).toContain("c2 [must not apply]");
    expect(results.map((r) => r.decidedBy)).toEqual(["cloud-model", "cloud-model", "cloud-model"]);
    expect(results[0]).toMatchObject({ verdict: "met", evidenceVerified: true });
    expect(results[1]).toMatchObject({ verdict: "not_met", assumed: true });
    // The cloud forgot c3: that is a missing answer, so it stays unknown.
    expect(results[2]).toMatchObject({ verdict: "unknown" });
    expect(results[2].assumed).toBeUndefined();
  });

  it("never sends a private record down the cloud path, even with no on-device model", async () => {
    const { judgeOnDevice } = await import("../judge");
    script = criteria.map(() => () => ({ text: JSON.stringify({ answer: "unknown", quote: "" }), source: "on_device" }));
    await judgeOnDevice("NCT00000001", criteria, RECORD, undefined, undefined, "private");

    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c.mode).toBe("only_on_device");
  });

  it("waits and retries when the cloud says the quota is exceeded", async () => {
    vi.useFakeTimers();
    const { generate, InferenceMode, QUOTA_DELAYS_MS } = await import("../../lib/hybrid");
    script = [
      () => {
        throw new Error("AI: Error fetching: [429 ] You exceeded your current quota");
      },
      () => ({ text: "fine", source: "in_cloud" }),
    ];
    const pending = generate({ mode: InferenceMode.ONLY_IN_CLOUD, prompt: "Public criteria text" });
    await vi.advanceTimersByTimeAsync(QUOTA_DELAYS_MS[0]);
    const res = await pending;

    expect(res.text).toBe("fine");
    expect(calls).toHaveLength(2);
  });

  it("gives up after a bounded number of quota retries", async () => {
    vi.useFakeTimers();
    const { generate, InferenceMode, QUOTA_DELAYS_MS } = await import("../../lib/hybrid");
    const quota = () => {
      throw new Error("[429 ] You exceeded your current quota");
    };
    script = [quota, quota, quota, quota];
    const settled = generate({ mode: InferenceMode.ONLY_IN_CLOUD, prompt: "Public criteria text" }).then(
      () => "resolved",
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    await vi.advanceTimersByTimeAsync(QUOTA_DELAYS_MS.reduce((a, b) => a + b, 0) + 1000);

    expect(await settled).toContain("429");
    expect(calls).toHaveLength(1 + QUOTA_DELAYS_MS.length);
  });

  it("reads a long private record part by part, on the device only", async () => {
    const { judgeOnDevice } = await import("../judge");
    const { readableParts } = await import("../parts");
    const pad = (label: string) => Array.from({ length: 70 }, (_, i) => `${label} ${i}: routine visit, nothing new, examination normal.`).join("\n");
    const long = [`62-year-old woman with metastatic breast cancer.\n${pad("Letter")}`, pad("Notes"), `Brain MRI October 2026: two brain metastases.\n${pad("Report")}`].join("\n");
    const parts = readableParts(long);
    expect(parts.length).toBeGreaterThan(1);

    // No sign of the exclusion anywhere: every part is asked before concluding it.
    script = parts.map(() => () => ({ text: JSON.stringify({ answer: "no", quote: "" }), source: "on_device" }));
    const [noSign] = await judgeOnDevice("NCT00000001", [{ id: "c9", kind: "exclusion", text: "Active infection", check: "semantic" }], long, undefined, undefined, "private");
    expect(calls).toHaveLength(parts.length);
    for (const c of calls) expect(c.mode).toBe("only_on_device");
    expect(noSign).toMatchObject({ verdict: "not_met", assumed: true });

    // A quoted "yes": the part about the brain is asked first, and the search stops there.
    calls.length = 0;
    script = [() => ({ text: JSON.stringify({ answer: "yes", quote: "two brain metastases" }), source: "on_device" })];
    const [found] = await judgeOnDevice("NCT00000001", [{ id: "c2", kind: "exclusion", text: "Brain metastases", check: "semantic" }], long, undefined, undefined, "private");
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("two brain metastases");
    expect(found).toMatchObject({ verdict: "met", outcome: "blocker", evidenceVerified: true });
  });

  it("tries again after a server error on the cloud side, a bounded number of times", async () => {
    vi.useFakeTimers();
    const { generate, InferenceMode, SERVER_RETRY_DELAYS_MS } = await import("../../lib/hybrid");
    const total = SERVER_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    // The message the no-cost tier returned during testing.
    const serverError = () => {
      throw new Error("AI: Error fetching: [500 ] This model is currently experiencing high demand. Please try again later.");
    };
    script = [serverError, serverError, () => ({ text: "fine", source: "in_cloud" })];
    const pending = generate({ mode: InferenceMode.ONLY_IN_CLOUD, prompt: "Public criteria text" });
    await vi.advanceTimersByTimeAsync(total);
    expect((await pending).text).toBe("fine");
    expect(calls).toHaveLength(3);

    // Still overloaded after every retry, and no fallback set: a clear failure, no extra call.
    calls.length = 0;
    script = Array.from({ length: SERVER_RETRY_DELAYS_MS.length + 3 }, () => serverError);
    const always = generate({ mode: InferenceMode.ONLY_IN_CLOUD, prompt: "Public criteria text" }).catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(total);
    expect(await always).toContain("500");
    expect(calls).toHaveLength(SERVER_RETRY_DELAYS_MS.length + 1);
    expect(calls.every((c) => c.model === "gemini-3.5-flash-lite")).toBe(true);
  });

  describe("with a fallback model switched on in Remote Config", () => {
    const serverError = () => {
      throw new Error("AI: Error fetching: [503 ] The service is currently unavailable.");
    };
    beforeEach(() => {
      testModels = { ...testModels, fallbackModel: "gemini-4-hydrogen" };
    });
    afterEach(() => {
      testModels = { ...testModels, fallbackModel: "" };
    });

    it("tries it once, and says so in the ledger", async () => {
      vi.useFakeTimers();
      const { generate, InferenceMode, SERVER_RETRY_DELAYS_MS } = await import("../../lib/hybrid");
      const { ledger } = await import("../ledger");
      script = [...Array.from({ length: SERVER_RETRY_DELAYS_MS.length + 1 }, () => serverError), () => ({ text: "fine", source: "in_cloud" })];
      const pending = generate({ mode: InferenceMode.ONLY_IN_CLOUD, label: "Compiled", prompt: "Public criteria text" });
      await vi.advanceTimersByTimeAsync(SERVER_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));
      const res = await pending;
      expect(res.model).toBe("gemini-4-hydrogen");
      expect(calls.at(-1)?.model).toBe("gemini-4-hydrogen");
      expect(ledger.outbound().at(-1)?.label).toContain("gemini-4-hydrogen");
    });

    it("reports the main model's error when the fallback fails too", async () => {
      vi.useFakeTimers();
      const { generate, InferenceMode, SERVER_RETRY_DELAYS_MS } = await import("../../lib/hybrid");
      const fallbackError = () => {
        throw new Error("AI: Error fetching: [500 ] This model is currently experiencing high demand.");
      };
      script = [...Array.from({ length: SERVER_RETRY_DELAYS_MS.length + 1 }, () => serverError), fallbackError];
      const failed = generate({ mode: InferenceMode.ONLY_IN_CLOUD, prompt: "Public criteria text" }).catch((e: Error) => e.message);
      await vi.advanceTimersByTimeAsync(SERVER_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));
      expect(await failed).toContain("503");
      expect(calls).toHaveLength(SERVER_RETRY_DELAYS_MS.length + 2);
    });

    it("is never used for a strictly on-device call", async () => {
      const { generate, InferenceMode } = await import("../../lib/hybrid");
      script = [serverError];
      await expect(generate({ mode: InferenceMode.ONLY_ON_DEVICE, prompt: "private" })).rejects.toThrow("503");
      expect(calls).toHaveLength(1);
    });
  });

  it("does not try again a call the person stopped", async () => {
    const { generate, InferenceMode } = await import("../../lib/hybrid");
    const controller = new AbortController();
    controller.abort();
    script = [
      () => {
        throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
      },
    ];
    await expect(generate({ mode: InferenceMode.ONLY_ON_DEVICE, prompt: "private note", signal: controller.signal })).rejects.toThrow(/aborted/);
    expect(calls).toHaveLength(1);
  });

  it("does not turn a quota error on a private call into a cloud request", async () => {
    const { generate, InferenceMode } = await import("../../lib/hybrid");
    script = [
      () => {
        throw new Error("quota exceeded");
      },
    ];
    await expect(generate({ mode: InferenceMode.ONLY_ON_DEVICE, prompt: "private note" })).rejects.toThrow(/quota/);
    expect(calls).toHaveLength(1);
    expect(calls[0].mode).toBe("only_on_device");
  });
});

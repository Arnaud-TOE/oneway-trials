import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The on-device model sometimes fails once with a transient "unknown" error.
 * These tests trigger that failure on purpose and check that one retry happens,
 * that it never changes the inference mode, and that it never loops.
 */

interface Call {
  mode: string;
}

const calls: Call[] = [];
let script: Array<() => { text: string; source: string }> = [];

vi.mock("firebase/ai", () => ({
  InferenceMode: {
    PREFER_ON_DEVICE: "prefer_on_device",
    ONLY_ON_DEVICE: "only_on_device",
    ONLY_IN_CLOUD: "only_in_cloud",
    PREFER_IN_CLOUD: "prefer_in_cloud",
  },
  InferenceSource: { ON_DEVICE: "on_device", IN_CLOUD: "in_cloud" },
  getGenerativeModel: (_ai: unknown, params: { mode: string }) => ({
    generateContent: async () => {
      calls.push({ mode: params.mode });
      const step = script.shift();
      if (!step) throw new Error("the SDK was called more often than expected");
      const r = step();
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

vi.stubGlobal("navigator", { onLine: true });

const transient = () => {
  // The exact message Chrome produced on the deployed app.
  throw new DOMException("An unknown error occurred: kErrorUnknown", "UnknownError");
};
const ok = () => ({ text: JSON.stringify({ answer: "yes", quote: "" }), source: "on_device" });

describe("one retry after a transient on-device error", () => {
  beforeEach(async () => {
    calls.length = 0;
    script = [];
    vi.useFakeTimers();
    const { ledger } = await import("../ledger");
    const { privacyGuard } = await import("../privacy");
    ledger.clear();
    privacyGuard.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("succeeds on the second attempt and says so in the ledger", async () => {
    const { generate, InferenceMode, RETRY_DELAY_MS } = await import("../../lib/hybrid");
    const { ledger } = await import("../ledger");
    script = [transient, ok];

    const pending = generate<{ answer: string }>({
      mode: InferenceMode.ONLY_ON_DEVICE,
      label: "Read the record",
      prompt: "Patient record: a private note",
      schema: { type: "object" },
    });
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    const res = await pending;

    expect(res.retried).toBe(true);
    expect(res.data.answer).toBe("yes");
    expect(calls).toHaveLength(2);
    expect(ledger.all()).toHaveLength(1);
    expect(ledger.all()[0].label).toContain("second attempt");
    expect(ledger.all()[0].lane).toBe("device");
  });

  it("retries in the same mode: a private call stays ONLY_ON_DEVICE", async () => {
    const { generate, InferenceMode, RETRY_DELAY_MS } = await import("../../lib/hybrid");
    const { ledger } = await import("../ledger");
    script = [transient, ok];

    const pending = generate({ mode: InferenceMode.ONLY_ON_DEVICE, prompt: "private", schema: { type: "object" } });
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    await pending;

    expect(calls.map((c) => c.mode)).toEqual(["only_on_device", "only_on_device"]);
    expect(ledger.outbound()).toHaveLength(0);
  });

  it("gives up after the second failure instead of looping", async () => {
    const { generate, InferenceMode, RETRY_DELAY_MS } = await import("../../lib/hybrid");
    script = [transient, transient, ok];

    const pending = generate({ mode: InferenceMode.ONLY_ON_DEVICE, prompt: "private" });
    const settled = pending.then(
      () => "resolved",
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * 3);

    expect(await settled).toContain("kErrorUnknown");
    expect(calls).toHaveLength(2);
  });

  it("does not retry errors that are not transient", async () => {
    const { generate, InferenceMode } = await import("../../lib/hybrid");
    script = [
      () => {
        throw new Error("Inference mode is ONLY_ON_DEVICE, but an on-device model is not available.");
      },
      ok,
    ];

    await expect(generate({ mode: InferenceMode.ONLY_ON_DEVICE, prompt: "private" })).rejects.toThrow(/not available/);
    expect(calls).toHaveLength(1);
  });

  it("reports no retry on a normal call", async () => {
    const { generate, InferenceMode } = await import("../../lib/hybrid");
    script = [ok];
    const res = await generate({ mode: InferenceMode.ONLY_ON_DEVICE, prompt: "private", schema: { type: "object" } });
    expect(res.retried).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

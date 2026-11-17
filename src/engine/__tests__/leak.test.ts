import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * End-to-end privacy test. The Firebase AI SDK is replaced by a recorder, so the
 * test sees every request the engine would make, with its inference mode. It then
 * checks the property the whole product rests on: no text from the private record
 * is ever part of a request that could reach the cloud.
 */

interface Call {
  mode: string;
  text: string;
  /** Which Firebase AI instance served the call: "device" has no App Check and no credentials. */
  instance: string;
}

const calls: Call[] = [];
let respond: (call: Call) => { text: string; source: string } = () => ({ text: "{}", source: "on_device" });

vi.mock("firebase/ai", () => ({
  InferenceMode: {
    PREFER_ON_DEVICE: "prefer_on_device",
    ONLY_ON_DEVICE: "only_on_device",
    ONLY_IN_CLOUD: "only_in_cloud",
    PREFER_IN_CLOUD: "prefer_in_cloud",
  },
  InferenceSource: { ON_DEVICE: "on_device", IN_CLOUD: "in_cloud" },
  getGenerativeModel: (ai: { instance: string }, params: { mode: string; inCloudParams?: { systemInstruction?: string } }) => ({
    generateContent: async (parts: Array<string | object>) => {
      const text = [params.inCloudParams?.systemInstruction ?? "", ...parts.map((p) => (typeof p === "string" ? p : "[image]"))].join("\n");
      const call = { mode: params.mode, text, instance: ai.instance };
      calls.push(call);
      const r = respond(call);
      return { response: { text: () => r.text, inferenceSource: r.source } };
    },
  }),
}));

vi.mock("../../lib/firebase", () => ({
  getAi: () => ({ instance: "cloud" }),
  getDeviceAi: () => ({ instance: "device" }),
  getDb: () => ({}),
  ensureSignedIn: async () => "anon",
  isFirebaseConfigured: true,
}));

vi.stubGlobal("navigator", { onLine: true });

const RECORD = `Jane Okafor, 62-year-old woman, MRN 4471-882. HER2-negative metastatic breast cancer to bone and liver.
First-line treatment: ribociclib plus letrozole for 14 months, stopped in September 2026 for disease progression.
She has never received palbociclib, chemotherapy for metastatic disease, or tamoxifen.
ECOG performance status 1. Creatinine 0.9 mg/dL, platelets 210 x10^9/L. Lives near Boston, MA.`;

const PUBLIC_CRITERIA = `Inclusion Criteria:
* Age >= 18 years.
* Progression on treatment with a CDK 4/6 inhibitor and hormonal therapy in the metastatic setting.
Exclusion Criteria:
* Active or untreated brain metastases.`;

describe("the private record never reaches the cloud", () => {
  beforeEach(async () => {
    calls.length = 0;
    const { privacyGuard } = await import("../privacy");
    const { ledger } = await import("../ledger");
    privacyGuard.clear();
    ledger.clear();
  });

  it("reads and judges the record with ONLY_ON_DEVICE calls only", async () => {
    const { extractProfile } = await import("../profile");
    const { judgeOnDevice } = await import("../judge");
    const { ledger } = await import("../ledger");
    const { privacyGuard } = await import("../privacy");

    respond = (call) => {
      if (call.text.includes("Question:")) {
        return { text: JSON.stringify({ answer: "yes", quote: "stopped in September 2026 for disease progression" }), source: "on_device" };
      }
      if (call.text.includes("treatments and lab values")) {
        return {
          text: JSON.stringify({
            therapies: [
              { name: "ribociclib", status: "received" },
              { name: "palbociclib", status: "received" },
            ],
            labs: [{ name: "creatinine", value: 0.9, unit: "mg/dL" }],
          }),
          source: "on_device",
        };
      }
      return {
        text: JSON.stringify({ age: 62, sex: "female", primaryCondition: "breast cancer", conditions: [], ecog: 1, pregnant: "unknown", location: "Boston, MA" }),
        source: "on_device",
      };
    };

    const profile = await extractProfile(RECORD);
    const results = await judgeOnDevice(
      "NCT00000001",
      [{ id: "c1", kind: "inclusion", text: "Progression on treatment with a CDK 4/6 inhibitor", check: "semantic" }],
      RECORD,
    );

    // The deterministic guards corrected the model: palbociclib was never received.
    expect(profile.therapies.find((t) => t.name === "palbociclib")?.status).toBe("never_received");
    expect(results[0].evidenceVerified).toBe(true);

    const carryingRecord = calls.filter((c) => privacyGuard.containsPrivateText(c.text));
    expect(carryingRecord.length).toBeGreaterThan(0);
    for (const c of carryingRecord) expect(c.mode).toBe("only_on_device");
    // And it was handed only to the app instance that has no App Check and no credentials.
    for (const c of carryingRecord) expect(c.instance).toBe("device");

    // Nothing was written to the outbound lane, and device entries store no record text.
    expect(ledger.outbound()).toHaveLength(0);
    for (const e of ledger.all()) expect(e.payload).toBeUndefined();
  });

  it("refuses every cloud-capable mode when the prompt carries record text", async () => {
    const { generate, InferenceMode } = await import("../../lib/hybrid");
    const { privacyGuard, LeakError } = await import("../privacy");
    privacyGuard.registerPrivateText(RECORD);

    for (const mode of [InferenceMode.ONLY_IN_CLOUD, InferenceMode.PREFER_IN_CLOUD, InferenceMode.PREFER_ON_DEVICE]) {
      await expect(generate({ mode, prompt: `Explain this: ${RECORD}` })).rejects.toBeInstanceOf(LeakError);
    }
    // The request was stopped before the SDK was ever called.
    expect(calls).toHaveLength(0);
  });

  it("refuses to send an image through a cloud-capable mode", async () => {
    const { generate, InferenceMode } = await import("../../lib/hybrid");
    await expect(
      generate({ mode: InferenceMode.PREFER_ON_DEVICE, prompt: "Read this", image: { mimeType: "image/png", base64: "AAAA" } }),
    ).rejects.toThrow(/ONLY_ON_DEVICE/);
    expect(calls).toHaveLength(0);
  });

  it("sends only public registry text to the cloud, and shows it in full in the ledger", async () => {
    const { generate, InferenceMode } = await import("../../lib/hybrid");
    const { privacyGuard } = await import("../privacy");
    const { ledger } = await import("../ledger");
    const { COMPILE_SYSTEM } = await import("../compileCore");
    privacyGuard.registerPrivateText(RECORD);
    privacyGuard.registerPrivateValue("Jane Okafor");

    respond = () => ({ text: JSON.stringify({ criteria: [] }), source: "in_cloud" });
    await generate({ mode: InferenceMode.ONLY_IN_CLOUD, system: COMPILE_SYSTEM, prompt: `Source text of NCT00000001:\n\n${PUBLIC_CRITERIA}`, schema: { type: "object" } });

    expect(calls).toHaveLength(1);
    expect(calls[0].mode).toBe("only_in_cloud");
    expect(calls[0].instance).toBe("cloud");
    const outbound = ledger.outbound();
    expect(outbound).toHaveLength(1);
    expect(outbound[0].destination).toBe("Gemini (cloud)");
    expect(outbound[0].payload).toContain("Active or untreated brain metastases");
    expect(privacyGuard.containsPrivateText(outbound[0].payload!)).toBe(false);
    expect(outbound[0].payload).not.toMatch(/Okafor|4471-882|September 2026/);
  });
});

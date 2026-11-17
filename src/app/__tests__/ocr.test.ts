import { afterEach, describe, expect, it, vi } from "vitest";

// An engine that never finishes starting, as seen when its language data cannot be loaded.
vi.mock("tesseract.js", () => ({
  OEM: { LSTM_ONLY: 1 },
  createWorker: () => new Promise(() => {}),
}));

vi.stubGlobal("location", { href: "https://oneway.example/" });

describe("quick reading", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives up after the time limit, so the careful reading is never held back, and is not tried again", async () => {
    vi.useFakeTimers();
    const { recognizeText, QUICK_READING_TIMEOUT_MS } = await import("../ocr");
    const first = recognizeText("data:image/png;base64,AAAA").then(
      () => "answered",
      (e: Error) => e.message,
    );
    await vi.advanceTimersByTimeAsync(QUICK_READING_TIMEOUT_MS);
    expect(await first).toMatch(/did not answer in time/);
    await expect(recognizeText("data:image/png;base64,AAAA")).rejects.toThrow(/not available in this visit/);
  });
});

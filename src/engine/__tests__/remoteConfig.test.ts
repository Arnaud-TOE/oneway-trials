import { describe, expect, it } from "vitest";
import { DEFAULT_MODELS, readModels, validModelName } from "../../lib/remoteConfig";

describe("cloud model names from Remote Config", () => {
  it("accepts Gemini model names only", () => {
    expect(validModelName("gemini-3.5-flash-lite")).toBe(true);
    expect(validModelName("gemini-4-hydrogen")).toBe(true);
    expect(validModelName("")).toBe(false);
    expect(validModelName("gpt-4")).toBe(false);
    expect(validModelName("gemini-3.5 flash")).toBe(false);
    expect(validModelName("gemini-../../projects/x")).toBe(false);
  });

  it("falls back to the measured defaults for anything malformed", () => {
    expect(DEFAULT_MODELS.fallbackModel).toBe("");
    expect(readModels("not a model", "also not", true)).toEqual({ ...DEFAULT_MODELS, from: "remote" });
    expect(readModels("gemini-4-hydrogen", "gemini-3.8-flash", true)).toEqual({
      model: "gemini-4-hydrogen",
      fallbackModel: "gemini-3.8-flash",
      from: "remote",
    });
  });

  it("lets the console switch the fallback off, and never falls back to the same model", () => {
    expect(readModels("gemini-3.5-flash-lite", "", true).fallbackModel).toBe("");
    expect(readModels("gemini-3.5-flash-lite", "none", true).fallbackModel).toBe("");
    expect(readModels("gemini-3.8-flash", "gemini-3.8-flash", true).fallbackModel).toBe("");
  });
});

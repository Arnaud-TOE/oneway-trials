import { describe, expect, it } from "vitest";
import { COMPILE_SYSTEM } from "../../engine/compileCore";
import { ALTERNATIVES_SYSTEM, askFromOptions, sanitizeWithAlternatives } from "../alternatives";

/** The experimental compiler that was measured on the bench and not adopted. */
describe("experiment: alternatives asked one by one", () => {
  const source = "Inclusion Criteria:\n* score of 1+ or score of 2+ with a negative FISH\n* Measurable disease";

  it("builds the question from the list of alternatives", () => {
    const out = sanitizeWithAlternatives(
      [
        {
          kind: "inclusion",
          text: "score of 1+ or score of 2+ with a negative FISH",
          check: "semantic",
          field: "none",
          ask: "Does this patient have a score of 1+ or 2+ with a negative FISH?",
          options: ["The patient has a score of 1+.", "The patient has a score of 2+ together with a negative FISH test."],
        },
        {
          kind: "inclusion",
          text: "Measurable disease",
          check: "semantic",
          field: "none",
          ask: "Does this patient have measurable disease?",
          options: ["The patient has measurable disease."],
        },
      ],
      source,
    );
    expect(out[0].ask).toBe(
      "Is at least one of these statements true: (a) The patient has a score of 1+; (b) The patient has a score of 2+ together with a negative FISH test? Answer yes if any one of them is true.",
    );
    // A single option is not an alternative: the compiler's own question is kept.
    expect(out[1].ask).toBe("Does this patient have measurable disease?");
  });

  it("ignores lists that are not plain alternatives", () => {
    expect(askFromOptions(["The patient has asthma.", "The patient has asthma"])).toBeUndefined();
    expect(askFromOptions(["The patient has asthma", "See https://example.com"])).toBeUndefined();
    expect(askFromOptions(["The patient has asthma", 7])).toBeUndefined();
    expect(askFromOptions(Array.from({ length: 7 }, (_, i) => `The patient has condition number ${i}`))).toBeUndefined();
    expect(askFromOptions("The patient has asthma")).toBeUndefined();
  });

  it("is the product's prompt plus one rule, and leaves the product's prompt untouched", () => {
    expect(ALTERNATIVES_SYSTEM).toContain('"options" is required on every item');
    expect(ALTERNATIVES_SYSTEM.length).toBeGreaterThan(COMPILE_SYSTEM.length);
    expect(COMPILE_SYSTEM).not.toContain("options");
  });
});

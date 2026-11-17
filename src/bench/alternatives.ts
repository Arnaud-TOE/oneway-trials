import { cleanAsk, COMPILE_SCHEMA, COMPILE_SYSTEM, sanitizeCompiled } from "../engine/compileCore";
import type { CompiledCriterion } from "../engine/types";

/**
 * An experiment that was measured and NOT adopted. Kept here, outside the
 * product, so the measurement can be reproduced.
 *
 * The idea. On a real trial, "score of 1+ or score of 2+ with a negative FISH"
 * was asked as one sentence, and a model read the FISH test as required in both
 * cases. So the cloud compiler was asked to list the complete alternatives of
 * each criterion one by one, and the question was built from that list:
 * "Is at least one of these statements true: (a) ...; (b) ...?"
 *
 * The result, on the held-out sample (120 pairs, on-device model): 97 answers
 * equal to the physicians' instead of 101, and 7 false blockers instead of 5.
 * The new prompt also reworded two thirds of the other questions. The
 * difference is within run-to-run variation, but nothing in it supports the
 * change, so the product keeps the compiler that was validated.
 */
export const ALTERNATIVES_VERSION = 6;

const OPTIONS_RULE = `- "options" is required on every item. For a "semantic" item, list the complete alternatives, any ONE of which is enough for the quoted text to be TRUE for the patient. Write each as a full plain sentence about the patient ("The patient has ..."), carrying every condition that belongs to that alternative. Keep the names of genes, markers, tests and drugs exactly as the quoted text writes them, abbreviations included. "score of 1 or score of 2 with a negative scan" has two options: "The patient has a score of 1" and "The patient has a score of 2 together with a negative scan". If the text has no alternatives, give exactly one option. For "numeric" and "categorical" items give an empty list.`;

const ANCHOR = "\n- Skip consent";

/** The product's compile prompt, plus the rule that asks for the list of alternatives. */
export const ALTERNATIVES_SYSTEM = COMPILE_SYSTEM.replace(ANCHOR, `\n${OPTIONS_RULE}${ANCHOR}`);

const base = COMPILE_SCHEMA.properties.criteria.items;

export const ALTERNATIVES_SCHEMA = {
  type: "object",
  required: ["criteria"],
  properties: {
    criteria: {
      type: "array",
      items: {
        type: "object",
        required: [...base.required, "options"],
        properties: { ...base.properties, options: { type: "array", items: { type: "string" } } },
      },
    },
  },
};

const LETTERS = "abcdef";
const MAX_BUILT_ASK = 700;

/**
 * Builds the question from the alternatives. Returns nothing when there are no
 * real alternatives, or when the list does not look like plain statements; the
 * compiler's own question is used then.
 */
export function askFromOptions(raw: unknown): string | undefined {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > LETTERS.length) return undefined;
  const options: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return undefined;
    const o = item.replace(/\s+/g, " ").trim().replace(/[.;]+$/, "");
    if (o.length < 8 || o.length > 220 || o.includes("?") || /https?:|www\.|<[a-z/]/i.test(o)) return undefined;
    if (!options.includes(o)) options.push(o);
  }
  if (options.length < 2) return undefined;
  const list = options.map((o, i) => `(${LETTERS[i]}) ${o}`).join("; ");
  return cleanAsk(`Is at least one of these statements true: ${list}? Answer yes if any one of them is true.`, MAX_BUILT_ASK);
}

/** The product's integrity checks, with the question rebuilt from the alternatives where there are some. */
export function sanitizeWithAlternatives(raw: unknown, sourceText: string): CompiledCriterion[] {
  const list = Array.isArray(raw) ? raw : [];
  const built = new Map<string, string>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const ask = askFromOptions(r.options);
    if (ask && typeof r.text === "string") built.set(r.text.trim(), ask);
  }
  return sanitizeCompiled(list, sourceText).map((c) => (built.has(c.text) ? { ...c, ask: built.get(c.text) } : c));
}

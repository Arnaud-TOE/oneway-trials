import { RULE_FIELDS, type CompiledCriterion, type Operator, type RuleField } from "./types";

/** Bump when the compile prompt or schema changes, so old cache entries are ignored. */
export const COMPILER_VERSION = 3;

/**
 * How the cloud model must write the plain question the on-device model will be
 * asked. Shared with the evaluation bench, so both use exactly the same wording.
 */
export const ASK_GUIDE = `the same criterion as ONE short yes/no question about the patient, in plain everyday words, that a small model can answer from a medical record. "yes" must mean the quoted text is TRUE for the patient.
  - If the text lists alternatives, write: "Does this patient have at least one of these: (a) ..., (b) ...? Answer yes if any one of them applies."
  - Spell out abbreviations. Replace protocol wording such as "prior to randomization" or "before the first dose" with "during the last N days".
  - Never add a condition that is not in the quoted text, and never drop one.`;

export const COMPILE_SYSTEM = `You convert the public eligibility text of a clinical trial into a list of atomic criteria.

Rules:
- One item per atomic condition. Split lists such as "creatinine <= 1.5 mg/dL, platelets >= 100" into separate items.
- "text" MUST be an exact, word-for-word quote copied from the source text. Never rephrase, never merge.
- "kind" is "inclusion" or "exclusion", from the section the text is in.
- Use check "numeric" ONLY for a direct numeric threshold on one of these fields: age (years), ecog, ${RULE_FIELDS.filter(
  (f) => !["age", "sex", "ecog", "pregnant"].includes(f),
).join(", ")}. Give operator, value and unit. Thresholds relative to a normal range (such as "1.5 x ULN") are NOT numeric: use "semantic".
- Use check "categorical" ONLY for field "sex" (category "female" or "male") or field "pregnant" (category "yes").
- Everything else is check "semantic" with field "none".
- "ask" is required on every item. For "numeric" and "categorical" items set it to an empty string.
- For every "semantic" item write "ask": ${ASK_GUIDE}
- Skip consent, contraception and "willing to comply" items.
- At most 30 items, most decisive first.`;

export const COMPILE_SCHEMA = {
  type: "object",
  required: ["criteria"],
  properties: {
    criteria: {
      type: "array",
      items: {
        type: "object",
        required: ["kind", "text", "check", "field", "ask"],
        properties: {
          kind: { type: "string", enum: ["inclusion", "exclusion"] },
          text: { type: "string" },
          ask: { type: "string" },
          check: { type: "string", enum: ["numeric", "categorical", "semantic"] },
          field: { type: "string", enum: ["none", ...RULE_FIELDS] },
          operator: { type: "string", enum: [">=", "<=", ">", "<", "="] },
          value: { type: "number" },
          unit: { type: "string" },
          category: { type: "string" },
        },
      },
    },
  },
} as const;

function squash(text: string): string {
  return text
    .toLowerCase()
    .replace(/\\([<>=])/g, "$1")
    .replace(/[≥]/g, ">=")
    .replace(/[≤]/g, "<=")
    .replace(/[*•·]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when `quote` appears word for word in the public source text. */
export function isVerbatim(quote: string, source: string): boolean {
  const q = squash(quote).replace(/^[\s.,;:-]+|[\s.,;:-]+$/g, "");
  return q.length >= 3 && squash(source).includes(q);
}

const OPERATORS: Operator[] = [">=", "<=", ">", "<", "="];

/**
 * A sex rule is only trusted when the quoted text names that one sex and not the
 * other. Measured on the evaluation bench: "Male and non-pregnant females aged
 * 18 to 60" was compiled as "sex = male", and plain code then ruled a woman out.
 */
export function namesOnlySex(text: string, category: string): boolean {
  const male = /\b(male|males|man|men|boy|boys)\b/i.test(text);
  const female = /\b(female|females|woman|women|girl|girls)\b/i.test(text);
  return category === "male" ? male && !female : female && !male;
}

/**
 * Accepts a cloud-written question only if it looks like one plain question.
 * Unlike `text` it cannot be checked word for word against the source, so it is
 * kept short, free of links, and is only ever used as a prompt for the model.
 */
export function cleanAsk(raw: unknown, maxLength = 420): string | undefined {
  if (typeof raw !== "string") return undefined;
  const q = raw.replace(/\s+/g, " ").trim();
  if (q.length < 12 || q.length > maxLength) return undefined;
  if (!q.includes("?")) return undefined;
  if (/https?:|www\.|<[a-z/]/i.test(q)) return undefined;
  return q;
}

/**
 * Validates compiled criteria, whether they come straight from the model or from
 * the shared cache. Anything not quoted word for word from the public source is
 * dropped, and any numeric rule whose threshold does not appear in its own quote
 * is downgraded to a semantic criterion. A tampered cache entry therefore cannot
 * introduce text or thresholds that the registry does not contain.
 */
export function sanitizeCompiled(raw: unknown, sourceText: string): CompiledCriterion[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: CompiledCriterion[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const text = typeof r.text === "string" ? r.text.trim() : "";
    if (!text || !isVerbatim(text, sourceText)) continue;
    const key = squash(text);
    if (seen.has(key)) continue;
    seen.add(key);

    const kind = r.kind === "exclusion" ? "exclusion" : "inclusion";
    const ask = cleanAsk(r.ask);
    const base: CompiledCriterion = { id: `c${out.length + 1}`, kind, text, check: "semantic", ...(ask ? { ask } : {}) };
    const field = (RULE_FIELDS as readonly string[]).includes(String(r.field)) ? (r.field as RuleField) : undefined;

    if (r.check === "numeric" && field && field !== "sex" && field !== "pregnant") {
      const value = typeof r.value === "number" && Number.isFinite(r.value) ? r.value : undefined;
      const operator = OPERATORS.includes(r.operator as Operator) ? (r.operator as Operator) : undefined;
      const valueInText = value !== undefined && squash(text).includes(String(value));
      if (value !== undefined && operator && valueInText) {
        out.push({ ...base, check: "numeric", field, operator, value, unit: typeof r.unit === "string" ? r.unit : "" });
        continue;
      }
    }
    if (r.check === "categorical" && (field === "sex" || field === "pregnant") && typeof r.category === "string") {
      const category = r.category.toLowerCase().trim();
      const valid =
        field === "sex" ? (category === "female" || category === "male") && namesOnlySex(text, category) : category === "yes" || category === "no";
      if (valid) {
        out.push({ ...base, check: "categorical", field, category });
        continue;
      }
    }
    out.push(base);
    if (out.length >= 30) break;
  }
  return out;
}

/** Hex SHA-256, first 16 characters. Ties a cache entry to the exact source text. */
export async function hashText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

export async function cacheKey(nctId: string, criteriaText: string): Promise<string> {
  return `${nctId}_${await hashText(criteriaText)}_v${COMPILER_VERSION}`;
}

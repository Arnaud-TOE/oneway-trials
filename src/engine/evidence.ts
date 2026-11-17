import type { Therapy } from "./types";

/**
 * Checks that guard against the two failure modes measured in the risk test:
 * invented quotes, and negated treatments read as received.
 */

/** Lowercase, with quote marks and ALL whitespace removed, so line breaks and spacing never matter. */
function compact(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’“”"'`]/g, "")
    .replace(/\s+/g, "");
}

/**
 * Returns the quote if it appears word for word in the record, otherwise an
 * empty string. A quote that cannot be found is never shown to the person.
 *
 * Case, quote marks, spacing and line breaks are ignored: the model often drops
 * the space after a line break, which must not turn a real quote into a fake
 * one. A quote joined by an ellipsis is accepted when every piece is found.
 */
export function verifyQuote(quote: string, record: string): string {
  const hay = compact(record);
  const pieces = quote
    .split(/\.{3}|…/)
    .map((p) => compact(p).replace(/^[.,;:-]+|[.,;:-]+$/g, ""))
    .filter((p) => p.length > 0);
  if (pieces.length === 0 || pieces.join("").length < 3) return "";
  return pieces.every((p) => hay.includes(p)) ? quote.trim() : "";
}

const NEGATION = /\b(never|no prior|no previous|not received|has not|hasn't|have not|did not|didn't|without|naive|naïve|not on|denies|declined|refused|no history of)\b/i;

function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.;!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Deterministic second look at therapies, in both directions.
 *
 * - If every sentence that mentions a therapy carries a negation before it
 *   ("has never received palbociclib"), the therapy is marked never_received
 *   whatever the model said.
 * - If the model says never_received but no sentence that mentions the therapy
 *   contains any word of negation at all, nothing in the record backs that
 *   claim, and the therapy is marked received. This check is deliberately
 *   cautious: one "not", "no" or "declined" anywhere in such a sentence keeps the
 *   model's answer. Seen in testing: on a letter saying "First-line treatment:
 *   palbociclib plus letrozole from June 2025, stopped in October 2026 for
 *   disease progression", the on-device model put palbociclib under "never
 *   received".
 */
export function applyNegationGuard(therapies: Therapy[], record: string): Therapy[] {
  const all = sentences(record);
  return therapies.map((t) => {
    const name = t.name.toLowerCase().trim();
    if (!name) return t;
    const mentions = all.filter((s) => s.toLowerCase().includes(name));
    if (mentions.length === 0) return t;
    const negatedBefore = (s: string) => NEGATION.test(s.slice(0, s.toLowerCase().indexOf(name)));
    if (mentions.every(negatedBefore)) return { ...t, status: "never_received" as const };
    // Whole sentences here, up to a full stop: "Palbociclib was offered; she declined." stays one.
    const wholeMentions = wholeSentences(record).filter((s) => s.toLowerCase().includes(name));
    if (t.status === "never_received" && !wholeMentions.some((s) => ANY_NEGATION.test(s))) {
      return { ...t, status: "received" as const };
    }
    return t;
  });
}

function wholeSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Any word that could negate or cancel a treatment, wherever it stands in the sentence. */
const ANY_NEGATION = /\b(?:not|never|no|none|without|declined|refused|withheld|deferred|denies|naive|naïve|cancel(?:l)?ed)\b|n't\b/i;

/** An exclusion about a cancer other than the one being treated: "history of another primary malignancy". */
const ANOTHER_CANCER =
  /\b(?:another|other|second|additional|different)\s+(?:\w+\s+){0,2}(?:malignan\w*|cancers?|tumou?rs?|neoplas\w*|carcinomas?)\b/i;

export function isAboutAnotherCancer(criterionText: string): boolean {
  return ANOTHER_CANCER.test(criterionText);
}

const CANCER_WORD =
  /\b(?:\w*carcinomas?|cancers?|malignan\w*|tumou?rs?|neoplas\w*|lymphomas?|leuka?emias?|melanomas?|sarcomas?|myelomas?|gliomas?|\w+blastomas?|mesotheliomas?|seminomas?|hodgkin\w*|dcis|cll|aml|mds)\b/gi;

/** Words of a diagnosis that say nothing about which cancer it is. */
const GENERIC =
  /^(?:\w*carcinomas?|cancers?|malignan\w*|tumou?rs?|neoplas\w*|invasive|metastatic|advanced|stage|recurrent|recurrence|primary|positive|negative|receptor|hormone|type|grade|early|local|locally|unresectable|malignant|cells?|small|non|with|from|right|left|bilateral|the|and|disease)$/i;

/**
 * True when a quote offered as proof of "another cancer" only names the
 * patient's own cancer, or names no cancer at all.
 *
 * Seen while recording the built-in example: for "History of another primary
 * malignancy" the on-device model answered yes, quoting the patient's own
 * "invasive lobular carcinoma of the right breast"; for "another malignancy
 * within 3 years" it quoted "Metastatic recurrence to bone". Each cancer named in
 * the quote is checked: if words of the patient's own diagnosis stand next to it
 * (breast, lung, lobular…), it is that diagnosis.
 */
export function quoteNamesOnlyOwnCancer(quote: string, ownDiagnosis: string): boolean {
  const own = new Set(
    (ownDiagnosis.toLowerCase().match(/[a-z][a-z-]+/g) ?? []).filter((w) => w.length >= 4 && !GENERIC.test(w)),
  );
  if (own.size === 0) return false;
  const words = quote.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? [];
  const mentions: number[] = [];
  words.forEach((w, i) => {
    CANCER_WORD.lastIndex = 0;
    if (CANCER_WORD.test(w)) mentions.push(i);
  });
  if (mentions.length === 0) return true;
  return mentions.every((i) => words.slice(Math.max(0, i - 4), i + 6).some((w) => own.has(w)));
}

/**
 * True when a quote says that something is absent: "She has never received
 * chemotherapy, fulvestrant or everolimus", "No brain metastases on MRI".
 * Such a sentence cannot show that an exclusion applies. Seen while recording
 * the built-in example: the on-device model quoted "She has never received
 * chemotherapy…" as proof of "INR > 1.5" and of "prior investigational CDK
 * inhibitors". The pattern is narrow on purpose: "palbociclib, not tolerated"
 * still counts as evidence of palbociclib.
 */
const NEGATIVE_STATEMENT =
  /^(?:no|none|nil)\b|\b(?:never|not|no)\s+(?:\w+\s+){0,2}(?:received|receive|had|have|taken|used|been|history|evidence|known|prior|previous|signs?|symptoms?)\b/i;

export function isNegativeStatement(quote: string): boolean {
  return NEGATIVE_STATEMENT.test(quote.trim());
}

const ANY_NEGATION_WORD = /\b(?:not|never|no|none|without|absence|absent|lack|unable|cannot|free)\b|n't\b/i;

/** True when a criterion or its question is itself worded in the negative ("patients without…"). */
export function isNegativelyWorded(text: string): boolean {
  return ANY_NEGATION_WORD.test(text);
}

/** Words and drug-name endings that mark a phrase as a treatment. */
const TREATMENT_WORD =
  /\b(?:chemo\w*|\w*therap\w*|radiation|radiosurgery|surgery|surgeries|resection|mastectomy|lumpectomy|transplant\w*|insulin|inhibitors?|antibod\w*|vaccines?|hormon\w*|endocrine|steroids?|corticosteroids?|opioids?|anticoagulants?|antibiotics?|aspirin|warfarin|heparin|dialysis|infusions?|injections?|agonists?|antagonists?|blockers?|conjugates?|statins?|car-t)\b/i;
const DRUG_ENDING =
  /\b\w+(?:mab|nib|lib|platin|taxel|rubicin|mycin|parib|lisib|formin|gliptin|gliflozin|glutide|zole|olol|pril|sartan|statin|cillin|floxacin|cycline|trexate|oxifen|estrant|tecan|asone|olone|tide)\b/i;
const VAGUE = /^(?:treatment|treatments|therapy|therapies|medication|medications|medicine|medicines|drugs?)$/i;

/** True when a phrase names a treatment: a treatment word or a drug-like name. */
export function looksLikeTreatment(phrase: string): boolean {
  return TREATMENT_WORD.test(phrase) || DRUG_ENDING.test(phrase);
}

// "has never received", "has not been treated with", "hasn't taken", "never used", "is not on".
const NEVER_VERB =
  /(?:\bnever|\bnot|n't)\s+(?:yet\s+)?(?:been\s+)?(?:previously\s+)?(?:received|receive|taken|take|tried|treated\s+with|started|used|use|had|been\s+on|on|given)\s+/gi;
// "no prior", "without previous", "naive to".
const NO_PRIOR = /\b(?:no|without)\s+(?:prior|previous)\s+|\bna[iï]ve\s+to\s+/gi;
// "chemotherapy-naive".
const NAIVE_SUFFIX = /\b([\w-]+)-na[iï]ve\b/gi;
// Where the named treatments end: the end of the clause.
const CLAUSE_END = /[.;:!?\n(]|\s(?:but|because|although|though|as|since|due|after|before|until|while|which|who|when|during|prior\s+to|for\s+\d|in\s+\d{4})\s/i;
const LEADING = /^(?:any|a|an|the|his|her|their|prior|previous|previously|other|further|additional|systemic)\s+/i;

function namedTreatments(clause: string): string[] {
  const end = clause.search(CLAUSE_END);
  const text = end >= 0 ? clause.slice(0, end) : clause;
  return text
    .split(/,\s*(?:or|and|nor)?\s*|\s+(?:or|and|nor)\s+/i)
    .map((item) => {
      let t = item.trim();
      while (LEADING.test(t)) t = t.replace(LEADING, "");
      return t.replace(/[\s,]+$/, "");
    })
    .filter((t) => t.length >= 3 && t.length <= 60 && t.split(/\s+/).length <= 6 && !VAGUE.test(t) && looksLikeTreatment(t));
}

/**
 * Treatments the record explicitly says the patient never received, found by
 * plain code: "has never received palbociclib, chemotherapy for metastatic
 * disease, or tamoxifen", "has not received chemotherapy or immunotherapy",
 * "never used insulin", "no prior radiotherapy", "chemotherapy-naive".
 *
 * Seen on a clinic letter: the on-device model listed the treatments received
 * and left out "She has never received chemotherapy for metastatic disease".
 * Every name returned here is copied from the record.
 */
export function findNeverReceived(record: string): string[] {
  const text = record.replace(/\s+/g, " ");
  const found: string[] = [];
  const add = (names: string[]) => {
    for (const n of names) if (!found.some((f) => f.toLowerCase() === n.toLowerCase())) found.push(n);
  };
  for (const pattern of [NEVER_VERB, NO_PRIOR]) {
    pattern.lastIndex = 0;
    for (let m = pattern.exec(text); m; m = pattern.exec(text)) add(namedTreatments(text.slice(m.index + m[0].length)));
  }
  NAIVE_SUFFIX.lastIndex = 0;
  for (let m = NAIVE_SUFFIX.exec(text); m; m = NAIVE_SUFFIX.exec(text)) {
    if (!VAGUE.test(m[1]) && looksLikeTreatment(m[1])) add([m[1]]);
  }
  return found;
}

/**
 * Adds the treatments the record says were never received to what the model
 * read. A name already listed is not repeated; between two "never received"
 * names where one contains the other, the more precise one is kept, so
 * "chemotherapy for metastatic disease" is not shortened to "chemotherapy".
 * A "received" entry is never removed here: "received adjuvant chemotherapy"
 * and "never received chemotherapy for metastatic disease" can both be true.
 */
export function mergeNeverReceived(therapies: Therapy[], record: string): Therapy[] {
  const out = [...therapies];
  for (const name of findNeverReceived(record)) {
    const lower = name.toLowerCase();
    if (out.some((t) => t.name.toLowerCase() === lower)) continue;
    const shorter = out.findIndex((t) => t.status === "never_received" && lower.includes(t.name.toLowerCase()));
    if (shorter >= 0) {
      out[shorter] = { name, status: "never_received" };
      continue;
    }
    if (out.some((t) => t.status === "never_received" && t.name.toLowerCase().includes(lower))) continue;
    out.push({ name, status: "never_received" });
  }
  return out;
}

/** Drops therapies the record never mentions at all: they were invented. */
export function dropUnmentioned(therapies: Therapy[], record: string): Therapy[] {
  const hay = record.toLowerCase();
  return therapies.filter((t) => t.name.trim().length > 1 && hay.includes(t.name.toLowerCase().trim()));
}

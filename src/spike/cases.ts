import type { JsonSchema } from "../lib/hybrid";

/** Entirely synthetic patient note, written for this test. Not a real person. */
export const PATIENT_NOTE = `62-year-old woman. Diagnosed 2023 with hormone receptor-positive (ER 90%, PR 40%),
HER2-negative (IHC 1+) invasive ductal carcinoma of the left breast, now metastatic to bone and liver.
First-line treatment: ribociclib plus letrozole for 14 months, stopped in September 2026 for disease progression.
She has never received palbociclib, chemotherapy for metastatic disease, or tamoxifen.
ECOG performance status 1. No known brain metastases (brain MRI August 2026 clear).
Labs from October 2026: creatinine 0.9 mg/dL, total bilirubin 0.7 mg/dL, ANC 2.1 x10^9/L, platelets 210 x10^9/L, hemoglobin 11.8 g/dL.
Other history: type 2 diabetes on metformin, HbA1c 6.9%. Postmenopausal. Non-smoker. Lives near Boston, MA.`;

export const PROFILE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["age", "sex", "primaryCondition", "metastatic", "her2", "ecog", "priorTherapies", "brainMetastases", "creatinineMgDl"],
  properties: {
    age: { type: ["integer", "null"] },
    sex: { type: "string", enum: ["female", "male", "unknown"] },
    primaryCondition: { type: "string" },
    metastatic: { type: "string", enum: ["yes", "no", "unknown"] },
    her2: { type: "string", enum: ["positive", "negative", "unknown"] },
    ecog: { type: ["integer", "null"] },
    priorTherapies: { type: "array", items: { type: "string" } },
    brainMetastases: { type: "string", enum: ["yes", "no", "unknown"] },
    creatinineMgDl: { type: ["number", "null"] },
  },
};

export interface Profile {
  age: number | null;
  sex: string;
  primaryCondition: string;
  metastatic: string;
  her2: string;
  ecog: number | null;
  priorTherapies: string[];
  brainMetastases: string;
  creatinineMgDl: number | null;
}

/** Checks each extracted field against the facts written in the synthetic note. */
export function scoreProfile(p: Profile): { field: string; ok: boolean; got: unknown }[] {
  const therapies = (p.priorTherapies ?? []).join(" ").toLowerCase();
  return [
    { field: "age = 62", ok: p.age === 62, got: p.age },
    { field: "sex = female", ok: p.sex === "female", got: p.sex },
    { field: "condition mentions breast", ok: /breast/i.test(p.primaryCondition ?? ""), got: p.primaryCondition },
    { field: "metastatic = yes", ok: p.metastatic === "yes", got: p.metastatic },
    { field: "HER2 = negative", ok: p.her2 === "negative", got: p.her2 },
    { field: "ECOG = 1", ok: p.ecog === 1, got: p.ecog },
    { field: "therapies include ribociclib", ok: therapies.includes("ribociclib"), got: p.priorTherapies },
    { field: "therapies include letrozole", ok: therapies.includes("letrozole"), got: p.priorTherapies },
    { field: "therapies exclude palbociclib", ok: !therapies.includes("palbociclib"), got: p.priorTherapies },
    { field: "brain metastases = no", ok: p.brainMetastases === "no", got: p.brainMetastases },
    { field: "creatinine = 0.9", ok: p.creatinineMgDl === 0.9, got: p.creatinineMgDl },
  ];
}

export type Verdict = "met" | "not_met" | "unknown";

/** Criteria written in the style of real ClinicalTrials.gov entries, with the answer for the synthetic patient. */
export const CRITERIA: { id: string; kind: "inclusion" | "exclusion"; text: string; expected: Verdict }[] = [
  { id: "c1", kind: "inclusion", text: "Histologically confirmed HR-positive, HER2-negative metastatic breast cancer.", expected: "met" },
  { id: "c2", kind: "inclusion", text: "Progression on treatment with a CDK4/6 inhibitor and hormonal therapy in the metastatic setting.", expected: "met" },
  { id: "c3", kind: "inclusion", text: "ECOG performance status of 0 to 2.", expected: "met" },
  { id: "c4", kind: "inclusion", text: "Age 18 years or older.", expected: "met" },
  { id: "c5", kind: "inclusion", text: "Left ventricular ejection fraction of at least 50% on echocardiogram.", expected: "unknown" },
  { id: "c6", kind: "inclusion", text: "Prior treatment with palbociclib.", expected: "not_met" },
  { id: "c7", kind: "inclusion", text: "Serum creatinine no greater than 1.5 mg/dL.", expected: "met" },
  { id: "c8", kind: "inclusion", text: "Premenopausal status.", expected: "not_met" },
  { id: "c9", kind: "inclusion", text: "Known germline BRCA1 or BRCA2 mutation.", expected: "unknown" },
  { id: "c10", kind: "inclusion", text: "Platelet count of at least 100 x10^9/L.", expected: "met" },
];

export const VERDICT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "evidence"],
  properties: {
    verdict: { type: "string", enum: ["met", "not_met", "unknown"] },
    evidence: { type: "string" },
  },
};

export const VERDICT_SYSTEM = `You check one clinical trial inclusion criterion against a patient note.
Answer "met" only if the note clearly shows the patient satisfies the criterion.
Answer "not_met" only if the note clearly shows the patient does not satisfy it.
Answer "unknown" if the note does not contain the information. Never guess.
"evidence" is a short quote from the note that supports the verdict, or an empty string when unknown.`;

export const PROFILE_SYSTEM = `You extract facts from a patient note into JSON. Only use what the note states.
Use null or "unknown" when the note does not say. List only therapies the patient actually received.`;

/** Real-style public eligibility text for the cloud compile test. */
export const TRIAL_CRITERIA_TEXT = `Inclusion Criteria:
* Histologically confirmed diagnosis of HR+, HER2 negative metastatic breast cancer.
* Progression on treatment with a CDK 4/6 inhibitor and hormonal therapy in the metastatic setting.
* The CDK 4/6 inhibitor must be ribociclib or abemaciclib. Patients on palbociclib are not eligible.
* Age >= 18 years.
* ECOG performance status 0-2.
* Adequate organ function: creatinine <= 1.5 mg/dL, total bilirubin <= 1.5 x ULN, ANC >= 1.5 x10^9/L, platelets >= 100 x10^9/L.
Exclusion Criteria:
* Active or untreated brain metastases.
* Pregnant or breastfeeding.
* Patients on tamoxifen.`;

export const COMPILED_SCHEMA: JsonSchema = {
  type: "object",
  required: ["criteria"],
  properties: {
    criteria: {
      type: "array",
      items: {
        type: "object",
        required: ["kind", "text", "check"],
        properties: {
          kind: { type: "string", enum: ["inclusion", "exclusion"] },
          text: { type: "string" },
          check: { type: "string", enum: ["numeric", "categorical", "semantic"] },
          field: { type: "string" },
          operator: { type: "string", enum: [">=", "<=", ">", "<", "=", "in", "not_in", "none"] },
          value: { type: "string" },
        },
      },
    },
  },
};

/**
 * Built-in fictional patients. Written for this project; they describe no real
 * person. Because they are not private, they can be processed in the cloud on a
 * computer that cannot run the on-device model, which lets anyone try the app.
 */
export interface SamplePatient {
  id: string;
  name: string;
  blurb: string;
  location: string;
  record: string;
}

export const SAMPLES: SamplePatient[] = [
  {
    id: "breast",
    name: "Maria, 62",
    blurb: "Metastatic breast cancer after first-line treatment",
    location: "Boston",
    record: `62-year-old woman. Diagnosed 2023 with hormone receptor-positive (ER 90%, PR 40%),
HER2-negative (IHC 1+) invasive ductal carcinoma of the left breast, now metastatic to bone and liver.
First-line treatment: ribociclib plus letrozole for 14 months, stopped in September 2026 for disease progression.
She has never received palbociclib, chemotherapy for metastatic disease, or tamoxifen.
ECOG performance status 1. No known brain metastases (brain MRI August 2026 clear).
Labs from October 2026: creatinine 0.9 mg/dL, total bilirubin 0.7 mg/dL, ANC 2.1 x10^9/L, platelets 210 x10^9/L, hemoglobin 11.8 g/dL.
Other history: type 2 diabetes on metformin, HbA1c 6.9%. Postmenopausal. Non-smoker. Lives near Boston, MA.`,
  },
  {
    id: "lung",
    name: "David, 58",
    blurb: "Non-small cell lung cancer, EGFR-positive",
    location: "Houston",
    record: `58-year-old man, former smoker (quit 2015). Diagnosed March 2026 with stage IV non-small cell lung cancer,
adenocarcinoma, with an EGFR exon 19 deletion. PD-L1 expression 20%.
Treated with osimertinib since April 2026; CT in October 2026 shows progression in the right lower lobe.
He has not received chemotherapy or immunotherapy. One brain metastasis treated with stereotactic radiosurgery in May 2026, stable since.
ECOG performance status 1. Labs October 2026: creatinine 1.1 mg/dL, hemoglobin 13.4 g/dL, platelets 245 x10^9/L, ANC 3.4 x10^9/L.
Other history: hypertension on amlodipine. No history of interstitial lung disease. Lives in Houston, TX.`,
  },
  {
    id: "diabetes",
    name: "Aisha, 47",
    blurb: "Type 2 diabetes not controlled on two medicines",
    location: "Chicago",
    record: `47-year-old woman with type 2 diabetes diagnosed in 2018. Current medicines: metformin 1000 mg twice daily
and empagliflozin 10 mg daily. She has never used insulin or a GLP-1 receptor agonist.
HbA1c 8.6% in October 2026 (8.4% in June 2026). Body mass index 33. Blood pressure 132/84.
eGFR 88 mL/min/1.73m2, creatinine 0.8 mg/dL. No history of pancreatitis, no diabetic retinopathy on the 2026 eye exam.
Not pregnant and not planning pregnancy. No cardiovascular events. Lives in Chicago, IL.`,
  },
];

// Fetches the public NIH/NCBI TrialGPT criterion annotations as JSON and keeps
// only the fields the bench needs.
//
// Source: https://huggingface.co/datasets/ncbi/TrialGPT-Criterion-Annotations
// Licence: public domain (United States Government Work). Patients are synthetic.
// Cite: Jin et al., "Matching Patients to Clinical Trials with Large Language Models".
//
// Usage: node bench/scripts/fetch-annotations.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://datasets-server.huggingface.co/rows?dataset=ncbi%2FTrialGPT-Criterion-Annotations&config=default&split=train";
const PAGE = 100;

const rows = [];
for (let offset = 0; ; offset += PAGE) {
  const res = await fetch(`${API}&offset=${offset}&length=${PAGE}`);
  if (!res.ok) throw new Error(`rows API answered ${res.status} at offset ${offset}`);
  const json = await res.json();
  const page = Array.isArray(json.rows) ? json.rows : [];
  for (const { row } of page) {
    rows.push({
      id: row.annotation_id,
      patientId: row.patient_id,
      note: row.note,
      trialId: row.trial_id,
      kind: row.criterion_type,
      criterion: row.criterion_text,
      expert: row.expert_eligibility,
      gpt4: row.gpt4_eligibility,
    });
  }
  if (page.length < PAGE) break;
}

mkdirSync(resolve(root, "data"), { recursive: true });
writeFileSync(resolve(root, "data", "annotations.json"), JSON.stringify(rows, null, 1));

const count = (key) => rows.reduce((acc, r) => ((acc[r[key]] = (acc[r[key]] ?? 0) + 1), acc), {});
console.log(`rows: ${rows.length}`);
console.log("kinds:", count("kind"));
console.log("expert labels:", count("expert"));
console.log("patients:", new Set(rows.map((r) => r.patientId)).size, "trials:", new Set(rows.map((r) => r.trialId)).size);

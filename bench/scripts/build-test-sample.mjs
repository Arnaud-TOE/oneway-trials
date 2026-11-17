// Builds a held-out test sample: pairs that were never looked at while the
// judge was being tuned on bench/data/sample.json.
//
// It is a plain random draw from the remaining annotations, so it follows the
// natural share of each answer. All the pairs physicians marked as ruling a trial
// out are already in the tuning sample, so this one contains none of them: it
// measures agreement and false alarms, not missed blockers.
//
// Usage: node bench/scripts/build-test-sample.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rows = JSON.parse(readFileSync(resolve(root, "data", "annotations.json"), "utf8"));
const tuning = new Set(JSON.parse(readFileSync(resolve(root, "data", "sample.json"), "utf8")).map((r) => r.id));

const VERDICT = {
  inclusion: { included: "met", "not included": "not_met", "not enough information": "unknown" },
  exclusion: { excluded: "met", "not excluded": "not_met", "not enough information": "unknown" },
};
const SIZE = 120;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(20261116);

const pool = rows
  .filter((r) => !tuning.has(r.id))
  .filter((r) => typeof r.criterion === "string" && r.criterion.trim().length > 3 && typeof r.note === "string")
  .map((r) => ({ ...r, expertVerdict: VERDICT[r.kind]?.[r.expert] }))
  .filter((r) => r.expertVerdict)
  .sort((a, b) => a.id - b.id);

for (let i = pool.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  [pool[i], pool[j]] = [pool[j], pool[i]];
}

const sample = pool.slice(0, SIZE).map((r) => ({
  id: r.id,
  patientId: r.patientId,
  trialId: r.trialId,
  kind: r.kind,
  criterion: r.criterion.trim(),
  note: r.note.trim(),
  expert: r.expertVerdict,
  gpt4: VERDICT[r.kind]?.[r.gpt4] ?? null,
}));

writeFileSync(resolve(root, "data", "test.json"), JSON.stringify(sample, null, 1));

const tally = sample.reduce((acc, r) => ((acc[`${r.kind}/${r.expert}`] = (acc[`${r.kind}/${r.expert}`] ?? 0) + 1), acc), {});
console.log(`pool of unseen pairs: ${pool.length}`);
console.log(`test sample: ${sample.length}`, tally);
console.log(`overlap with tuning sample: ${sample.filter((r) => tuning.has(r.id)).length}`);
console.log(`patients: ${new Set(sample.map((r) => r.patientId)).size}, trials: ${new Set(sample.map((r) => r.trialId)).size}`);

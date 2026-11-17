// Builds the evaluation sample from the NIH/NCBI physician annotations.
//
// The on-device model takes 10 to 25 seconds per criterion on a CPU, so the
// bench runs on a fixed, seeded sample rather than on all 1,015 pairs. Every
// "blocker" case (the rare, decisive ones) is kept; the rest is sampled per label.
//
// Usage: node bench/scripts/build-sample.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rows = JSON.parse(readFileSync(resolve(root, "data", "annotations.json"), "utf8"));

// Expert label -> "is the criterion text true for the patient?"
const VERDICT = {
  inclusion: { included: "met", "not included": "not_met", "not enough information": "unknown" },
  exclusion: { excluded: "met", "not excluded": "not_met", "not enough information": "unknown" },
};

// How many to take per (kind, expert verdict). "all" keeps every case.
const QUOTA = {
  "inclusion/not_met": "all", // blocker
  "exclusion/met": "all", // blocker
  "inclusion/met": 30,
  "inclusion/unknown": 20,
  "exclusion/not_met": 25,
  "exclusion/unknown": 12,
};

// Small deterministic generator, so the sample is the same on every machine.
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
const random = mulberry32(20261115);
function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const usable = rows
  .filter((r) => typeof r.criterion === "string" && r.criterion.trim().length > 3 && typeof r.note === "string")
  .map((r) => ({ ...r, expertVerdict: VERDICT[r.kind]?.[r.expert] }))
  .filter((r) => r.expertVerdict); // drops "not applicable"

const groups = {};
for (const r of usable) (groups[`${r.kind}/${r.expertVerdict}`] ??= []).push(r);

const picked = [];
for (const [key, quota] of Object.entries(QUOTA)) {
  const pool = shuffle((groups[key] ?? []).sort((a, b) => a.id - b.id));
  picked.push(...(quota === "all" ? pool : pool.slice(0, quota)));
}

const sample = shuffle(picked.sort((a, b) => a.id - b.id)).map((r) => ({
  id: r.id,
  patientId: r.patientId,
  trialId: r.trialId,
  kind: r.kind,
  criterion: r.criterion.trim(),
  note: r.note.trim(),
  expert: r.expertVerdict,
  gpt4: VERDICT[r.kind]?.[r.gpt4] ?? null,
}));

writeFileSync(resolve(root, "data", "sample.json"), JSON.stringify(sample, null, 1));

const tally = sample.reduce((acc, r) => ((acc[`${r.kind}/${r.expert}`] = (acc[`${r.kind}/${r.expert}`] ?? 0) + 1), acc), {});
console.log(`usable pairs: ${usable.length} of ${rows.length}`);
console.log(`sample: ${sample.length}`, tally);
console.log(`patients in sample: ${new Set(sample.map((r) => r.patientId)).size}, trials: ${new Set(sample.map((r) => r.trialId)).size}`);

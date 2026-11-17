// Replays decision policies for exclusion criteria over the raw answers recorded
// by the "v2" bench run, without calling the model again.
//
// Question studied: for an exclusion criterion, does the model's choice between
// "no" and "unknown" carry information, or should the app only distinguish
// "evidence found in the record" from "no evidence found"?
//
// Usage: node bench/scripts/simulate-exclusion-policy.mjs
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const data = JSON.parse(readFileSync(resolve(project, ".spike", "bench.json"), "utf8"));
const sample = JSON.parse(readFileSync(resolve(project, "bench", "data", "sample.json"), "utf8"));
const all = JSON.parse(readFileSync(resolve(project, "bench", "data", "annotations.json"), "utf8"));
const byId = Object.fromEntries(sample.map((x) => [x.id, x]));

function combine(kind, parts) {
  if (parts.length === 0) return "unknown";
  if (kind === "inclusion") {
    if (parts.includes("not_met")) return "not_met";
    return parts.every((p) => p === "met") ? "met" : "unknown";
  }
  if (parts.includes("met")) return "met";
  return parts.every((p) => p === "not_met") ? "not_met" : "unknown";
}

// Policy A (as run): yes+quote -> true, "no" -> false (assumed), "unknown" -> not stated.
// Policy B: yes+quote -> true, anything else -> false (assumed). The model's
// "no" versus "unknown" is ignored for exclusion criteria.
// Policy C (adopted): as B, except that a "yes" the model could not quote stays
// "not stated". The model thinks the condition applies, so calling it "no sign"
// would be wrong.
function decide(kind, atom, policy) {
  if (atom.by === "rules" || kind === "inclusion") return atom.verdict;
  if (atom.verdict === "met") return "met";
  if (policy === "B") return "not_met";
  if (policy === "C") return atom.answer === "yes" ? "unknown" : "not_met";
  return atom.verdict;
}

const isBlocker = (k, v) => (k === "inclusion" && v === "not_met") || (k === "exclusion" && v === "met");
const isClear = (k, v) => (k === "inclusion" && v === "met") || (k === "exclusion" && v === "not_met");

function run(policy) {
  const rows = [];
  for (const [id, out] of Object.entries(data.runs.v2)) {
    const it = byId[id];
    if (!it || out.error) continue;
    rows.push({ kind: it.kind, expert: it.expert, ours: combine(it.kind, (out.atoms ?? []).map((a) => decide(it.kind, a, policy))) });
  }
  return rows;
}

function metrics(rows) {
  const m = { n: rows.length, exact: 0, decisive: 0, decisiveCorrect: 0, falseBlockers: 0, missedBlockers: 0, blockersFound: 0, expertBlockers: 0, perClass: {} };
  for (const r of rows) {
    const key = `${r.kind}/${r.expert}`;
    const c = (m.perClass[key] ??= { n: 0, ok: 0 });
    c.n++;
    if (r.ours === r.expert) {
      m.exact++;
      c.ok++;
    }
    if (r.ours !== "unknown") {
      m.decisive++;
      if (r.ours === r.expert) m.decisiveCorrect++;
    }
    if (isBlocker(r.kind, r.expert)) {
      m.expertBlockers++;
      if (isBlocker(r.kind, r.ours)) m.blockersFound++;
      if (isClear(r.kind, r.ours)) m.missedBlockers++;
    } else if (isBlocker(r.kind, r.ours)) m.falseBlockers++;
  }
  return m;
}

// Share of each (kind, answer) in the full annotated dataset, to estimate what a
// policy would score on the natural mix rather than on the blocker-enriched sample.
const VERDICT = {
  inclusion: { included: "met", "not included": "not_met", "not enough information": "unknown" },
  exclusion: { excluded: "met", "not excluded": "not_met", "not enough information": "unknown" },
};
const natural = {};
let naturalTotal = 0;
for (const r of all) {
  const v = VERDICT[r.kind]?.[r.expert];
  if (!v) continue;
  natural[`${r.kind}/${v}`] = (natural[`${r.kind}/${v}`] ?? 0) + 1;
  naturalTotal++;
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "n/a");
for (const policy of ["A", "B", "C"]) {
  const m = metrics(run(policy));
  let weighted = 0;
  for (const [key, count] of Object.entries(natural)) {
    const c = m.perClass[key];
    weighted += c ? (count * c.ok) / c.n : 0;
  }
  console.log(`\nPolicy ${policy} on the tuning sample (${m.n} pairs)`);
  console.log(`  same answer as physicians: ${pct(m.exact, m.n)}`);
  console.log(`  right when it answers yes/no: ${pct(m.decisiveCorrect, m.decisive)} (${m.decisiveCorrect}/${m.decisive}), answers ${pct(m.decisive, m.n)}`);
  console.log(`  false blockers ${m.falseBlockers} | blockers found ${m.blockersFound}/${m.expertBlockers} | blockers shown as fine ${m.missedBlockers}/${m.expertBlockers}`);
  console.log(`  per answer:`, Object.entries(m.perClass).map(([k, c]) => `${k} ${c.ok}/${c.n}`).join(", "));
  console.log(`  estimated on the dataset's natural mix: ${pct(weighted, naturalTotal)}`);
}

// Does "no" versus "unknown" tell exclusion cases apart?
const tally = {};
for (const [id, out] of Object.entries(data.runs.v2)) {
  const it = byId[id];
  if (!it || it.kind !== "exclusion") continue;
  for (const a of out.atoms ?? []) {
    if (a.by === "rules" || a.verdict === "met") continue;
    const k = `physicians ${it.expert}: model said ${a.answer}`;
    tally[k] = (tally[k] ?? 0) + 1;
  }
}
console.log("\nExclusion conditions with no evidence found, by the model's literal answer:");
for (const k of Object.keys(tally).sort()) console.log(`  ${String(tally[k]).padStart(3)}  ${k}`);

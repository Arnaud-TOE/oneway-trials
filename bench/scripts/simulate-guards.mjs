// Replays a candidate deterministic guard over the answers already recorded by
// the bench, so its effect can be measured without running the model again.
//
// Guard tested here: "the quote must be about the question". A yes/no answer is
// kept only if its quote shares at least one meaningful word with the question.
//
// Usage: node bench/scripts/simulate-guards.mjs
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const data = JSON.parse(readFileSync(resolve(project, ".spike", "bench.json"), "utf8"));
const sample = JSON.parse(readFileSync(resolve(project, "bench", "data", "sample.json"), "utf8"));
const byId = Object.fromEntries(sample.map((x) => [x.id, x]));

const STOP = new Set(
  `patient patients this that have with does from been were will their least these those apply applies answer during
   last past days day months month years year recent recently week weeks time times within before after more less than
   least over under about into which what when where there here they them then also only other others some such each
   both either neither none having being made make take taken given gives show shows shown found present presents
   presenting history known study trial criteria criterion following include includes including defined
   condition conditions disease diseases treatment treatments therapy episode episodes least once twice`.split(/\s+/),
);

function tokens(text) {
  return (text.toLowerCase().match(/[a-z][a-z0-9-]{2,}|\d+(?:\.\d+)?/g) ?? []).filter((w) => !STOP.has(w));
}

function shares(a, b) {
  const tb = tokens(b);
  for (const x of tokens(a)) {
    for (const y of tb) {
      if (x === y) return x;
      // Same word family: a shared stem of five letters ("menopause" / "postmenopausal" is caught below).
      if (x.length >= 5 && y.length >= 5 && (x.startsWith(y.slice(0, 5)) || y.startsWith(x.slice(0, 5)))) return `${x}~${y}`;
      if (x.length >= 7 && y.length >= 7) {
        for (let i = 0; i + 6 <= x.length; i++) if (y.includes(x.slice(i, i + 6))) return `${x}~${y}`;
      }
    }
  }
  return null;
}

function isBlocker(kind, v) {
  return (kind === "inclusion" && v === "not_met") || (kind === "exclusion" && v === "met");
}
function isClear(kind, v) {
  return (kind === "inclusion" && v === "met") || (kind === "exclusion" && v === "not_met");
}

function metrics(rows) {
  const m = { n: rows.length, exact: 0, decisive: 0, decisiveCorrect: 0, falseBlockers: 0, falseClearances: 0, blockersFound: 0, expertBlockers: 0 };
  for (const r of rows) {
    if (r.ours === r.expert) m.exact++;
    if (r.ours !== "unknown") {
      m.decisive++;
      if (r.ours === r.expert) m.decisiveCorrect++;
    }
    if (isBlocker(r.kind, r.expert)) {
      m.expertBlockers++;
      if (isBlocker(r.kind, r.ours)) m.blockersFound++;
      if (isClear(r.kind, r.ours)) m.falseClearances++;
    } else if (isBlocker(r.kind, r.ours)) m.falseBlockers++;
  }
  return m;
}

function line(label, m) {
  const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "n/a");
  return `${label.padEnd(34)} exact ${pct(m.exact, m.n).padStart(6)} | right when yes/no ${pct(m.decisiveCorrect, m.decisive).padStart(6)} (${m.decisiveCorrect}/${m.decisive}) | false blockers ${m.falseBlockers} | false clearances ${m.falseClearances} | blockers found ${m.blockersFound}/${m.expertBlockers}`;
}

for (const variant of ["plain", "raw"]) {
  const before = [];
  const after = [];
  const dropped = [];
  for (const [id, out] of Object.entries(data.runs[variant])) {
    const it = byId[id];
    if (!it || out.error) continue;
    before.push({ kind: it.kind, expert: it.expert, ours: out.ours });
    let ours = out.ours;
    if (ours !== "unknown") {
      const question = `${variant === "plain" ? (data.asks[id] ?? "") : ""} ${it.criterion}`;
      const hit = shares(out.evidence, question);
      if (!hit) {
        dropped.push({ id, was: out.ours, expert: it.expert, correct: out.ours === it.expert, quote: out.evidence.slice(0, 70) });
        ours = "unknown";
      }
    }
    after.push({ kind: it.kind, expert: it.expert, ours });
  }
  console.log(`\n== ${variant} ==`);
  console.log(line("recorded", metrics(before)));
  console.log(line("with quote-relevance guard", metrics(after)));
  console.log(`answers turned into "not stated": ${dropped.length} (${dropped.filter((d) => d.correct).length} were correct, ${dropped.filter((d) => !d.correct).length} were wrong)`);
  for (const d of dropped) console.log(`  #${d.id} ${d.correct ? "LOST" : "fixed"} was ${d.was}, physicians ${d.expert} | ${d.quote}`);
}

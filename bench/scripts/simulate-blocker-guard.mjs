// Replays one candidate guard over recorded answers, on both samples.
//
// Guard: an exclusion criterion may only rule a trial out if the quoted words
// share at least one meaningful word with the criterion. Elsewhere this kind of
// check cost far more correct answers than it fixed (see simulate-guards.mjs);
// here it is tried only on the rare, costly "this rules the trial out" answers.
//
// Usage: node bench/scripts/simulate-blocker-guard.mjs
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const STOP = new Set(
  `patient patients this that have with does from been were will their least these those apply applies answer during
   last past days day months month years year recent recently week weeks time times within before after more less than
   over under about into which what when where there here they them then also only other others some such each both
   either neither none having being made make take taken given gives show shows shown found present presents presenting
   history known study trial criteria criterion following include includes including defined condition conditions
   disease diseases treatment treatments therapy need needs due who has had are was the and for not any all`.split(/\s+/),
);

function tokens(text) {
  return (text.toLowerCase().match(/[a-z][a-z0-9-]{2,}|\d+(?:\.\d+)?/g) ?? []).filter((w) => !STOP.has(w));
}

export function related(quote, criterion) {
  const tb = tokens(criterion);
  for (const x of tokens(quote)) {
    for (const y of tb) {
      if (x === y) return true;
      if (x.length >= 5 && y.length >= 5 && (x.startsWith(y.slice(0, 5)) || y.startsWith(x.slice(0, 5)))) return true;
      if (x.length >= 7 && y.length >= 7) {
        for (let i = 0; i + 6 <= x.length; i++) if (y.includes(x.slice(i, i + 6))) return true;
      }
    }
  }
  return false;
}

for (const [label, results, sampleFile] of [
  ["tuning sample", "bench.json", "sample.json"],
  ["held-out sample", "benchtest.json", "test.json"],
]) {
  const path = resolve(project, ".spike", results);
  if (!existsSync(path)) continue;
  const data = JSON.parse(readFileSync(path, "utf8"));
  const sample = JSON.parse(readFileSync(resolve(project, "bench", "data", sampleFile), "utf8"));
  const byId = Object.fromEntries(sample.map((x) => [x.id, x]));
  let kept = 0;
  let keptCorrect = 0;
  let dropped = 0;
  let droppedCorrect = 0;
  console.log(`\n== ${label} ==`);
  for (const [id, out] of Object.entries(data.runs.v2 ?? {})) {
    const it = byId[id];
    if (!it || it.kind !== "exclusion" || out.ours !== "met") continue;
    const question = `${it.criterion} ${data.compiled?.[id]?.map((a) => a.ask ?? "").join(" ") ?? ""}`;
    const ok = related(out.evidence, question);
    const correct = it.expert === "met";
    if (ok) {
      kept++;
      if (correct) keptCorrect++;
    } else {
      dropped++;
      if (correct) droppedCorrect++;
    }
    console.log(`  #${id} ${ok ? "kept   " : "DROPPED"} physicians ${it.expert.padEnd(7)} | ${it.criterion.slice(0, 60).replace(/\n/g, " ")} | quote: ${out.evidence.slice(0, 60)}`);
  }
  console.log(`  exclusion blockers kept: ${kept} (${keptCorrect} right), dropped: ${dropped} (${droppedCorrect} of them were right)`);
}

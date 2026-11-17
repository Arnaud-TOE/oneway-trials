// Turns the bench output (written under .spike/ by the #bench and #bench-test dev
// pages) into bench/RESULTS.md, and keeps a copy of the raw results under
// bench/results/.
//
// Usage: node bench/scripts/report.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, "..", "..");
const read = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null);

const tuning = read(resolve(project, ".spike", "bench.json"));
const heldOut = read(resolve(project, ".spike", "benchtest.json"));
if (!tuning) {
  console.error("No bench output found. Open http://localhost:5173/#bench and run the bench first.");
  process.exit(1);
}
const tuningSample = read(resolve(project, "bench", "data", "sample.json"));
const byId = Object.fromEntries(tuningSample.map((x) => [x.id, x]));

const pct = (part, whole) => (whole === 0 ? "n/a" : `${((100 * part) / whole).toFixed(1)}%`);
const secs = (ms) => (ms == null ? "n/a" : `${(ms / 1000).toFixed(1)} s`);
const isBlocker = (k, v) => (k === "inclusion" && v === "not_met") || (k === "exclusion" && v === "met");
const isClear = (k, v) => (k === "inclusion" && v === "met") || (k === "exclusion" && v === "not_met");

function combine(kind, parts) {
  if (parts.length === 0) return "unknown";
  if (kind === "inclusion") {
    if (parts.includes("not_met")) return "not_met";
    return parts.every((p) => p === "met") ? "met" : "unknown";
  }
  if (parts.includes("met")) return "met";
  return parts.every((p) => p === "not_met") ? "not_met" : "unknown";
}

function metrics(rows) {
  const order = ["met", "not_met", "unknown"];
  const m = {
    n: rows.length,
    exact: 0,
    decisive: 0,
    decisiveCorrect: 0,
    falseBlockers: 0,
    falseClearances: 0,
    blockersFound: 0,
    expertBlockers: 0,
    expertNonBlockers: 0,
    avgMs: null,
    confusion: Object.fromEntries(order.map((e) => [e, Object.fromEntries(order.map((o) => [o, 0]))])),
  };
  for (const r of rows) {
    m.confusion[r.expert][r.ours]++;
    if (r.ours === r.expert) m.exact++;
    if (r.ours !== "unknown") {
      m.decisive++;
      if (r.ours === r.expert) m.decisiveCorrect++;
    }
    if (isBlocker(r.kind, r.expert)) {
      m.expertBlockers++;
      if (isBlocker(r.kind, r.ours)) m.blockersFound++;
      if (isClear(r.kind, r.ours)) m.falseClearances++;
    } else {
      m.expertNonBlockers++;
      if (isBlocker(r.kind, r.ours)) m.falseBlockers++;
    }
  }
  return m;
}

// The tuning run of the current pipeline recorded each model answer. The final
// decision rule for exclusion criteria was chosen afterwards from those answers,
// so its figures on the tuning sample are a replay of that rule over the same
// recorded answers, not a new run. The held-out figures are a real run.
function replayCurrentRule(data) {
  const rows = [];
  for (const [id, out] of Object.entries(data.runs.v2 ?? {})) {
    const it = byId[id];
    if (!it || out.error) continue;
    const parts = (out.atoms ?? []).map((a) => {
      if (a.by === "rules" || it.kind === "inclusion" || a.verdict === "met") return a.verdict;
      return a.answer === "yes" ? "unknown" : "not_met";
    });
    rows.push({ kind: it.kind, expert: it.expert, ours: combine(it.kind, parts) });
  }
  return metrics(rows);
}

function row(label, m) {
  return `| ${label} | ${m.n} | ${pct(m.exact, m.n)} | ${pct(m.decisiveCorrect, m.decisive)} | ${pct(m.decisive, m.n)} | ${m.falseBlockers} of ${m.expertNonBlockers} | ${m.expertBlockers ? `${m.blockersFound} of ${m.expertBlockers}` : "none in sample"} | ${m.expertBlockers ? `${m.falseClearances} of ${m.expertBlockers}` : "none in sample"} | ${secs(m.avgMs)} |`;
}

function confusion(m) {
  const names = { met: "true", not_met: "false", unknown: "not stated" };
  const order = ["met", "not_met", "unknown"];
  const lines = ["| Physicians \\ App | true | false | not stated |", "|---|---|---|---|"];
  for (const e of order) lines.push(`| ${names[e]} | ${order.map((o) => m.confusion[e][o]).join(" | ")} |`);
  return lines.join("\n");
}

const HEAD = `| Variant | Pairs | Same answer as physicians | Correct when it answers yes/no | Answers yes/no | False blockers | Blockers found | Blockers shown as fine | Time per pair |
|---|---|---|---|---|---|---|---|---|`;

const t = tuning.metrics;
const current = replayCurrentRule(tuning);
const chrome = (tuning.userAgent.match(/Chrome\/[\d.]+/) ?? ["Chrome"])[0];
const h = heldOut?.metrics;
const heldOutDone = Boolean(h && h.v2.n === heldOut.sampleSize);
// "v2" is the product on the device. "cloudBase" is the product's path for a
// fictional sample on a browser with no on-device model. "v3" and "cloud" are
// the same two paths with an experimental compiler that was not adopted
// (src/bench/alternatives.ts).
const complete = (key) => Boolean(h?.[key] && h[key].n === heldOut.sampleSize);
const cloudDone = complete("cloudBase");
const experimentDone = complete("v3") && complete("cloud");

// Pairs whose answer differs between two runs of the held-out sample.
function changes(from, to) {
  const out = { better: 0, worse: 0, other: 0, sameQuestion: 0, sameQuestionChanged: 0 };
  const sig = (atoms) => (atoms ?? []).map((a) => `${a.text}||${a.ask ?? ""}`).join("##");
  for (const it of heldOut.items) {
    const a = heldOut.runs[from]?.[it.id];
    const b = heldOut.runs[to]?.[it.id];
    if (!a || !b || a.error || b.error) continue;
    const same = sig(heldOut.compiled?.[it.id]) === sig(heldOut.compiledNow?.[it.id]);
    if (same) out.sameQuestion++;
    if (a.ours === b.ours) continue;
    if (same) out.sameQuestionChanged++;
    if (b.ours === it.expert) out.better++;
    else if (a.ours === it.expert) out.worse++;
    else out.other++;
  }
  return out;
}
const moved = experimentDone ? changes("v2", "v3") : null;

// Criteria whose text mixes "or" with "and" / "with": the case the experiment was aimed at.
const mixesOrAnd = (text) => {
  const t = ` ${text.toLowerCase()} `;
  return t.includes(" or ") && (t.includes(" with ") || t.includes(" and ") || t.includes(" without "));
};
function mixedScore(key) {
  const items = heldOut.items.filter((it) => mixesOrAnd(it.criterion));
  return `${items.filter((it) => heldOut.runs[key]?.[it.id]?.ours === it.expert).length} of ${items.length}`;
}

const md = `# Evaluation results

Measured in ${chrome} on a laptop CPU with no graphics card, using the product's own on-device code path
(Firebase AI Logic, \`ONLY_ON_DEVICE\`). Last updated ${(heldOut ?? tuning).updatedAt.slice(0, 10)}.

## Data

Patient-criterion pairs from the NIH/NCBI **TrialGPT criterion annotations**
(\`ncbi/TrialGPT-Criterion-Annotations\`, public domain, synthetic patients). Each pair is labelled by physicians:
the criterion is true for the patient, false, or the note does not give enough information.

Two fixed, seeded samples of 120 pairs each:

- **Tuning sample** (\`bench/data/sample.json\`). It contains every pair physicians marked as ruling the trial out
  (33), plus a draw of the other answers. The pipeline was adjusted while looking at this sample.
- **Held-out sample** (\`bench/data/test.json\`). A plain random draw from the remaining pairs, never looked at
  during tuning. It follows the natural mix of answers, and so contains no pair that rules a trial out.

## Headline: held-out sample

${
  heldOutDone
    ? `${HEAD}
${row("OneWay on the device (a real record)", h.v2)}
${cloudDone ? `${row("OneWay, cloud path (built-in fictional patients only)", h.cloudBase)}\n` : ""}${row("GPT-4, as published with the dataset", h.gpt4)}

${confusion(h.v2)}

On pairs it had never seen, the app gives the same answer as physicians ${pct(h.v2.exact, h.v2.n)} of the time. GPT-4, which read the
whole note in the cloud, reaches ${pct(h.gpt4.exact, h.gpt4.n)} on the same pairs. The app wrongly flagged ${h.v2.falseBlockers} of ${h.v2.expertNonBlockers} criteria as
ruling the trial out.${
        cloudDone
          ? `

**Cloud path.** A built-in fictional patient opened in a browser with no on-device model is answered by the cloud
model (\`gemini-3.5-flash-lite\`), with the same compiled questions and the same decision rules, several questions per
request. It was measured on the same pairs, grouped by patient, up to 8 questions per request: ${pct(h.cloudBase.exact, h.cloudBase.n)} agreement,
${h.cloudBase.falseBlockers} false blockers, ${secs(h.cloudBase.avgMs)} per pair. A real record never takes this path.`
          : ""
      }`
    : "Not run yet."
}
${
  experimentDone
    ? `
## Measured and not adopted: asking about alternatives one by one

On a real trial, the criterion "score of 1+ or score of 2+ with a negative FISH" was put to a model as one sentence,
and the cloud model, then asked one question per request, answered "no" for a patient with a score of 1+. The experiment (\`src/bench/alternatives.ts\`) asks the
cloud compiler to list the complete alternatives of each criterion, and builds the question from that list:
"Is at least one of these statements true: (a) ...; (b) ...?"

${HEAD}
${row("Product, on the device", h.v2)}
${row("Experiment, on the device", h.v3)}
${cloudDone ? `${row("Product, cloud path", h.cloudBase)}\n` : ""}${row("Experiment, cloud path", h.cloud)}

- On the device, ${moved.better + moved.worse + moved.other} answers changed between the two runs: ${moved.better} became right, ${moved.worse} became wrong, ${moved.other} moved between two
  wrong answers.
- The new prompt did not only touch criteria with alternatives: it reworded the question of ${heldOut.sampleSize - moved.sameQuestion} of the ${heldOut.sampleSize} pairs.
- Run-to-run variation is real: among the ${moved.sameQuestion} pairs whose question stayed word for word the same, ${moved.sameQuestionChanged} still changed answer.
- On the ${heldOut.items.filter((it) => mixesOrAnd(it.criterion)).length} criteria that mix "or" with "and" or "with", which the experiment was aimed at, the product is right on
  ${mixedScore("v2")} on the device${cloudDone ? ` and ${mixedScore("cloudBase")} in the cloud` : ""}; the experiment on ${mixedScore("v3")} and ${mixedScore("cloud")}.

The differences are within run-to-run variation, and none of them favours the change. The product keeps the compiler
it was validated with. On the trial that prompted the experiment, the product's current paths were checked by hand:
the cloud path answers correctly, and the on-device model answered correctly twice and "not stated" once in three
runs, never a wrong "no".
`
    : ""
}

## Tuning sample: what each part of the design adds

${HEAD}
${row("On-device model alone, registry wording", t.raw)}
${row("+ one plain question written by the cloud", t.plain)}
${row("+ cloud splits criteria, code checks age and sex", t.pipeline)}
${row("+ exclusions judged as physicians do (current)", current)}
${row("GPT-4, as published with the dataset", t.gpt4)}

The "current" row replays the final decision rule over the answers recorded in a real run on this sample; the other
rows are real runs. This sample is deliberately rich in pairs that rule a trial out, so its percentages are lower
than on the natural mix and are not comparable with figures published on the full dataset.

### Where the answers fall, current pipeline, tuning sample

${confusion(current)}

## How to read the columns

- **Same answer as physicians:** the app's three-way answer (true, false, not stated) equals the physicians'.
- **Correct when it answers yes/no:** among the pairs where the app gave a yes or a no, how often it was right.
- **False blockers:** the app said a criterion rules the trial out and physicians disagreed. This wrongly hides a trial.
- **Blockers found:** physicians' blockers the app also flagged.
- **Blockers shown as fine:** physicians said a criterion rules the trial out and the app showed it as satisfied, or as
  "nothing in your record suggests this". This is the wrongly reassuring error.

## What the pipeline does

1. The cloud model splits the public criterion into atomic conditions and writes a plain yes/no question for each.
2. Plain code decides age and sex from the profile the on-device model read from the note.
3. The on-device model answers the remaining questions, quoting the note.
4. Decision rules: a "yes" needs words found verbatim in the note. For an inclusion criterion a "no" needs them too.
   For an exclusion criterion, finding no evidence is reported as "nothing in your record suggests this", which is
   how physicians screen exclusions; it is shown as an assumption, not as a verified fact.

## Honest limits

- The decision rule for exclusion criteria was chosen on the tuning sample. Its effect was then checked on the
  held-out sample. The headline on-device figure comes from that first run.
- The held-out sample has since been used a second time, to decide on the experiment above. That decision was to
  change nothing, so the headline figure is not a figure chosen after looking at the sample; but the sample is no
  longer untouched, and a further change should be validated on fresh pairs.
- The on-device model does not always give the same answer twice. One run per variant: differences of a few
  answers out of 120 are not meaningful.
- The cloud path was measured with questions grouped by patient. The product groups them by trial.
- An exclusion the note says too little about is reported as "nothing suggests this" where physicians answer
  "not enough information". This is the most common disagreement left.
- Before this rule the app answered "not stated" to most exclusion criteria. That earlier version was not run on the
  held-out sample, so there is no measured before/after on unseen pairs, only on the tuning sample.
- Ideas that were measured and rejected: requiring the quote to share a word with the question removed 18 correct
  answers to fix 2; applying it only to exclusion blockers removed half of the true blockers.
- This is a measurement, not a guarantee.

Scripts: \`bench/scripts/\`. Raw results: \`bench/results/\`.
Dataset: Jin et al., *Matching Patients to Clinical Trials with Large Language Models*.
`;

mkdirSync(resolve(project, "bench", "results"), { recursive: true });
writeFileSync(resolve(project, "bench", "RESULTS.md"), md);
writeFileSync(resolve(project, "bench", "results", "tuning.json"), JSON.stringify(tuning, null, 1));
if (heldOut) writeFileSync(resolve(project, "bench", "results", "held-out.json"), JSON.stringify(heldOut, null, 1));

console.log(md.split("## Headline: held-out sample")[1].split("## How to read")[0]);

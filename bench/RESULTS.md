# Evaluation results

Measured in Chrome/157.0.0.0 on a laptop CPU with no graphics card, using the product's own on-device code path
(Firebase AI Logic, `ONLY_ON_DEVICE`). Last updated 2026-11-16.

## Data

Patient-criterion pairs from the NIH/NCBI **TrialGPT criterion annotations**
(`ncbi/TrialGPT-Criterion-Annotations`, public domain, synthetic patients). Each pair is labelled by physicians:
the criterion is true for the patient, false, or the note does not give enough information.

Two fixed, seeded samples of 120 pairs each:

- **Tuning sample** (`bench/data/sample.json`). It contains every pair physicians marked as ruling the trial out
  (33), plus a draw of the other answers. The pipeline was adjusted while looking at this sample.
- **Held-out sample** (`bench/data/test.json`). A plain random draw from the remaining pairs, never looked at
  during tuning. It follows the natural mix of answers, and so contains no pair that rules a trial out.

## Headline: held-out sample

| Variant | Pairs | Same answer as physicians | Correct when it answers yes/no | Answers yes/no | False blockers | Blockers found | Blockers shown as fine | Time per pair |
|---|---|---|---|---|---|---|---|---|
| OneWay on the device (a real record) | 120 | 84.2% | 82.8% | 77.5% | 5 of 120 | none in sample | none in sample | 10.8 s |
| OneWay, cloud path (built-in fictional patients only) | 120 | 82.5% | 81.1% | 79.2% | 4 of 120 | none in sample | none in sample | 1.5 s |
| GPT-4, as published with the dataset | 107 | 93.5% | 94.5% | 68.2% | 2 of 107 | none in sample | none in sample | n/a |

| Physicians \ App | true | false | not stated |
|---|---|---|---|
| true | 8 | 0 | 3 |
| false | 2 | 69 | 0 |
| not stated | 4 | 10 | 24 |

On pairs it had never seen, the app gives the same answer as physicians 84.2% of the time. GPT-4, which read the
whole note in the cloud, reaches 93.5% on the same pairs. The app wrongly flagged 5 of 120 criteria as
ruling the trial out.

**Cloud path.** A built-in fictional patient opened in a browser with no on-device model is answered by the cloud
model (`gemini-3.5-flash-lite`), with the same compiled questions and the same decision rules, several questions per
request. It was measured on the same pairs, grouped by patient, up to 8 questions per request: 82.5% agreement,
4 false blockers, 1.5 s per pair. A real record never takes this path.

## Measured and not adopted: asking about alternatives one by one

On a real trial, the criterion "score of 1+ or score of 2+ with a negative FISH" was put to a model as one sentence,
and the cloud model, then asked one question per request, answered "no" for a patient with a score of 1+. The experiment (`src/bench/alternatives.ts`) asks the
cloud compiler to list the complete alternatives of each criterion, and builds the question from that list:
"Is at least one of these statements true: (a) ...; (b) ...?"

| Variant | Pairs | Same answer as physicians | Correct when it answers yes/no | Answers yes/no | False blockers | Blockers found | Blockers shown as fine | Time per pair |
|---|---|---|---|---|---|---|---|---|
| Product, on the device | 120 | 84.2% | 82.8% | 77.5% | 5 of 120 | none in sample | none in sample | 10.8 s |
| Experiment, on the device | 120 | 80.8% | 79.8% | 78.3% | 7 of 120 | none in sample | none in sample | 9.8 s |
| Product, cloud path | 120 | 82.5% | 81.1% | 79.2% | 4 of 120 | none in sample | none in sample | 1.5 s |
| Experiment, cloud path | 120 | 81.7% | 80.9% | 78.3% | 3 of 120 | none in sample | none in sample | 1.7 s |

- On the device, 9 answers changed between the two runs: 2 became right, 6 became wrong, 1 moved between two
  wrong answers.
- The new prompt did not only touch criteria with alternatives: it reworded the question of 80 of the 120 pairs.
- Run-to-run variation is real: among the 40 pairs whose question stayed word for word the same, 1 still changed answer.
- On the 13 criteria that mix "or" with "and" or "with", which the experiment was aimed at, the product is right on
  11 of 13 on the device and 11 of 13 in the cloud; the experiment on 9 of 13 and 10 of 13.

The differences are within run-to-run variation, and none of them favours the change. The product keeps the compiler
it was validated with. On the trial that prompted the experiment, the product's current paths were checked by hand:
the cloud path answers correctly, and the on-device model answered correctly twice and "not stated" once in three
runs, never a wrong "no".


## Tuning sample: what each part of the design adds

| Variant | Pairs | Same answer as physicians | Correct when it answers yes/no | Answers yes/no | False blockers | Blockers found | Blockers shown as fine | Time per pair |
|---|---|---|---|---|---|---|---|---|
| On-device model alone, registry wording | 120 | 46.7% | 83.3% | 25.0% | 3 of 87 | 7 of 33 | 2 of 33 | 13.5 s |
| + one plain question written by the cloud | 120 | 56.7% | 83.3% | 40.0% | 1 of 87 | 13 of 33 | 4 of 33 | 11.5 s |
| + cloud splits criteria, code checks age and sex | 120 | 60.0% | 84.3% | 42.5% | 3 of 87 | 18 of 33 | 3 of 33 | 11.5 s |
| + exclusions judged as physicians do (current) | 120 | 64.2% | 73.8% | 66.7% | 4 of 87 | 18 of 33 | 4 of 33 | n/a |
| GPT-4, as published with the dataset | 114 | 89.5% | 92.9% | 73.7% | 1 of 81 | 28 of 33 | 2 of 33 | n/a |

The "current" row replays the final decision rule over the answers recorded in a real run on this sample; the other
rows are real runs. This sample is deliberately rich in pairs that rule a trial out, so its percentages are lower
than on the natural mix and are not comparable with figures published on the full dataset.

### Where the answers fall, current pipeline, tuning sample

| Physicians \ App | true | false | not stated |
|---|---|---|---|
| true | 27 | 1 | 12 |
| false | 6 | 32 | 10 |
| not stated | 3 | 11 | 18 |

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

Scripts: `bench/scripts/`. Raw results: `bench/results/`.
Dataset: Jin et al., *Matching Patients to Clinical Trials with Large Language Models*.

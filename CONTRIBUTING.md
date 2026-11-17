# Contributing to OneWay

Thanks for helping patients look for clinical trials without giving their medical record away.

## Getting set up

Follow **Run it locally** in the [README](README.md): a Firebase project with AI Logic, App Check and Firestore, a
`.env.local`, `npm install`, `npm run dev`, and Chrome on a desktop computer for the on-device model.

## Before you open a pull request

```bash
npm run typecheck
npm test
npm run build
```

CI runs the same checks on every push, and `npm install` sets up a pre-push hook that runs them locally too.

## Ground rules

These are what the product promises. A change that breaks one is not accepted, however useful.

- **The record never leaves the device.** Every model call goes through `generate()` in
  [`src/lib/hybrid.ts`](src/lib/hybrid.ts). A prompt that contains text from the person's record must use
  `ONLY_ON_DEVICE`. The privacy tripwire and [`leak.test.ts`](src/engine/__tests__/leak.test.ts) enforce it: add a
  test case when you add a call.
- **Nothing is sent before the person approves it.** The registry search sends a condition name and a place, shown
  word for word first. Nothing else about the person goes out.
- **Every outbound request is in the ledger**, with the exact text it carried.
- **A new host needs a reason.** The Content Security Policy in [`firebase.json`](firebase.json) lists every host the
  page may contact. Adding one is a deliberate, reviewed change.
- **No quote, no verdict.** A model answer is shown only with words found verbatim in the record. Plain code decides
  what it can (age, sex, lab thresholds); a guard that changes verdicts needs a test and, if it touches judging, a
  run of the evaluation bench (`bench/`).
- **Never "eligible".** The app prepares a conversation with a doctor; it does not decide who can join a trial.
- **No secrets, no real people.** Configuration lives in `.env.local`, which git ignores. Never commit an App Check
  debug token. Test with fictional patients only; the recorded example drops study-team contacts
  (`scripts/clean-recording.mjs`).
- **Small, focused changes** with a clear commit message are easiest to review.

Please follow our [Code of Conduct](CODE_OF_CONDUCT.md). To report a privacy or security problem, see
[SECURITY.md](SECURITY.md).

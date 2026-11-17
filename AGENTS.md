# Notes for coding agents

OneWay was built with Claude Code and the Firebase Agent Skills plugin (`firebase@firebase`, declared in
`.claude/settings.json`). These rules apply to any agent working in this repository.

## Invariants

- Every model call goes through `generate()` or `generateStream()` in `src/lib/hybrid.ts`. Never call
  `getGenerativeModel` elsewhere.
- Text from the person's record is only ever sent with `InferenceMode.ONLY_ON_DEVICE`, which uses the separate
  Firebase app instance from `getDeviceAi()` (no App Check, no network). `src/engine/__tests__/leak.test.ts` must
  keep passing; extend it for any new call.
- The cloud model's name comes from Remote Config (`src/lib/remoteConfig.ts`); the evaluation was measured with
  `gemini-3.5-flash-lite`. Changing a prompt or the model means running the bench again (`bench/`, see
  `bench/RESULTS.md`), on pairs it has not seen.
- Any new host the page contacts must be added to the Content Security Policy in `firebase.json`, or Chrome blocks it.
- Quotes shown to the person must pass `verifyQuote()` (word for word in the record).
- Never commit `.env.local`, `.env.production.local` or an App Check debug token. Fictional patients only.

## Checks

```bash
npm run typecheck
npm test
npm run build
```

## Firebase skills used

- `firebase-ai-logic-basics`: hybrid inference, App Check, model names through Remote Config.
- `firebase-remote-config-basics`: `remoteconfig.template.json`, deployed with
  `npx firebase deploy --only remoteconfig`.
- `firebase-security-rules-auditor`: review of `firestore.rules` before each change.

// Prepares an exported run for the repository: the built-in recorded example.
// Study-team contacts and site names are dropped (they are public in the
// registry but name real people), then the file is checked for emails.
// Usage: node scripts/clean-recording.mjs .spike/recording.json src/app/recorded/example.json
import { readFileSync, writeFileSync } from "node:fs";

const [, , src, dest] = process.argv;
if (!src || !dest) {
  console.error("Usage: node scripts/clean-recording.mjs <exported.json> <example.json>");
  process.exit(1);
}
const rec = JSON.parse(readFileSync(src, "utf8"));
const strip = (t) => ({
  ...t,
  contacts: [],
  locations: (t.locations ?? []).map(({ city, state, country }) => ({ facility: "", city, state, country })),
});
rec.trials = rec.trials.map((r) => ({ ...r, trial: strip(r.trial) }));
rec.screenedOut = rec.screenedOut.map((s) => ({ ...s, trial: strip(s.trial) }));
rec.observational = rec.observational.map(strip);
const out = JSON.stringify(rec, null, 1);
const emails = out.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
if (emails.length > 0) {
  console.error(`Refused: ${emails.length} email address(es) left, e.g. ${emails[0]}`);
  process.exit(1);
}
writeFileSync(dest, out + "\n");
console.log(`Written ${dest} (${(out.length / 1024).toFixed(1)} KB), no email address.`);

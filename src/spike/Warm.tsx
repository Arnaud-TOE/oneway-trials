import { useEffect, useRef, useState } from "react";
import { SAMPLES } from "../app/samples";
import { compileTrial } from "../engine/compile";
import { buildProfile, extractBasics, NO_DETAILS } from "../engine/profile";
import { isInterventional, prefilter, searchTrials } from "../engine/trials";

/**
 * Development-only page (#warm): prepares the shared cache before judges arrive.
 *
 * For each built-in fictional patient it does what the app does for a visitor:
 * reads the record (in the cloud, as a fictional patient), searches the registry
 * with the same words, keeps the same trials, and compiles each trial's public
 * rules. Rules already in the cache are only read; the others are compiled once
 * and shared. Nothing private is involved: fictional patients and public trials.
 * The report is written to .spike/warm.json.
 */

interface SampleReport {
  patient: string;
  condition: string;
  location: string;
  found: number;
  kept: number;
  fromCache: number;
  compiled: number;
  failed: { nctId: string; error: string }[];
}

interface WarmReport {
  startedAt: string;
  finishedAt?: string;
  seconds?: number;
  samples: SampleReport[];
  error?: string;
}

export function Warm() {
  const [lines, setLines] = useState<string[]>([]);
  const [report, setReport] = useState<WarmReport | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const log = (line: string) => setLines((l) => [...l, `${new Date().toLocaleTimeString()}  ${line}`]);
    const t0 = performance.now();
    const out: WarmReport = { startedAt: new Date().toISOString(), samples: [] };

    // A trial found for two patients is compiled once; the second time it counts as already prepared.
    const seen = new Set<string>();
    void (async () => {
      try {
        for (const sample of SAMPLES) {
          log(`${sample.name}: reading the fictional record…`);
          const basics = await extractBasics(sample.record, "sample");
          const profile = buildProfile(basics, NO_DETAILS, sample.record);
          const r: SampleReport = {
            patient: sample.name,
            condition: profile.searchTerm,
            location: sample.location,
            found: 0,
            kept: 0,
            fromCache: 0,
            compiled: 0,
            failed: [],
          };
          out.samples.push(r);
          const found = await searchTrials({ condition: r.condition, location: r.location, pageSize: 15 });
          const kept = found.filter(isInterventional).filter((t) => prefilter(t, profile).keep);
          r.found = found.length;
          r.kept = kept.length;
          log(`${sample.name}: "${r.condition}" near ${r.location}: ${found.length} found, ${kept.length} kept`);
          for (const trial of kept) {
            try {
              const res = await compileTrial(trial);
              const fresh = res.origin === "cloud" && !seen.has(trial.nctId);
              seen.add(trial.nctId);
              if (fresh) r.compiled++;
              else r.fromCache++;
              log(`  ${trial.nctId}: ${fresh ? "compiled and shared" : "already in the cache"}`);
            } catch (e) {
              const error = e instanceof Error ? e.message.slice(0, 200) : String(e);
              r.failed.push({ nctId: trial.nctId, error });
              log(`  ${trial.nctId}: FAILED ${error}`);
            }
          }
        }
      } catch (e) {
        out.error = e instanceof Error ? e.message : String(e);
        log(`Stopped: ${out.error}`);
      }
      out.finishedAt = new Date().toISOString();
      out.seconds = Math.round((performance.now() - t0) / 1000);
      setReport(out);
      log(`Done in ${out.seconds} s.`);
      try {
        await fetch("/__spike-result?name=warm", { method: "POST", body: JSON.stringify(out, null, 2) });
      } catch {
        // The report is still on the page.
      }
    })();
  }, []);

  return (
    <main style={{ fontFamily: "ui-monospace, monospace", padding: 24, maxWidth: 960 }}>
      <h1 style={{ fontFamily: "system-ui" }}>Warm the shared cache</h1>
      <p style={{ fontFamily: "system-ui" }}>
        Fictional patients only. The report is also written to <code>.spike/warm.json</code>.
      </p>
      <pre id="warm-log" style={{ whiteSpace: "pre-wrap" }}>{lines.join("\n")}</pre>
      {report && (
        <pre id="warm-report" data-done="true" style={{ whiteSpace: "pre-wrap" }}>
          {JSON.stringify(report, null, 2)}
        </pre>
      )}
    </main>
  );
}

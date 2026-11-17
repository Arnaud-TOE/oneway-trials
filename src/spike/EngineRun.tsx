import { useRef, useState } from "react";
import { compileTrial } from "../engine/compile";
import { ledger } from "../engine/ledger";
import { matchTrial, splitByEngine } from "../engine/match";
import { privacyGuard } from "../engine/privacy";
import { extractProfile } from "../engine/profile";
import { isInterventional, prefilter, searchTrials } from "../engine/trials";
import type { Profile, TrialMatch } from "../engine/types";
import { PATIENT_NOTE } from "./cases";

/** Dev-only page: runs the whole engine once on the synthetic patient and real registry data. */

interface Report {
  startedAt: string;
  log: string[];
  profile?: Profile;
  profileMs?: number;
  search?: { returned: number; kept: number; dropped: string[] };
  trials: {
    nctId: string;
    title: string;
    origin: string;
    compileMs: number;
    criteria: number;
    byRules: number;
    byModel: number;
    matchMs: number;
    fit: string;
    counts: TrialMatch["counts"];
    results: { id: string; kind: string; text: string; verdict: string; outcome: string; by: string; evidence: string; verified: boolean }[];
  }[];
  outbound: { destination?: string; label: string; payloadChars: number; leaks: boolean }[];
  deviceCalls: number;
  error?: string;
}

async function save(report: Report) {
  try {
    await fetch("/__spike-result?name=engine", { method: "POST", body: JSON.stringify(report, null, 2) });
  } catch {
    /* dev sink only */
  }
}

export function EngineRun() {
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState("");
  const ref = useRef<Report | null>(null);

  function update(mut: (r: Report) => void, status?: string) {
    const r = ref.current!;
    mut(r);
    if (status) {
      r.log.push(status);
      setBusy(status);
    }
    const leakCheck = ledger.outbound().map((e) => ({
      destination: e.destination,
      label: e.label,
      payloadChars: e.payload?.length ?? 0,
      leaks: e.payload ? privacyGuard.containsPrivateText(e.payload) : false,
    }));
    r.outbound = leakCheck;
    r.deviceCalls = ledger.all().filter((e) => e.lane === "device").length;
    setReport({ ...r });
    void save(r);
  }

  async function run(maxTrials: number) {
    ledger.clear();
    privacyGuard.clear();
    ref.current = { startedAt: new Date().toISOString(), log: [], trials: [], outbound: [], deviceCalls: 0 };
    try {
      update(() => {}, "Reading the record on this device…");
      const t0 = performance.now();
      const profile = await extractProfile(PATIENT_NOTE);
      update((r) => {
        r.profile = profile;
        r.profileMs = Math.round(performance.now() - t0);
      }, `Profile ready. Searching the registry for "${profile.searchTerm}"…`);

      const found = await searchTrials({ condition: profile.searchTerm, location: "Boston", pageSize: 12 });
      const dropped: string[] = [];
      const kept = found.filter((t) => {
        if (!isInterventional(t)) {
          dropped.push(`${t.nctId}: observational`);
          return false;
        }
        const d = prefilter(t, profile);
        if (!d.keep) dropped.push(`${t.nctId}: ${d.reason}`);
        return d.keep;
      });
      update((r) => {
        r.search = { returned: found.length, kept: kept.length, dropped };
      }, `${kept.length} of ${found.length} studies kept after local screening.`);

      for (const trial of kept.slice(0, maxTrials)) {
        update(() => {}, `Compiling ${trial.nctId} in the cloud…`);
        const c0 = performance.now();
        const compiled = await compileTrial(trial);
        const compileMs = Math.round(performance.now() - c0);
        const split = splitByEngine(compiled.criteria, profile);
        update(() => {}, `Matching ${trial.nctId} on this device (${split.decided.length} by rules, ${split.semantic.length} by model)…`);
        const m0 = performance.now();
        const match = await matchTrial(trial, compiled.criteria, profile, PATIENT_NOTE, {
          onProgress: (partial, pending) => setBusy(`Matching ${trial.nctId}: ${partial.results.length} checked, ${pending} to go…`),
        });
        update((r) => {
          r.trials.push({
            nctId: trial.nctId,
            title: trial.title,
            origin: compiled.origin,
            compileMs,
            criteria: compiled.criteria.length,
            byRules: match.results.filter((x) => x.decidedBy === "rules").length,
            byModel: match.results.filter((x) => x.decidedBy !== "rules").length,
            matchMs: Math.round(performance.now() - m0),
            fit: match.fit,
            counts: match.counts,
            results: match.results.map((x) => ({
              id: x.criterion.id,
              kind: x.criterion.kind,
              text: x.criterion.text,
              verdict: x.verdict,
              outcome: x.outcome,
              by: x.decidedBy,
              evidence: x.evidence,
              verified: x.evidenceVerified,
            })),
          });
        }, `${trial.nctId}: ${match.fit}`);
      }
      update(() => {}, "Done.");
    } catch (e) {
      update((r) => {
        r.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      }, "Stopped on an error.");
    }
    setBusy("");
  }

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 980, margin: "0 auto", padding: 16, lineHeight: 1.45 }}>
      <h1 style={{ fontSize: 22 }}>OneWay — full engine run (dev)</h1>
      <p>Synthetic patient, real ClinicalTrials.gov data. Results are saved automatically.</p>
      <div style={{ display: "flex", gap: 8 }}>
        <button disabled={!!busy} onClick={() => run(1)}>Run on 1 trial</button>
        <button disabled={!!busy} onClick={() => run(3)}>Run on 3 trials</button>
      </div>
      {busy && <p role="status"><b>{busy}</b></p>}
      {report?.error && <p style={{ color: "#b00020" }}>{report.error}</p>}
      {report && (
        <pre style={{ fontSize: 12, whiteSpace: "pre-wrap", background: "#f4f4f5", padding: 12, borderRadius: 8 }}>
          {JSON.stringify(
            {
              profileMs: report.profileMs,
              profile: report.profile,
              search: report.search,
              trials: report.trials.map(({ results, ...t }) => ({ ...t, results: results.length })),
              outbound: report.outbound,
              deviceCalls: report.deviceCalls,
            },
            null,
            2,
          )}
        </pre>
      )}
    </main>
  );
}

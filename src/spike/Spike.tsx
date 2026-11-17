import { useEffect, useRef, useState } from "react";
import {
  deviceAvailability,
  generate,
  InferenceMode,
  prepareDeviceModel,
  type DeviceAvailability,
} from "../lib/hybrid";
import { isFirebaseConfigured } from "../lib/firebase";
import {
  COMPILED_SCHEMA,
  CRITERIA,
  PATIENT_NOTE,
  PROFILE_SCHEMA,
  PROFILE_SYSTEM,
  scoreProfile,
  TRIAL_CRITERIA_TEXT,
  VERDICT_SCHEMA,
  VERDICT_SYSTEM,
  type Profile,
  type Verdict,
} from "./cases";

interface Row {
  step: string;
  ok: boolean | null;
  source?: string;
  ms?: number;
  detail: string;
}

interface Report {
  startedAt: string;
  userAgent: string;
  cores: number;
  memoryGb: number | null;
  availabilityText: DeviceAvailability | null;
  availabilityImage: DeviceAvailability | null;
  downloadProgress: number | null;
  rows: Row[];
  summary: Record<string, unknown>;
}

function errorText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

async function save(report: Report): Promise<void> {
  try {
    await fetch("/__spike-result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report, null, 2),
    });
  } catch {
    // The sink only exists on the dev server; ignore elsewhere.
  }
}

export function Spike() {
  const [report, setReport] = useState<Report>(() => ({
    startedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    cores: navigator.hardwareConcurrency,
    memoryGb: (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? null,
    availabilityText: null,
    availabilityImage: null,
    downloadProgress: null,
    rows: [],
    summary: {},
  }));
  const [busy, setBusy] = useState<string | null>(null);
  const ref = useRef(report);
  ref.current = report;

  function update(patch: Partial<Report>) {
    const next = { ...ref.current, ...patch };
    ref.current = next;
    setReport(next);
    void save(next);
  }
  function addRow(row: Row) {
    update({ rows: [...ref.current.rows, row] });
  }
  function summarize(patch: Record<string, unknown>) {
    update({ summary: { ...ref.current.summary, ...patch } });
  }

  async function refreshAvailability() {
    const [t, i] = await Promise.all([deviceAvailability(false), deviceAvailability(true)]);
    update({ availabilityText: t, availabilityImage: i });
  }

  useEffect(() => {
    void refreshAvailability();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runPrepare() {
    setBusy("Preparing the on-device model (first download can take several minutes)…");
    const started = performance.now();
    try {
      await prepareDeviceModel((f) => update({ downloadProgress: Math.round(f * 1000) / 10 }));
      // initializeDeviceModel returns once the download is requested; poll until Chrome reports it ready.
      for (let i = 0; i < 720; i++) {
        const a = await deviceAvailability(false);
        update({ availabilityText: a });
        if (a === "available" || a === "unavailable" || a === "no-api") break;
        await new Promise((r) => setTimeout(r, 5000));
      }
      await refreshAvailability();
      addRow({
        step: "prepare on-device model",
        ok: ref.current.availabilityText === "available",
        ms: Math.round(performance.now() - started),
        detail: `availability: ${ref.current.availabilityText}`,
      });
    } catch (e) {
      addRow({ step: "prepare on-device model", ok: false, detail: errorText(e) });
    }
    setBusy(null);
  }

  async function runDevice() {
    setBusy("Running on-device tests…");
    // Test 1: structured profile extraction, strictly on device.
    try {
      const r = await generate<Profile>({
        mode: InferenceMode.ONLY_ON_DEVICE,
        system: PROFILE_SYSTEM,
        prompt: `Patient note:\n${PATIENT_NOTE}`,
        schema: PROFILE_SCHEMA,
      });
      const checks = scoreProfile(r.data);
      const good = checks.filter((c) => c.ok).length;
      addRow({
        step: "profile extraction (ONLY_ON_DEVICE)",
        ok: good >= checks.length - 1,
        source: r.source,
        ms: r.ms,
        detail: `${good}/${checks.length} fields correct. Wrong: ${
          checks.filter((c) => !c.ok).map((c) => `${c.field} (got ${JSON.stringify(c.got)})`).join("; ") || "none"
        }`,
      });
      summarize({ profileCorrect: good, profileTotal: checks.length, profileMs: r.ms, profile: r.data });
    } catch (e) {
      addRow({ step: "profile extraction (ONLY_ON_DEVICE)", ok: false, detail: errorText(e) });
    }

    // Test 2: one verdict per criterion, strictly on device.
    let correct = 0;
    let done = 0;
    let totalMs = 0;
    const confusions: string[] = [];
    for (const c of CRITERIA) {
      setBusy(`Running on-device tests… criterion ${done + 1}/${CRITERIA.length}`);
      try {
        const r = await generate<{ verdict: Verdict; evidence: string }>({
          mode: InferenceMode.ONLY_ON_DEVICE,
          system: VERDICT_SYSTEM,
          prompt: `Patient note:\n${PATIENT_NOTE}\n\nInclusion criterion:\n${c.text}`,
          schema: VERDICT_SCHEMA,
        });
        const ok = r.data.verdict === c.expected;
        if (ok) correct++;
        else confusions.push(`${c.id}: expected ${c.expected}, got ${r.data.verdict}`);
        totalMs += r.ms;
        done++;
        addRow({
          step: `criterion ${c.id} (ONLY_ON_DEVICE)`,
          ok,
          source: r.source,
          ms: r.ms,
          detail: `"${c.text}" → ${r.data.verdict} (expected ${c.expected}). Evidence: ${r.data.evidence || "—"}`,
        });
      } catch (e) {
        done++;
        addRow({ step: `criterion ${c.id} (ONLY_ON_DEVICE)`, ok: false, detail: errorText(e) });
      }
    }
    summarize({
      criteriaCorrect: correct,
      criteriaTotal: CRITERIA.length,
      criteriaAvgMs: done ? Math.round(totalMs / done) : null,
      criteriaConfusions: confusions,
    });
    setBusy(null);
  }

  async function runCloud() {
    setBusy("Running cloud and fallback tests…");
    // Test 3: compile public criteria into structured rules, strictly in the cloud.
    try {
      const r = await generate<{ criteria: unknown[] }>({
        mode: InferenceMode.ONLY_IN_CLOUD,
        system:
          "You convert public clinical trial eligibility text into atomic, structured criteria. One item per atomic condition.",
        prompt: TRIAL_CRITERIA_TEXT,
        schema: COMPILED_SCHEMA,
      });
      addRow({
        step: "compile public criteria (ONLY_IN_CLOUD)",
        ok: Array.isArray(r.data.criteria) && r.data.criteria.length >= 8,
        source: r.source,
        ms: r.ms,
        detail: `${r.data.criteria?.length ?? 0} atomic criteria. First: ${JSON.stringify(r.data.criteria?.[0])}`,
      });
      summarize({ compiledCount: r.data.criteria?.length ?? 0, compileMs: r.ms, compiled: r.data.criteria });
    } catch (e) {
      addRow({ step: "compile public criteria (ONLY_IN_CLOUD)", ok: false, detail: errorText(e) });
    }

    // Test 4 and 5: the two fallback modes on a public, non-sensitive question.
    for (const mode of [InferenceMode.PREFER_ON_DEVICE, InferenceMode.PREFER_IN_CLOUD]) {
      try {
        const r = await generate<string>({
          mode,
          prompt: "In two plain sentences for a patient, what does 'ECOG performance status' mean?",
        });
        addRow({ step: `explain a public term (${mode})`, ok: r.text.length > 20, source: r.source, ms: r.ms, detail: r.text });
        summarize({ [`${mode}Source`]: r.source, [`${mode}Ms`]: r.ms });
      } catch (e) {
        addRow({ step: `explain a public term (${mode})`, ok: false, detail: errorText(e) });
      }
    }
    setBusy(null);
  }

  const s = report.summary as Record<string, number | string | undefined>;

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 920, margin: "0 auto", padding: 16, lineHeight: 1.45 }}>
      <h1 style={{ fontSize: 22 }}>OneWay — risk test</h1>
      <p>
        This page measures whether Chrome's on-device model is good and fast enough on this computer. Results are saved
        automatically. The patient note used here is synthetic.
      </p>
      {!isFirebaseConfigured && <p style={{ color: "#b00020" }}>Firebase is not configured (.env.local missing).</p>}

      <section style={{ background: "#f4f4f5", padding: 12, borderRadius: 8 }}>
        <div>On-device model (text): <b>{report.availabilityText ?? "…"}</b></div>
        <div>On-device model (text + image): <b>{report.availabilityImage ?? "…"}</b></div>
        <div>CPU threads: {report.cores} · Device memory hint: {report.memoryGb ?? "?"} GB · Online: {String(navigator.onLine)}</div>
        {report.downloadProgress !== null && <div>Download: {report.downloadProgress}%</div>}
      </section>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "16px 0" }}>
        <button disabled={!!busy} onClick={runPrepare}>1. Prepare on-device model</button>
        <button disabled={!!busy} onClick={runDevice}>2. Run on-device tests</button>
        <button disabled={!!busy} onClick={runCloud}>3. Run cloud tests</button>
        <button disabled={!!busy} onClick={refreshAvailability}>Refresh status</button>
      </div>
      {busy && <p role="status"><b>{busy}</b></p>}

      {(s.profileTotal || s.criteriaTotal || s.compiledCount) && (
        <section style={{ border: "1px solid #d4d4d8", padding: 12, borderRadius: 8, marginBottom: 16 }}>
          <b>Summary</b>
          {s.profileTotal && <div>Profile extraction: {s.profileCorrect}/{s.profileTotal} fields, {s.profileMs} ms</div>}
          {s.criteriaTotal && <div>Criteria verdicts: {s.criteriaCorrect}/{s.criteriaTotal} correct, average {s.criteriaAvgMs} ms each</div>}
          {s.compiledCount !== undefined && <div>Cloud compile: {s.compiledCount} criteria, {s.compileMs} ms</div>}
        </section>
      )}

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "2px solid #d4d4d8" }}>
            <th>Step</th><th>OK</th><th>Ran</th><th>ms</th><th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {report.rows.map((r, i) => (
            <tr key={i} style={{ borderBottom: "1px solid #e4e4e7", verticalAlign: "top" }}>
              <td style={{ padding: "4px 6px 4px 0" }}>{r.step}</td>
              <td>{r.ok === null ? "" : r.ok ? "yes" : "NO"}</td>
              <td>{r.source ?? ""}</td>
              <td>{r.ms ?? ""}</td>
              <td style={{ padding: "4px 0", wordBreak: "break-word" }}>{r.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

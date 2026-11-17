import { useEffect, useRef, useState } from "react";
import sampleJson from "../../bench/data/sample.json";
import testJson from "../../bench/data/test.json";
import { ASK_GUIDE, cleanAsk, COMPILE_SCHEMA, COMPILE_SYSTEM, sanitizeCompiled } from "../engine/compileCore";
import { ALTERNATIVES_SCHEMA, ALTERNATIVES_SYSTEM, ALTERNATIVES_VERSION, sanitizeWithAlternatives } from "./alternatives";
import { judgeOnDevice, judgeSampleInCloud, MAX_SEMANTIC_PER_TRIAL } from "../engine/judge";
import { buildProfile, extractBasics, MAX_RECORD_CHARS, NO_DETAILS } from "../engine/profile";
import { evaluateRule } from "../engine/rules";
import type { CompiledCriterion, CriterionKind, Profile, Verdict } from "../engine/types";
import { deviceAvailability, generate, InferenceMode } from "../lib/hybrid";
import { combine } from "./combine";
import { computeMetrics, percent, type Judged, type Metrics } from "./metrics";

/**
 * Development-only evaluation bench.
 *
 * It runs the product's real on-device judge (Firebase AI Logic, ONLY_ON_DEVICE)
 * over patient-criterion pairs annotated by physicians (NIH/NCBI TrialGPT
 * criterion annotations, public domain, synthetic patients) and compares answers.
 *
 * Three variants are measured on the same pairs:
 * - "raw": the registry wording is put to the on-device model directly;
 * - "plain": the criterion is first rewritten as one plain question by the cloud model;
 * - "pipeline": the full product path. The cloud model splits the criterion into
 *   atomic conditions and writes a plain question for each; plain code decides
 *   age and sex from the profile read on the device; the on-device model answers the rest.
 */

interface Item {
  id: number;
  patientId: string;
  trialId: string;
  kind: CriterionKind;
  criterion: string;
  note: string;
  expert: Verdict;
  gpt4: Verdict | null;
}

interface Out {
  ours: Verdict;
  ms: number;
  unsupported: boolean;
  evidence: string;
  error?: string;
  /** Pipeline only: how each atomic condition was decided. */
  atoms?: { text: string; by: string; verdict: Verdict; answer?: string; assumed?: boolean; quoted?: boolean }[];
}

/**
 * "v2" is the product's on-device pipeline. "cloudBase" is the path a fictional
 * sample takes on a browser with no on-device model: the same compiled
 * questions, several per request, answered by the cloud model.
 *
 * "v3" and "cloud" are the same two paths with the experimental compiler of
 * ./alternatives.ts, which was measured and not adopted.
 */
type Variant = "plain" | "raw" | "pipeline" | "v2" | "v3" | "cloud" | "cloudBase";
const VARIANTS: Variant[] = ["cloudBase", "v2", "cloud", "v3", "pipeline", "plain", "raw"];

/** Which compiler output a run uses: the product's, or the experimental one. */
type CompiledSet = "compiled" | "compiledNow";

interface Store {
  startedAt: string;
  asks: Record<string, string>;
  /** Compiled with the product's compiler. */
  compiled: Record<string, CompiledCriterion[]>;
  /** Compiled with the experimental compiler, for "v3" and "cloud". */
  compiledNow: Record<string, CompiledCriterion[]>;
  compiledNowVersion: number;
  profiles: Record<string, Profile>;
  runs: Record<Variant, Record<string, Out>>;
}

// "#bench" runs the tuning sample. "#bench-test" runs the held-out sample: pairs
// that were never looked at while the judge was being adjusted.
const HELD_OUT = location.hash === "#bench-test";
const SAMPLE = (HELD_OUT ? testJson : sampleJson) as Item[];
const KEY = HELD_OUT ? "oneway-benchtest-v1" : "oneway-bench-v1";
const JOB_KEY = HELD_OUT ? "oneway-benchtest-job" : "oneway-bench-job";
const SINK = HELD_OUT ? "benchtest" : "bench";
type Job = "pipeline" | "single" | "v2" | "v3" | "cloud-base";
const JOBS: Job[] = ["pipeline", "single", "v2", "v3", "cloud-base"];

function load(): Store {
  const fresh: Store = {
    startedAt: new Date().toISOString(),
    asks: {},
    compiled: {},
    compiledNow: {},
    compiledNowVersion: ALTERNATIVES_VERSION,
    profiles: {},
    runs: { plain: {}, raw: {}, pipeline: {}, v2: {}, v3: {}, cloud: {}, cloudBase: {} },
  };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Store>;
      const store = { ...fresh, ...saved, runs: { ...fresh.runs, ...(saved.runs ?? {}) } };
      // Results measured with another version of the experiment are not mixed with this one.
      if (store.compiledNowVersion !== ALTERNATIVES_VERSION) {
        return { ...store, compiledNow: {}, compiledNowVersion: ALTERNATIVES_VERSION, runs: { ...store.runs, v3: {}, cloud: {} } };
      }
      return store;
    }
  } catch {
    /* start fresh */
  }
  return fresh;
}

function judgedFor(store: Store, variant: Variant): Judged[] {
  return SAMPLE.filter((it) => store.runs[variant][it.id] && !store.runs[variant][it.id].error).map((it) => {
    const out = store.runs[variant][it.id];
    return { kind: it.kind, expert: it.expert, ours: out.ours, ms: out.ms, unsupported: out.unsupported };
  });
}

function gpt4Judged(): Judged[] {
  return SAMPLE.filter((it) => it.gpt4).map((it) => ({ kind: it.kind, expert: it.expert, ours: it.gpt4 as Verdict }));
}

async function persist(store: Store): Promise<void> {
  localStorage.setItem(KEY, JSON.stringify(store));
  const count = (v: Variant) => Object.values(store.runs[v]).filter((o) => o.error).length;
  const payload = {
    dataset: "ncbi/TrialGPT-Criterion-Annotations (public domain)",
    sample: HELD_OUT ? "held-out" : "tuning",
    sampleSize: SAMPLE.length,
    userAgent: navigator.userAgent,
    startedAt: store.startedAt,
    updatedAt: new Date().toISOString(),
    asksWritten: Object.keys(store.asks).length,
    compiledCount: Object.keys(store.compiled).length,
    compiledNowCount: Object.keys(store.compiledNow).length,
    compilerVersion: store.compiledNowVersion,
    profilesRead: Object.keys(store.profiles).length,
    metrics: {
      ...(Object.fromEntries(VARIANTS.map((v) => [v, computeMetrics(judgedFor(store, v))])) as Record<Variant, Metrics>),
      gpt4: computeMetrics(gpt4Judged()),
    },
    errors: Object.fromEntries(VARIANTS.map((v) => [v, count(v)])),
    asks: store.asks,
    compiled: store.compiled,
    compiledNow: store.compiledNow,
    profiles: Object.fromEntries(Object.entries(store.profiles).map(([k, p]) => [k, { age: p.age, sex: p.sex }])),
    runs: store.runs,
    items: SAMPLE.map(({ note: _note, ...rest }) => rest),
  };
  try {
    await fetch(`/__spike-result?name=${SINK}`, { method: "POST", body: JSON.stringify(payload, null, 1) });
  } catch {
    /* dev sink only */
  }
}

const ASK_SYSTEM = `You rewrite clinical trial eligibility criteria as plain questions.
For each item write "ask": ${ASK_GUIDE}
Return one entry per item, with the same id.`;

const ASK_SCHEMA = {
  type: "object",
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: { type: "object", required: ["id", "ask"], properties: { id: { type: "integer" }, ask: { type: "string" } } },
    },
  },
};

/** Retries a cloud call a few times, because a free tier limits requests per minute. */
async function withRetries<T>(call: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await call();
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, 15000 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function cloud<T>(req: Parameters<typeof generate>[0]): Promise<T> {
  return withRetries(async () => (await generate<T>(req)).data);
}

function Row({ label, m }: { label: string; m: Metrics }) {
  return (
    <tr>
      <td>{label}</td>
      <td>{m.n}</td>
      <td>{percent(m.exact, m.n)}</td>
      <td>{percent(m.decisiveCorrect, m.decisive)}</td>
      <td>{percent(m.decisive, m.n)}</td>
      <td>
        {m.falseBlockers} / {m.expertNonBlockers}
      </td>
      <td>
        {m.falseClearances} / {m.expertBlockers}
      </td>
      <td>
        {m.blockersFound} / {m.expertBlockers}
      </td>
      <td>{m.avgMs === null ? "" : `${(m.avgMs / 1000).toFixed(1)} s`}</td>
    </tr>
  );
}

export function Bench() {
  const [store, setStore] = useState<Store>(load);
  const [status, setStatus] = useState("");
  const [device, setDevice] = useState("…");
  const stop = useRef(false);
  const busy = useRef(false);
  const ref = useRef(store);
  ref.current = store;

  useEffect(() => {
    void deviceAvailability(false).then(setDevice);
  }, []);

  async function commit(next: Store) {
    ref.current = next;
    setStore(next);
    await persist(next);
  }

  /**
   * Runs a long job. The job name is remembered, so if the page reloads in the
   * middle (dev server restart, tab reload) the bench picks up where it stopped.
   */
  async function guarded(job: Job) {
    if (busy.current) return;
    busy.current = true;
    stop.current = false;
    localStorage.setItem(JOB_KEY, job);
    try {
      if (job === "v3") {
        await compileAll("compiledNow");
        await readProfiles();
        // The cloud path first: it takes a few minutes, the on-device path much longer.
        await runCloud("compiledNow", "cloud");
        await runPipeline("v3", "compiledNow");
      } else if (job === "cloud-base") {
        await compileAll("compiled");
        await readProfiles();
        await runCloud("compiled", "cloudBase");
      } else if (job === "pipeline" || job === "v2") {
        await compileAll("compiled");
        await readProfiles();
        await runPipeline(job, "compiled");
      } else {
        await writeAsks();
        await runSingle("plain");
        await runSingle("raw");
      }
      setStatus(stop.current ? "Stopped. Progress is saved; run again to resume." : `Job "${job}" finished.`);
      localStorage.removeItem(JOB_KEY);
    } catch (e) {
      // Left in place on purpose: a reload will try again.
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    busy.current = false;
  }

  useEffect(() => {
    const pending = localStorage.getItem(JOB_KEY);
    const job = JOBS.find((j) => j === pending);
    if (job) {
      setStatus(`Resuming job "${job}" after a reload…`);
      void guarded(job);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function writeAsks() {
    const todo = SAMPLE.filter((it) => !ref.current.asks[it.id]);
    for (let i = 0; i < todo.length && !stop.current; i += 10) {
      const batch = todo.slice(i, i + 10);
      setStatus(`Cloud: writing plain questions ${i + 1}–${i + batch.length} of ${todo.length}…`);
      const data = await cloud<{ items: { id: number; ask: string }[] }>({
        mode: InferenceMode.ONLY_IN_CLOUD,
        label: "Bench: wrote plain questions",
        system: ASK_SYSTEM,
        prompt: batch.map((it) => `id ${it.id} (${it.kind} criterion): ${it.criterion}`).join("\n\n"),
        schema: ASK_SCHEMA,
      });
      const asks = { ...ref.current.asks };
      for (const a of data.items ?? []) {
        const clean = cleanAsk(a.ask);
        if (clean && batch.some((it) => it.id === a.id)) asks[a.id] = clean;
      }
      await commit({ ...ref.current, asks });
    }
  }

  /** Cloud: the product's own compile prompt, applied to one annotated criterion at a time. */
  async function compileAll(set: CompiledSet) {
    const todo = SAMPLE.filter((it) => !ref.current[set][it.id]);
    let done = 0;
    for (const it of todo) {
      if (stop.current) break;
      setStatus(`Cloud: splitting criteria into atomic conditions, ${done + 1} of ${todo.length}…`);
      // Stay under the per-minute limit of the no-cost Gemini tier.
      if (done > 0) await new Promise((r) => setTimeout(r, 2500));
      const source = `${it.kind === "inclusion" ? "Inclusion Criteria" : "Exclusion Criteria"}:\n* ${it.criterion}`;
      const data = await cloud<{ criteria: unknown }>({
        mode: InferenceMode.ONLY_IN_CLOUD,
        label: "Bench: compiled one criterion",
        system: set === "compiled" ? COMPILE_SYSTEM : ALTERNATIVES_SYSTEM,
        prompt: `Source text of ${it.trialId}:\n\n${source}`,
        schema: (set === "compiled" ? COMPILE_SCHEMA : ALTERNATIVES_SCHEMA) as unknown as Record<string, unknown>,
      });
      // Same integrity check as the product: only text quoted from the source is kept.
      const clean = set === "compiled" ? sanitizeCompiled : sanitizeWithAlternatives;
      const atoms = clean(data.criteria, source).map((a) => ({ ...a, kind: it.kind }));
      await commit({ ...ref.current, [set]: { ...ref.current[set], [it.id]: atoms } });
      done++;
    }
  }

  /** The atomic conditions of one annotated criterion, or the criterion itself when the compiler kept nothing. */
  function atomsOf(it: Item, set: CompiledSet): CompiledCriterion[] {
    const atoms = ref.current[set][it.id] ?? [];
    if (atoms.length > 0) return atoms;
    // For example a consent item, which the compiler skips: judge the whole criterion.
    return [{ id: "c1", kind: it.kind, text: it.criterion, check: "semantic", ...(ref.current.asks[it.id] ? { ask: ref.current.asks[it.id] } : {}) }];
  }

  /**
   * The path of a fictional sample on a browser with no on-device model: the
   * cloud model answers several compiled questions in one request. The product
   * groups the questions of one trial; here the questions about one patient are
   * grouped, up to the same number per request.
   */
  async function runCloud(set: CompiledSet, key: "cloud" | "cloudBase") {
    const patients = [...new Set(SAMPLE.map((it) => it.patientId))];
    let done = 0;
    for (const patientId of patients) {
      if (stop.current) break;
      const items = SAMPLE.filter((it) => it.patientId === patientId && ref.current[set][it.id] && !ref.current.runs[key][it.id]);
      done++;
      if (items.length === 0) continue;
      setStatus(`Cloud (${key}, grouped questions): patient ${done} of ${patients.length}…`);
      const note = items[0].note;
      const profile = ref.current.profiles[patientId];
      const details = new Map<number, NonNullable<Out["atoms"]>>(items.map((it) => [it.id, []]));
      const pending: { item: Item; criterion: CompiledCriterion }[] = [];
      for (const it of items) {
        for (const atom of atomsOf(it, set)) {
          const byCode = profile && (atom.field === "age" || atom.field === "sex") ? evaluateRule(atom, profile) : null;
          if (byCode) details.get(it.id)!.push({ text: atom.text, by: "rules", verdict: byCode.verdict });
          else pending.push({ item: it, criterion: { ...atom, id: `q${pending.length + 1}`, check: "semantic" } });
        }
      }
      const started = performance.now();
      const failed = new Map<number, string>();
      const flags = new Map<number, { unsupported: boolean; evidence: string }>();
      for (let i = 0; i < pending.length; i += MAX_SEMANTIC_PER_TRIAL) {
        const chunk = pending.slice(i, i + MAX_SEMANTIC_PER_TRIAL);
        try {
          const results = await withRetries(() => judgeSampleInCloud("bench", chunk.map((p) => p.criterion), note.slice(0, MAX_RECORD_CHARS), note));
          results.forEach((r, k) => {
            const it = chunk[k].item;
            details.get(it.id)!.push({ text: r.criterion.text, by: "cloud-model", verdict: r.verdict, answer: r.modelAnswer, assumed: Boolean(r.assumed), quoted: r.evidenceVerified });
            const f = flags.get(it.id) ?? { unsupported: false, evidence: "" };
            flags.set(it.id, { unsupported: f.unsupported || Boolean(r.unsupported), evidence: f.evidence || r.evidence });
          });
        } catch (e) {
          for (const p of chunk) failed.set(p.item.id, e instanceof Error ? e.message : String(e));
        }
        await new Promise((r) => setTimeout(r, 2500));
      }
      const ms = Math.round((performance.now() - started) / items.length);
      const runs = { ...ref.current.runs[key] };
      for (const it of items) {
        const error = failed.get(it.id);
        const detail = details.get(it.id)!;
        runs[it.id] = {
          ours: error ? "unknown" : combine(it.kind, detail.map((d) => d.verdict)),
          ms,
          unsupported: flags.get(it.id)?.unsupported ?? false,
          evidence: flags.get(it.id)?.evidence ?? "",
          atoms: detail,
          ...(error ? { error } : {}),
        };
      }
      await commit({ ...ref.current, runs: { ...ref.current.runs, [key]: runs } });
    }
  }

  /** Device: first reading pass per patient, as the product does, to get age and sex for the rules. */
  async function readProfiles() {
    const patients = [...new Map(SAMPLE.map((it) => [it.patientId, it.note])).entries()].filter(([id]) => !ref.current.profiles[id]);
    let done = 0;
    for (const [patientId, note] of patients) {
      if (stop.current) break;
      setStatus(`Device: reading age and sex of patient ${done + 1} of ${patients.length}…`);
      const basics = await extractBasics(note, "sample").catch(() => null);
      const profile = basics ? buildProfile(basics, NO_DETAILS, note) : buildProfile({ age: null, sex: "unknown", primaryCondition: "", conditions: [], ecog: null, pregnant: "unknown", location: "" }, NO_DETAILS, note);
      await commit({ ...ref.current, profiles: { ...ref.current.profiles, [patientId]: profile } });
      done++;
    }
  }

  async function runSingle(variant: "plain" | "raw") {
    const todo = SAMPLE.filter((it) => !ref.current.runs[variant][it.id]);
    let done = 0;
    for (const it of todo) {
      if (stop.current) break;
      setStatus(`Device (${variant}): ${done + 1} of ${todo.length} remaining pairs…`);
      const criterion: CompiledCriterion = {
        id: `b${it.id}`,
        kind: it.kind,
        text: it.criterion,
        check: "semantic",
        ...(variant === "plain" && ref.current.asks[it.id] ? { ask: ref.current.asks[it.id] } : {}),
      };
      let out: Out;
      const started = performance.now();
      try {
        const [r] = await judgeOnDevice(it.trialId, [criterion], it.note, undefined, undefined, "private");
        out = { ours: r.verdict, ms: Math.round(performance.now() - started), unsupported: Boolean(r.unsupported), evidence: r.evidence };
      } catch (e) {
        out = { ours: "unknown", ms: Math.round(performance.now() - started), unsupported: false, evidence: "", error: e instanceof Error ? e.message : String(e) };
      }
      await commit({ ...ref.current, runs: { ...ref.current.runs, [variant]: { ...ref.current.runs[variant], [it.id]: out } } });
      done++;
    }
  }

  /** The full product path: atomic conditions, code for age and sex, the on-device model for the rest. */
  async function runPipeline(key: "pipeline" | "v2" | "v3", set: CompiledSet) {
    const todo = SAMPLE.filter((it) => !ref.current.runs[key][it.id] && ref.current[set][it.id]);
    let done = 0;
    for (const it of todo) {
      if (stop.current) break;
      setStatus(`Device (${key}): ${done + 1} of ${todo.length} remaining pairs…`);
      const profile = ref.current.profiles[it.patientId];
      const atoms = atomsOf(it, set);
      const started = performance.now();
      const detail: NonNullable<Out["atoms"]> = [];
      let unsupported = false;
      let evidence = "";
      let error: string | undefined;
      try {
        for (const atom of atoms) {
          // Only age and sex are decided by code here: the bench reads no lab values.
          const byCode = profile && (atom.field === "age" || atom.field === "sex") ? evaluateRule(atom, profile) : null;
          if (byCode) {
            detail.push({ text: atom.text, by: "rules", verdict: byCode.verdict });
            continue;
          }
          const [r] = await judgeOnDevice(it.trialId, [{ ...atom, check: "semantic" }], it.note, undefined, undefined, "private");
          detail.push({ text: atom.text, by: "device-model", verdict: r.verdict, answer: r.modelAnswer, assumed: Boolean(r.assumed), quoted: r.evidenceVerified });
          if (r.unsupported) unsupported = true;
          if (r.evidence && !evidence) evidence = r.evidence;
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const out: Out = {
        ours: error ? "unknown" : combine(it.kind, detail.map((d) => d.verdict)),
        ms: Math.round(performance.now() - started),
        unsupported,
        evidence,
        atoms: detail,
        ...(error ? { error } : {}),
      };
      await commit({ ...ref.current, runs: { ...ref.current.runs, [key]: { ...ref.current.runs[key], [it.id]: out } } });
      done++;
    }
  }

  function reset() {
    if (busy.current) return;
    localStorage.removeItem(KEY);
    localStorage.removeItem(JOB_KEY);
    const fresh = load();
    ref.current = fresh;
    setStore(fresh);
    setStatus("Cleared.");
  }

  const cloudBase = computeMetrics(judgedFor(store, "cloudBase"));
  const cloudRun = computeMetrics(judgedFor(store, "cloud"));
  const v3 = computeMetrics(judgedFor(store, "v3"));
  const v2 = computeMetrics(judgedFor(store, "v2"));
  const pipeline = computeMetrics(judgedFor(store, "pipeline"));
  const plain = computeMetrics(judgedFor(store, "plain"));
  const raw = computeMetrics(judgedFor(store, "raw"));
  const gpt4 = computeMetrics(gpt4Judged());

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 1040, margin: "0 auto", padding: 16, lineHeight: 1.45 }}>
      <h1 style={{ fontSize: 22 }}>OneWay — evaluation bench (dev)</h1>
      <p>
        {SAMPLE.length} patient-criterion pairs annotated by physicians (NIH/NCBI TrialGPT criterion annotations, public domain, synthetic
        patients). On-device model: <b>{device}</b>. Plain questions: {Object.keys(store.asks).length}/{SAMPLE.length}. Compiled:{" "}
        {Object.keys(store.compiled).length}/{SAMPLE.length}. Patients read: {Object.keys(store.profiles).length}.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button id="run-pipeline" onClick={() => void guarded("pipeline")}>
          Run the full product pipeline
        </button>
        <button id="run-cloud-base" onClick={() => void guarded("cloud-base")}>
          Run the cloud path of the fictional samples
        </button>
        <button id="run-v3" onClick={() => void guarded("v3")}>
          Run the experimental compiler (not adopted): cloud path, then on-device
        </button>
        <button id="run-v2" onClick={() => void guarded("v2")}>
          Run pipeline v2
        </button>
        <button onClick={() => void guarded("single")}>Run the two single-question variants</button>
        <button
          onClick={() => {
            stop.current = true;
            localStorage.removeItem(JOB_KEY);
          }}
        >
          Stop
        </button>
        <button onClick={reset}>Clear results</button>
      </div>
      <p role="status" id="bench-status">
        <b>{status}</b>
      </p>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }} id="bench-table">
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "2px solid #d4d4d8" }}>
            <th>Variant</th>
            <th>Pairs</th>
            <th>Same answer as physicians</th>
            <th>Correct when it answers yes/no</th>
            <th>Answers yes/no</th>
            <th>False blockers</th>
            <th>False clearances</th>
            <th>Blockers found</th>
            <th>Time per pair</th>
          </tr>
        </thead>
        <tbody>
          <Row label="Product, on the device (v2)" m={v2} />
          <Row label="Product, cloud path of the fictional samples" m={cloudBase} />
          <Row label="Experiment, not adopted: alternatives one by one, on the device (v3)" m={v3} />
          <Row label="Experiment, not adopted: alternatives one by one, cloud path" m={cloudRun} />
          <Row label="Full pipeline, first version" m={pipeline} />
          <Row label="On-device, one plain question from cloud" m={plain} />
          <Row label="On-device, raw registry wording" m={raw} />
          <Row label="GPT-4, as published in the dataset" m={gpt4} />
        </tbody>
      </table>
    </main>
  );
}

import { Check, Command, Cpu, Monitor, Moon, RotateCcw, Search, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isFirebaseConfigured } from "../lib/firebase";
import { CommandPalette } from "./CommandPalette";
import { Elapsed } from "./Elapsed";
import { nextTheme, setTheme, useTheme } from "./theme";
import { Toasts } from "./Toasts";
import { Hero, HowItWorks, WelcomeBack } from "./Home";
import { Ledger } from "./Ledger";
import { RecordCard } from "./RecordCard";
import { EXAMPLE_READY } from "./recorded/ready";
import { session, useSession, type SessionState } from "./session";
import { TrialList } from "./Trials";
import { labText, sameCondition, tabTitle } from "./view";
import "./styles.css";

function DeviceChip({ s }: { s: SessionState }) {
  // During a replay nothing runs here: this browser's model has nothing to do with what is shown.
  if (s.replay) {
    return (
      <span className="chip" title="A recorded run is being shown. Nothing is computed or sent.">
        Replaying a recorded run
      </span>
    );
  }
  if (s.device === null) return <span className="chip">Checking this browser…</span>;
  if (s.device === "available") {
    return (
      <span className="chip chip-device" title="Gemini Nano is ready in this browser: your record can be read here">
        <span className="live-dot" aria-hidden="true" />
        On-device model ready
      </span>
    );
  }
  if (s.device === "downloadable" || s.device === "downloading") {
    return (
      <span className="chip chip-warn">
        {s.download !== null ? `Downloading the on-device model… ${s.download}%` : "On-device model needs a one-time download"}
      </span>
    );
  }
  return <span className="chip chip-warn">No on-device model here</span>;
}

function Steps({ phase }: { phase: SessionState["phase"] }) {
  const index = phase === "start" || phase === "reading" ? 0 : phase === "review" || phase === "searching" ? 1 : 2;
  const labels = ["Your record", "What leaves", "Trials"];
  return (
    <ol className="steps" aria-label="Progress" style={{ ["--step" as string]: index }}>
      {labels.map((label, i) => (
        <li key={label} className={i === index ? "is-current" : i < index ? "is-done" : ""} aria-current={i === index ? "step" : undefined}>
          <span className="steps-num">{i < index ? <Check size={12} strokeWidth={3} aria-hidden="true" /> : i + 1}</span>
          <span className="steps-label">{label}</span>
        </li>
      ))}
    </ol>
  );
}

function ThemeToggle() {
  const theme = useTheme();
  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  const label = theme === "light" ? "Light theme" : theme === "dark" ? "Dark theme" : "Theme of your system";
  return (
    <button className="icon-btn" onClick={() => setTheme(nextTheme(theme))} aria-label={`${label}. Change the theme`} title={label}>
      <Icon size={17} aria-hidden="true" />
    </button>
  );
}

function Start({ s }: { s: SessionState }) {
  return (
    <>
      <WelcomeBack s={s} />
      {!s.returning && <RecordCard s={s} />}
      <HowItWorks />
    </>
  );
}

function Reading({ s }: { s: SessionState }) {
  return (
    <section className="card reading" aria-live="polite">
      <div className="orb" aria-hidden="true">
        <span className="orb-ring" />
        <span className="orb-core">
          <Cpu size={26} />
        </span>
      </div>
      <div className="card-head-row">
        <h2 data-phase-title tabIndex={-1}>
          Reading your record{s.level === "private" ? " on this device" : ""}
        </h2>
        <Elapsed since={s.readingSince} />
      </div>
      <div className="bar bar-busy" aria-hidden="true">
        <span />
      </div>
      <ul className="progress-list">
        <li className="is-active">
          <span className="dot" aria-hidden="true" />
          Age, sex and diagnosis
          {s.readingPart && <span className="part-note"> · part {s.readingPart.part} of {s.readingPart.parts}</span>}
          <span className="sr-only"> in progress</span>
        </li>
        <li>
          <span className="dot" aria-hidden="true" />
          Treatments and lab values
        </li>
      </ul>
      {s.level === "private" ? (
        <p className="note note-device">
          This runs on your computer's own processor, usually for one to two minutes
          {s.recordParts > 1 ? ` per part: your record is long, so it is read in ${s.recordParts} parts` : ""}. Nothing is being uploaded:
          the ledger lists every request. You can leave this tab open and come back.
        </p>
      ) : (
        <p className="note">This fictional patient is read on this device when the on-device model is here, otherwise by the cloud model.</p>
      )}
      <div className="actions live-only">
        <button className="btn btn-quiet" onClick={() => session.backToRecord()}>
          Stop and go back
        </button>
      </div>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd className={value ? "" : "is-empty"}>{value || "Not stated"}</dd>
    </div>
  );
}

function Review({ s }: { s: SessionState }) {
  const [editing, setEditing] = useState(false);
  const p = s.profile!;
  const received = p.therapies.filter((t) => t.status === "received").map((t) => t.name);
  const never = p.therapies.filter((t) => t.status === "never_received").map((t) => t.name);
  const searching = s.phase === "searching" || Boolean(s.replay);
  // A fictional patient is read by the cloud model when this browser has no on-device model.
  const readInCloud = s.level === "sample" && s.device !== null && s.device !== "available" && !s.replay;
  // The diagnosis is shown on its own line: do not repeat it among the other conditions.
  const otherConditions = p.conditions.filter((c) => !sameCondition(c, p.primaryCondition, p.searchTerm ?? ""));
  const preview = `condition: ${s.query.condition.trim() || "…"}${s.query.location.trim() ? `\nlocation: ${s.query.location.trim()}` : ""}`;
  return (
    <>
      {s.urgent && (
        <div className="banner banner-urgent" role="alert">
          <strong>If this is an emergency, get help now.</strong> Call your local emergency number or go to the nearest emergency department.
          OneWay cannot help with urgent situations.
        </div>
      )}
      <section className="card lane-device" aria-labelledby="read-title">
        <p className="eyebrow">{readInCloud ? "Fictional patient, read by the cloud model" : "Stays on this device"}</p>
        <div className="card-head-row">
          <h2 id="read-title" data-phase-title tabIndex={-1}>
            What OneWay read
          </h2>
          {!searching && (
            <button className="link live-only" onClick={() => setEditing((v) => !v)} aria-expanded={editing}>
              {editing ? "Done" : "Something wrong? Correct it"}
            </button>
          )}
        </div>
        <dl className="facts">
          {editing && !searching ? (
            <>
              <div className="fact">
                <dt>
                  <label htmlFor="fix-age">Age</label>
                </dt>
                <dd>
                  <input
                    id="fix-age"
                    type="number"
                    min={0}
                    max={120}
                    inputMode="numeric"
                    value={p.age ?? ""}
                    onChange={(e) => {
                      const n = e.target.value === "" ? null : Number(e.target.value);
                      session.correctProfile({ age: n !== null && Number.isFinite(n) && n >= 0 && n <= 120 ? Math.round(n) : null });
                    }}
                  />
                </dd>
              </div>
              <div className="fact">
                <dt>
                  <label htmlFor="fix-sex">Sex</label>
                </dt>
                <dd>
                  <select id="fix-sex" value={p.sex} onChange={(e) => session.correctProfile({ sex: e.target.value as typeof p.sex })}>
                    <option value="unknown">Not stated</option>
                    <option value="female">female</option>
                    <option value="male">male</option>
                  </select>
                </dd>
              </div>
            </>
          ) : (
            <>
              <Fact label="Age" value={p.age === null ? "" : String(p.age)} />
              <Fact label="Sex" value={p.sex === "unknown" ? "" : p.sex} />
            </>
          )}
          <Fact label="Diagnosis" value={p.primaryCondition} />
          {editing && !searching ? (
            <div className="fact">
              <dt>
                <label htmlFor="fix-ecog">ECOG status</label>
              </dt>
              <dd>
                <select
                  id="fix-ecog"
                  value={p.ecog ?? ""}
                  onChange={(e) => session.correctProfile({ ecog: e.target.value === "" ? null : Number(e.target.value) })}
                >
                  <option value="">Not stated</option>
                  {[0, 1, 2, 3, 4].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </dd>
            </div>
          ) : (
            <Fact label="ECOG status" value={p.ecog === null ? "" : String(p.ecog)} />
          )}
          <Fact label="Other conditions" value={otherConditions.join(", ")} />
          {s.detailsReady ? (
            <>
              <Fact label="Treatments received" value={received.join(", ")} />
              <Fact label="Never received" value={never.join(", ")} />
              <Fact label="Lab values" value={p.labs.map(labText).join(" · ")} />
            </>
          ) : (
            <div className="fact fact-wide" aria-live="polite">
              <dt>Treatments and lab values</dt>
              <dd className="still-reading">
                <span className="dot" aria-hidden="true" /> Still reading
                {s.readingPart ? ` part ${s.readingPart.part} of ${s.readingPart.parts}` : ""}. You can approve the search below in the meantime.
                <Elapsed since={s.readingSince} />
              </dd>
            </div>
          )}
        </dl>
        <p className="note">
          {editing
            ? "Your corrections are used exactly as you give them, and they stay on this device like the rest."
            : "Every number above was checked to appear in your record. Anything the model could not back up was dropped."}
        </p>
        {!searching && (
          <div className="actions live-only">
            <button className="btn btn-quiet" onClick={() => session.backToRecord()}>
              ← Change my record
            </button>
          </div>
        )}
      </section>

      <section className="card lane-out" aria-labelledby="out-title">
        <p className="eyebrow">Leaves this device, with your approval</p>
        <h2 id="out-title">Search the public trial registry</h2>
        <p>
          To find trials, OneWay sends these words to ClinicalTrials.gov, the public US registry. Change them if you like. Your age, sex,
          treatments and results are not sent: they are compared here, on your device.
        </p>
        <form
          className="search-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!searching && s.query.condition.trim()) void session.search();
          }}
        >
          <div className="fields">
            <label>
              Condition
              <input value={s.query.condition} onChange={(e) => session.setQuery({ condition: e.target.value })} maxLength={60} disabled={searching} />
            </label>
            <label>
              City, state or country <span className="optional">(optional)</span>
              <input
                value={s.query.location}
                onChange={(e) => session.setQuery({ location: e.target.value })}
                maxLength={60}
                disabled={searching}
                placeholder="For trials near you"
              />
            </label>
          </div>
          <p className="payload-label">Exactly what will be sent:</p>
          <pre className="payload">{preview}</pre>
          <div className="actions">
            <button className="btn btn-primary btn-large" type="submit" disabled={searching || !s.query.condition.trim()}>
              <Search size={18} aria-hidden="true" />
              {s.replay ? "Approved in the recording" : searching ? "Searching…" : "Send these words and search"}
            </button>
            {!s.query.condition.trim() && !searching && <span className="actions-hint">Type the name of the condition to search for.</span>}
          </div>
        </form>
      </section>
    </>
  );
}

export function App() {
  const s = useSession();
  const previousPhase = useRef(s.phase);
  const [palette, setPalette] = useState(false);
  useEffect(() => session.init(), []);

  // Ctrl+K (or ⌘K) opens the actions, from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Progress in the tab title, so a long check can be followed from another tab.
  useEffect(() => {
    document.title = tabTitle(s.phase, s.trials);
  }, [s.phase, s.trials]);

  // A reload throws away minutes of local computing: ask first.
  const hasWork = s.phase !== "start" && !s.replay;
  useEffect(() => {
    if (!hasWork) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasWork]);

  // A file dropped beside the drop zone must not make the browser open it and leave the page.
  useEffect(() => {
    const block = (e: DragEvent) => {
      if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, []);

  // Each step starts at the top of the page, with keyboard focus on its title.
  useEffect(() => {
    if (previousPhase.current === s.phase) return;
    const searchingToggle = [previousPhase.current, s.phase].sort().join() === "review,searching";
    previousPhase.current = s.phase;
    if (searchingToggle) return;
    window.scrollTo({ top: 0 });
    document.querySelector<HTMLElement>("[data-phase-title]")?.focus({ preventScroll: true });
  }, [s.phase]);

  return (
    <div className={s.replay ? "shell is-replay" : "shell"}>
      <header className="top">
        <a className="brand" href="#" onClick={(e) => (e.preventDefault(), session.reset())} aria-label="OneWay, start over">
          <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="9" />
            <path d="M16 7v15m-6-6 6 6 6-6" />
          </svg>
          OneWay
        </a>
        <Steps phase={s.phase} />
        <div className="top-right">
          {!s.online && <span className="chip chip-warn">Offline</span>}
          <DeviceChip s={s} />
          <button className="kbd-btn" onClick={() => setPalette(true)} aria-label="Open the actions (Control K)" title="Actions">
            <Command size={15} aria-hidden="true" />
            <span className="kbd-btn-text">Actions</span>
            <kbd>Ctrl K</kbd>
          </button>
          <ThemeToggle />
          {s.phase !== "start" && (
            <button className="icon-btn" onClick={() => session.reset()} aria-label="Start over" title="Start over">
              <RotateCcw size={17} aria-hidden="true" />
            </button>
          )}
        </div>
      </header>

      {s.phase === "start" && !s.replay && <Hero s={s} />}

      <div className="layout">
        <main className="content">
          {!isFirebaseConfigured && (
            <div className="banner banner-error" role="alert">
              Firebase is not configured. Copy .env.example to .env.local and fill it in.
            </div>
          )}
          {s.replay && (
            <div className="banner banner-replay" role="status">
              <span>
                <strong>Recorded example.</strong> You are watching a replay of a real run made on{" "}
                {new Date(s.replay.recordedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })} ({s.replay.environment}
                ) with a fictional patient. Nothing is being computed or sent right now.
                {s.replay.finished ? " The replay is complete." : ""}
              </span>
              <button className="link" onClick={() => session.reset()}>
                Exit the example
              </button>
            </div>
          )}
          {s.error && (
            <div className="banner banner-error" role="alert">
              <span>{s.error}</span>
              <span className="banner-actions">
                {EXAMPLE_READY && !s.replay && (
                  <button className="link" onClick={() => void session.playExample()}>
                    Watch a recorded example instead
                  </button>
                )}
                <button className="link" onClick={() => session.dismissError()}>
                  Dismiss
                </button>
              </span>
            </div>
          )}
          <div className="phase-view" key={s.phase === "searching" ? "review" : s.phase}>
            {s.phase === "start" && <Start s={s} />}
            {s.phase === "reading" && <Reading s={s} />}
            {(s.phase === "review" || s.phase === "searching") && <Review s={s} />}
            {s.phase === "results" && <TrialList s={s} />}
          </div>
          <footer className="foot">
            OneWay is not a medical device and does not decide who can join a trial. Only a trial team can. Use it to prepare a
            conversation with your doctor.
          </footer>
        </main>
        <Ledger level={s.level} replay={Boolean(s.replay)} remember={s.remember} />
      </div>
      <CommandPalette s={s} open={palette} onClose={() => setPalette(false)} />
      <Toasts />
    </div>
  );
}

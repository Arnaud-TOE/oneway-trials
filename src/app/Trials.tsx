import { Check, Copy, HelpCircle, ListChecks, Mail, Minus, Phone, Printer, Search, Star, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Explained } from "../engine/explain";
import type { CriterionResult, TrialFit } from "../engine/types";
import { dayLabel } from "./memory";
import { MyTrials, RememberOffer } from "./MyTrials";
import { CHECK_BATCH, session, useLedger, type SessionState, type TrialState } from "./session";
import {
  BUCKET_LABEL,
  bucketOf,
  canStillCheck,
  countBuckets,
  msPerCriterion,
  orderForReading,
  placesOf,
  questionsFor,
  roughDuration,
  tally,
  type Bucket,
} from "./view";

const FIT_LABEL: Record<TrialFit, string> = {
  worth_discussing: "Worth discussing with your doctor",
  possible: "Possible, with things to confirm",
  unlikely: "Probably not a fit",
};

/** A number that counts up or down to its new value, so changes are seen rather than just replaced. */
function CountUp({ value, className }: { value: number; className?: string }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current;
    if (start === value) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    // A hidden tab draws no frames, so an animation would freeze on an old number.
    if (reduced || document.visibilityState !== "visible") {
      from.current = value;
      setShown(value);
      return;
    }
    const began = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - began) / 600);
      const eased = 1 - Math.pow(1 - k, 3);
      setShown(Math.round(start + (value - start) * eased));
      if (k < 1) frame = requestAnimationFrame(step);
      else from.current = value;
    };
    frame = requestAnimationFrame(step);
    // A browser can stop drawing frames (a covered window, a background panel): the right number is shown anyway.
    const settle = setTimeout(() => {
      cancelAnimationFrame(frame);
      from.current = value;
      setShown(value);
    }, 800);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(settle);
      from.current = value;
    };
  }, [value]);
  return <span className={className}>{shown}</span>;
}

function SourceBadge({ e }: { e: Explained }) {
  return e.source === "on_device" ? (
    <span className="tag tag-device">answered on this device</span>
  ) : (
    <span className="tag tag-out">answered by the cloud model</span>
  );
}

function StatusBadge({ t, detailsReady }: { t: TrialState; detailsReady: boolean }) {
  if (t.status === "done" && t.match) return <span className={`fit fit-${t.match.fit}`}>{FIT_LABEL[t.match.fit]}</span>;
  if (t.status === "checking") return <span className="fit fit-busy">Checking…</span>;
  if (t.status === "queued") return <span className="fit fit-idle">Next in line</span>;
  if (t.status === "compiling") return <span className="fit fit-idle">{detailsReady ? "Preparing the rules…" : "Rules ready, still reading your record…"}</span>;
  if (t.status === "error") return <span className="fit fit-unlikely">Could not be checked</span>;
  if (t.status === "ready" && t.match && t.match.counts.blocker > 0) return <span className="fit fit-unlikely">Probably not a fit</span>;
  return <span className="fit fit-idle">Not checked yet</span>;
}

/** Lets the person answer an open question, or say that an exclusion with no sign in the record does apply. */
function AnswerButtons({ nctId, r, canAnswer }: { nctId: string; r: CriterionResult; canAnswer: boolean }) {
  const id = r.criterion.id;
  if (r.decidedBy === "person") {
    return (
      <div className="answer-row">
        <span className="tag tag-person">your answer</span>
        {canAnswer && (
          <button className="link" onClick={() => session.answer(nctId, id, null)}>
            Take my answer back
          </button>
        )}
      </div>
    );
  }
  if (!canAnswer) return null;
  if (r.outcome === "unknown") {
    return (
      <div className="answer-row" role="group" aria-label="Do you know the answer?">
        <span className="answer-ask">Do you know?</span>
        <button className="chip-btn" onClick={() => session.answer(nctId, id, "yes")}>
          Yes, this applies to me
        </button>
        <button className="chip-btn" onClick={() => session.answer(nctId, id, "no")}>
          No, it doesn't
        </button>
      </div>
    );
  }
  if (r.assumed) {
    return (
      <div className="answer-row">
        <button className="link" onClick={() => session.answer(nctId, id, "yes")}>
          Actually, this applies to me
        </button>
      </div>
    );
  }
  return null;
}

function Criterion({ nctId, r, explained, canAnswer }: { nctId: string; r: CriterionResult; explained?: Explained | "loading"; canAnswer: boolean }) {
  const c = r.criterion;
  return (
    <li className={`criterion is-${r.assumed ? "assumed" : r.outcome} ${r.decidedBy === "person" ? "is-person" : ""}`}>
      <span className="criterion-icon" aria-hidden="true">
        {r.assumed ? <Minus size={14} strokeWidth={3} /> : r.outcome === "ok" ? <Check size={14} strokeWidth={3} /> : r.outcome === "blocker" ? <X size={14} strokeWidth={3} /> : <HelpCircle size={15} strokeWidth={2.5} />}
      </span>
      <div>
        <p className="criterion-text">{c.text}</p>
        {r.decidedBy === "person" && <p className="evidence">{r.evidence}</p>}
        {r.decidedBy === "rules" && r.evidence && <p className="evidence">{r.evidence}</p>}
        {r.decidedBy !== "rules" && r.decidedBy !== "person" && r.evidenceVerified && (
          <p className="evidence">
            From your record: <q>{r.evidence}</q>
          </p>
        )}
        {r.conflict && (
          <p className="evidence evidence-weak">
            Your documents say two different things: <q>{r.conflict.yes}</q> and <q>{r.conflict.no}</q>. Ask your doctor which one is current.
          </p>
        )}
        {r.unsupported && (
          <p className="evidence evidence-weak">
            The model leaned towards {r.unsupported === "met" ? "yes" : "no"} but could not quote the record, so this stays an open question.
          </p>
        )}
        <p className="criterion-meta">
          <span className="tag">{c.kind === "exclusion" ? "must not apply" : "must apply"}</span>
          {r.decidedBy === "rules" && <span className="tag tag-rules">decided by plain code</span>}
          {r.decidedBy === "device-model" && <span className="tag tag-device">on-device model</span>}
          {r.decidedBy === "cloud-model" && <span className="tag tag-out">cloud model (fictional patient)</span>}
        </p>
        <AnswerButtons nctId={nctId} r={r} canAnswer={canAnswer} />
        {explained && explained !== "loading" && (
          <p className="explained">
            {explained.text} <SourceBadge e={explained} />
          </p>
        )}
        <div className="criterion-links">
          {(!explained || explained === "loading") && (
            <button className="link" disabled={explained === "loading"} onClick={() => void session.explain(nctId, c)}>
              {explained === "loading" ? "Explaining…" : "What does this mean?"}
            </button>
          )}
          {r.decidedBy !== "rules" && r.decidedBy !== "person" && c.ask && (
            <details className="asked">
              <summary>How it was asked</summary>
              <p>
                The model was asked: <q>{c.ask}</q>
              </p>
            </details>
          )}
        </div>
      </div>
    </li>
  );
}

function Group({
  title,
  hint,
  nctId,
  t,
  items,
  canAnswer,
}: {
  title: string;
  hint?: string;
  nctId: string;
  t: TrialState;
  items: CriterionResult[];
  canAnswer: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <section className="group">
      <h4>
        {title} <span className="count">{items.length}</span>
      </h4>
      {hint && <p className="group-hint">{hint}</p>}
      <ul className="criteria">
        {items.map((r) => (
          <Criterion key={r.criterion.id} nctId={nctId} r={r} explained={t.explanations[r.criterion.id]} canAnswer={canAnswer} />
        ))}
      </ul>
    </section>
  );
}

/** The next step for a trial: who to call or write to, nearest site first. Public contacts from the registry. */
function ContactBlock({ t, searchedNear }: { t: TrialState; searchedNear: string }) {
  const want = searchedNear.trim().toLowerCase();
  const sites = t.trial.locations.filter((l) => (l.contacts?.length ?? 0) > 0 && (!l.status || l.status === "RECRUITING"));
  const near = want ? sites.find((l) => `${l.city} ${l.state}`.toLowerCase().includes(want.split(",")[0])) : undefined;
  const site = near ?? null;
  // Seen in the registry: a trial's first published contact can be its data protection officer, or a line
  // for doctors who want to run the trial. Those are not who a patient should call.
  const forPatients = (c: { name: string }) => !/data protection|privacy|\bdpo\b|investigators?|physicians interested|media|press/i.test(c.name);
  const contact = site?.contacts?.find(forPatients) ?? t.trial.contacts?.find(forPatients);
  if (!contact) return null;
  return (
    <div className="contact">
      <p className="contact-title">
        <Phone size={15} aria-hidden="true" />
        {site ? `Study team at ${site.facility || site.city}` : "Study team"}
      </p>
      <p className="contact-line">
        {contact.name && <span className="contact-name">{contact.name}</span>}
        {contact.phone && (
          <a href={`tel:${contact.phone.replace(/[^\d+]/g, "")}`}>
            <Phone size={14} aria-hidden="true" />
            {contact.phone}
          </a>
        )}
        {contact.email && (
          <a href={`mailto:${contact.email}?subject=${encodeURIComponent(`Question about ${t.trial.nctId}`)}`}>
            <Mail size={14} aria-hidden="true" />
            {contact.email}
          </a>
        )}
      </p>
      <p className="contact-hint">Published in the public registry. Talk to your doctor first; the study team decides who can join.</p>
    </div>
  );
}

/** One bar showing, for every criterion of the trial, how it came out. */
function FitMeter({ t }: { t: TrialState }) {
  const total = t.criteria?.length ?? 0;
  if (total === 0) return null;
  const c = tally(t.match?.results ?? []);
  const parts: [string, number, string][] = [
    ["ok", c.fits, "fit"],
    ["assumed", c.noSign, "with no sign in your record"],
    ["open", c.open, "to ask about"],
    ["blocker", c.blockers, "may rule it out"],
    ["pending", t.pending, "not checked yet"],
  ];
  return (
    <div className="meter" role="img" aria-label={parts.filter(([, n]) => n > 0).map(([, n, label]) => `${n} ${label}`).join(", ")}>
      {parts.map(([key, n]) => (n > 0 ? <span key={key} className={`meter-${key}`} style={{ flexGrow: n }} /> : null))}
    </div>
  );
}

/** Copies text, with the older method as a fallback when the clipboard API is refused. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      area.remove();
    }
  }
}

function CopyQuestions({ t }: { t: TrialState }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <>
      <button
        className="btn btn-quiet"
        onClick={() => {
          void copyText(questionsFor(t)).then((ok) => {
            setState(ok ? "copied" : "failed");
            if (ok) setTimeout(() => setState("idle"), 2500);
          });
        }}
      >
        {state === "copied" ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
        {state === "copied" ? "Copied" : "Copy questions for my doctor"}
      </button>
      <span className="sr-only" role="status">
        {state === "copied" ? "The questions for this trial were copied." : ""}
      </span>
      {state === "failed" && (
        <pre className="payload copy-fallback" aria-label="Questions for your doctor, to select and copy">
          {questionsFor(t)}
        </pre>
      )}
    </>
  );
}

interface CardProps {
  t: TrialState;
  open: boolean;
  onToggle: () => void;
  canCheck: boolean;
  detailsReady: boolean;
  viaCloud: boolean;
  perCriterion: number;
  searchedNear: string;
  saved: boolean;
  isNew: boolean;
  canAnswer: boolean;
}

function TrialCard({ t, open, onToggle, canCheck, detailsReady, viaCloud, perCriterion, searchedNear, saved, isNew, canAnswer }: CardProps) {
  const { trial } = t;
  const results = t.match?.results ?? [];
  const byRules = results.filter((r) => r.decidedBy === "rules").length;
  const byDevice = results.filter((r) => r.decidedBy === "device-model").length;
  const byCloud = results.filter((r) => r.decidedBy === "cloud-model").length;
  const byPerson = results.filter((r) => r.decidedBy === "person").length;
  const total = t.criteria?.length ?? 0;
  const counts = tally(results);
  const places = placesOf(trial, searchedNear);
  const hasDetails = results.length > 0 && t.status !== "compiling";
  const bodyId = `criteria-${trial.nctId}`;
  const toCheck = Math.min(t.pending, CHECK_BATCH);
  const checkedByModel = results.some((r) => r.decidedBy !== "rules");
  const fit = t.status === "done" ? t.match?.fit : undefined;

  return (
    <article
      id={`trial-${trial.nctId}`}
      className={`card trial status-${t.status} ${fit ? `fit-card-${fit}` : ""} ${open && hasDetails ? "is-open" : ""} ${checkedByModel || t.status === "done" ? "is-checked" : "is-unchecked"}`}
      aria-busy={t.status === "checking" || t.status === "compiling"}
    >
      <header className="trial-head">
        <div className="trial-badges">
          <StatusBadge t={t} detailsReady={detailsReady} />
          {isNew && <span className="tag tag-new">New since your last visit</span>}
          {places.near && <span className="tag tag-near">Has a site near {searchedNear.trim()}</span>}
          <button
            className={`star ${saved ? "is-on" : ""}`}
            aria-pressed={saved}
            aria-label={saved ? `Remove ${trial.title} from my trials` : `Save ${trial.title} to my trials`}
            title={saved ? "In my trials" : "Save to my trials"}
            onClick={() => session.toggleSave(trial.nctId)}
          >
            <Star size={16} aria-hidden="true" />
            <span className="star-label">{saved ? "Saved" : "Save"}</span>
          </button>
        </div>
        <h3>{trial.title}</h3>
        <p className="trial-meta">
          {[trial.sponsor, trial.phases.join("/").replace(/PHASE/g, "Phase "), places.label].filter(Boolean).join(" · ")}
          {" · "}
          <a href={trial.url} target="_blank" rel="noreferrer">
            {trial.nctId} on ClinicalTrials.gov<span aria-hidden="true"> ↗</span>
          </a>
        </p>
      </header>

      {t.status === "error" && <p className="note note-error">{t.error}</p>}

      {total > 0 && (
        <div className="trial-progress">
          <ul className="tally" aria-label="What was found so far">
            <li className="tally-ok">
              <span aria-hidden="true">
                <Check size={11} strokeWidth={3.5} />
              </span>{" "}
              {counts.fits} fit
            </li>
            <li className="tally-open">
              <span aria-hidden="true">
                <HelpCircle size={12} strokeWidth={3} />
              </span>{" "}
              {counts.open} to ask about
            </li>
            <li className="tally-blocker">
              <span aria-hidden="true">
                <X size={11} strokeWidth={3.5} />
              </span>{" "}
              {counts.blockers} may rule it out
            </li>
            <li className="tally-assumed">
              <span aria-hidden="true">
                <Minus size={11} strokeWidth={3.5} />
              </span>{" "}
              {counts.noSign} with no sign in your record
            </li>
            {t.pending > 0 && <li className="tally-pending">{t.pending} not checked yet</li>}
          </ul>
          <FitMeter t={t} />
          {t.checkedOn && <p className="kept-note">Checked on {dayLabel(t.checkedOn)}, kept on this computer.</p>}
        </div>
      )}

      {t.status === "checking" && (
        <p className="checking-line" role="status">
          <span className="dot" aria-hidden="true" />
          {t.batch && t.batch.total > 0 ? (
            viaCloud ? (
              <>Asking the cloud model about {t.batch.total} criteria…</>
            ) : (
              <>
                Checking criterion {Math.min(t.batch.total, t.batch.total - t.batch.left + 1)} of {t.batch.total} on this device,{" "}
                {roughDuration(t.batch.left * perCriterion)} left.
              </>
            )
          ) : (
            <>Starting…</>
          )}
        </p>
      )}

      <div className="actions">
        {canStillCheck(t) && (
          <button
            className={`btn ${bucketOf(t) === "unlikely" ? "btn-quiet" : "btn-primary"}`}
            onClick={() => session.check(trial.nctId)}
            disabled={!canCheck}
          >
            {t.status === "error"
              ? "Try again"
              : t.status === "ready" && t.pending > 0
                ? `Check ${toCheck} ${toCheck === 1 ? "criterion" : "criteria"} ${viaCloud ? "with the cloud model" : "on this device"}`
                : "Check this trial"}
          </button>
        )}
        {t.status === "done" && t.pending > 0 && (
          <button className="btn btn-quiet" onClick={() => session.check(trial.nctId)} disabled={!canCheck}>
            {toCheck === t.pending ? `Check the ${t.pending} left` : `Check ${toCheck} more of the ${t.pending} left`}
          </button>
        )}
        {(t.status === "checking" || t.status === "queued") && (
          <button className="btn btn-quiet" onClick={() => session.stopChecking()}>
            Stop
          </button>
        )}
        {hasDetails && (
          <button className="btn btn-quiet trial-toggle" onClick={onToggle} aria-expanded={open} aria-controls={bodyId}>
            {open ? "Hide the details" : `See the ${results.length} ${results.length === 1 ? "answer" : "answers"}`}
          </button>
        )}
        {t.status === "done" && counts.open + counts.blockers > 0 && <CopyQuestions t={t} />}
        {t.summary === undefined && trial.summary && (
          <button className="btn btn-quiet" onClick={() => void session.summarize(trial.nctId)}>
            Summarise in plain words
          </button>
        )}
        {canStillCheck(t) && !viaCloud && t.status !== "error" && canCheck && (
          <span className="actions-hint">{roughDuration((toCheck || CHECK_BATCH) * perCriterion)} on this computer</span>
        )}
      </div>

      {t.status === "done" && t.pending > 0 && (
        <p className="note">
          {t.match && t.match.counts.blocker > 0
            ? "Checking stopped at the first thing that may rule this trial out."
            : "The most decisive criteria were checked first."}{" "}
          {t.pending} {t.pending === 1 ? "criterion has" : "criteria have"} not been checked yet.
        </p>
      )}
      {t.summary === "loading" && <p className="note">Summarising the public description…</p>}
      {t.summary && t.summary !== "loading" && (
        <div className="summary">
          <ul>
            {t.summary.text
              .split("\n")
              .map((l) => l.replace(/^[-*•]\s*/, "").trim())
              .filter(Boolean)
              .map((l, i) => (
                <li key={i}>{l}</li>
              ))}
          </ul>
          <SourceBadge e={t.summary} />
        </div>
      )}

      {fit && fit !== "unlikely" && <ContactBlock t={t} searchedNear={searchedNear} />}

      {hasDetails && (
        <div className="trial-body" id={bodyId}>
          <Group
            title="May rule this trial out"
            nctId={trial.nctId}
            t={t}
            items={results.filter((r) => r.outcome === "blocker")}
            canAnswer={canAnswer}
          />
          <Group
            title="Not in your record"
            hint="Ask your doctor about these, or answer them yourself if you know. They are the open questions for this trial."
            nctId={trial.nctId}
            t={t}
            items={results.filter((r) => r.outcome === "unknown")}
            canAnswer={canAnswer}
          />
          <Group
            title="Fits what your record says"
            nctId={trial.nctId}
            t={t}
            items={results.filter((r) => r.outcome === "ok" && !r.assumed)}
            canAnswer={canAnswer}
          />
          <Group
            title="Nothing in your record suggests these"
            hint="These would rule the trial out if they applied. Your record gives no sign of them, which is not the same as a confirmation."
            nctId={trial.nctId}
            t={t}
            items={results.filter((r) => r.assumed)}
            canAnswer={canAnswer}
          />
          <p className="provenance">
            How this trial was checked: {total} criteria, {byRules} decided instantly by plain code
            {byDevice > 0 || byCloud === 0 ? `, ${byDevice} judged by the on-device model` : ""}
            {byCloud > 0 ? `, ${byCloud} judged by the cloud model` : ""}
            {byPerson > 0 ? `, ${byPerson} answered by you` : ""}
            {t.pending > 0 ? `, ${t.pending} still to check` : ""}.{" "}
            <span className="tag tag-out">
              {t.origin === "cloud"
                ? "rules compiled in the cloud during this visit"
                : t.origin === "offline-cache"
                  ? "rules from the offline cache"
                  : "rules reused from the shared cache"}
            </span>
          </p>
        </div>
      )}
    </article>
  );
}

const FILTERS: (Bucket | "all")[] = ["all", "worth_discussing", "possible", "unlikely", "unchecked"];

export function TrialList({ s }: { s: SessionState }) {
  const [filter, setFilter] = useState<Bucket | "all">("all");
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const entries = useLedger();

  const canCheck = !s.replay && (s.level === "sample" || s.device === "available");
  // A fictional patient on a browser with no on-device model is judged by the
  // cloud model. The page says so, rather than claiming the work happens here.
  const viaCloud = s.level === "sample" && s.device !== null && s.device !== "available";
  const where = s.query.location.trim() ? ` near ${s.query.location.trim()}` : "";
  // A long record is asked about part by part, so each criterion takes longer.
  const perCriterion = msPerCriterion(entries, s.recordParts);
  const counts = countBuckets(s.trials);
  const remaining = s.trials.filter(canStillCheck).length;
  const busy = s.trials.some((t) => t.status === "checking" || t.status === "queued");
  const checked = s.trials.filter((t) => t.status === "done").length;
  const shown = orderForReading(s.trials, busy || Boolean(s.replay && !s.replay.finished)).filter((t) => filter === "all" || bucketOf(t) === filter);
  // New since the last visit kept on this computer: never seen in an earlier visit.
  const isNew = (nctId: string) => Boolean(s.lastVisit) && !s.seenBefore[nctId];
  const newCount = s.trials.filter((t) => isNew(t.trial.nctId)).length;
  // The first trial the model answers about opens by itself; the others stay folded until asked.
  const firstAnswered = s.trials.find((t) => t.status === "checking" || (t.match?.results ?? []).some((r) => r.decidedBy !== "rules"))?.trial.nctId;

  return (
    <>
      <section className="results-head">
        <p className="print-only print-note">
          Prepared with OneWay on {new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}. This is not a
          medical decision: only a trial team can say who may join a trial.
        </p>
        <h2 data-phase-title tabIndex={-1}>
          {s.trials.length} recruiting {s.trials.length === 1 ? "trial" : "trials"} for “{s.query.condition}”{where}
        </h2>
        {viaCloud ? (
          <p>
            Each trial's public rules are prepared in the cloud once and shared. This browser has no on-device model, so this fictional
            record is compared with them by the cloud model. A real record is only ever compared on the device.
          </p>
        ) : (
          <p>
            Each trial's public rules are prepared in the cloud once and shared. Your record is then compared with them here, one criterion
            at a time, so answers appear as they are ready.
          </p>
        )}
      </section>

      {s.trials.length > 0 && (
        <section className="card overview no-print" aria-label="Overview">
          <div className="tiles" role="group" aria-label="Show">
            {FILTERS.map((f) => {
              const n = f === "all" ? s.trials.length : counts[f];
              return (
                <button
                  key={f}
                  className={`tile tile-${f} ${filter === f ? "is-on" : ""}`}
                  aria-pressed={filter === f}
                  onClick={() => setFilter(filter === f ? "all" : f)}
                  disabled={n === 0 && f !== "all"}
                >
                  <CountUp className="tile-number" value={n} />
                  <span className="tile-label">{f === "all" ? "All trials" : BUCKET_LABEL[f]}</span>
                </button>
              );
            })}
          </div>
          <p className="overview-line" role="status">
            <strong>
              {checked} of {s.trials.length} checked.
            </strong>{" "}
            {newCount > 0 && <span className="tag tag-new">{newCount} new since your last visit</span>}{" "}
            {busy
              ? "Trials are checked one after another. You can keep reading while it runs."
              : remaining > 0
                ? "Check the trials that interest you, or all of them."
                : "Every trial on this list has been checked."}
          </p>
          <div className="actions keep-in-replay">
            {remaining > 0 && !busy && (
              <button className="btn btn-primary live-only" onClick={() => session.checkAll()} disabled={!canCheck}>
                <ListChecks size={17} aria-hidden="true" />
                Check all {remaining} remaining
              </button>
            )}
            {busy && (
              <button className="btn btn-quiet live-only" onClick={() => session.stopChecking()}>
                Stop checking
              </button>
            )}
            <button className="btn btn-quiet" onClick={() => window.print()}>
              <Printer size={16} aria-hidden="true" />
              Print a summary for my doctor
            </button>
            <button className="btn btn-quiet live-only" onClick={() => session.backToSearch()}>
              <Search size={16} aria-hidden="true" />
              Change the search words
            </button>
            {remaining > 0 && !busy && !viaCloud && canCheck && (
              <span className="actions-hint">{roughDuration(CHECK_BATCH * perCriterion)} per trial on this computer. You can stop at any time.</span>
            )}
          </div>
        </section>
      )}

      {checked > 0 && <RememberOffer s={s} />}
      <MyTrials s={s} />

      {s.trials.length === 0 && (
        <section className="card">
          <p>No recruiting trial matched these words. Try a more general condition name, or remove the location.</p>
          <div className="actions">
            {s.query.location.trim() && !s.replay && (
              <button className="btn btn-primary" onClick={() => void session.searchWithoutPlace()}>
                Search everywhere, without “{s.query.location.trim()}”
              </button>
            )}
            <button className={`btn ${s.query.location.trim() && !s.replay ? "btn-quiet" : "btn-primary"}`} onClick={() => session.backToSearch()}>
              Change the search words
            </button>
            <button className="btn btn-quiet" onClick={() => session.reset()}>
              Start over
            </button>
          </div>
        </section>
      )}

      {s.trials.length > 0 && shown.length === 0 && (
        <section className="card">
          <p>No trial is in this group yet.</p>
          <div className="actions">
            <button className="btn btn-quiet" onClick={() => setFilter("all")}>
              Show all trials
            </button>
          </div>
        </section>
      )}

      {shown.map((t) => {
        const id = t.trial.nctId;
        const open = toggled[id] ?? id === firstAnswered;
        return (
          <TrialCard
            key={id}
            t={t}
            open={open}
            onToggle={() => setToggled((cur) => ({ ...cur, [id]: !open }))}
            canCheck={canCheck}
            detailsReady={s.detailsReady}
            viaCloud={viaCloud}
            perCriterion={perCriterion}
            searchedNear={s.query.location}
            saved={Boolean(s.saved[id])}
            isNew={isNew(id)}
            canAnswer={!s.replay}
          />
        );
      })}

      {(s.screenedOut.length > 0 || s.observational.length > 0) && (
        <details className="card set-aside">
          <summary>
            {s.screenedOut.length + s.observational.length} set aside on this device, without asking the registry about you
          </summary>
          <ul>
            {s.screenedOut.map(({ trial, reason }) => (
              <li key={trial.nctId}>
                <a href={trial.url} target="_blank" rel="noreferrer">
                  {trial.nctId}
                </a>{" "}
                {trial.title} <span className="tag tag-rules">{reason}</span>
              </li>
            ))}
            {s.observational.map((trial) => (
              <li key={trial.nctId}>
                <a href={trial.url} target="_blank" rel="noreferrer">
                  {trial.nctId}
                </a>{" "}
                {trial.title} <span className="tag">observational study, no treatment tested</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

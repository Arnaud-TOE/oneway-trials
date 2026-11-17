import { ArrowRight, Cpu, Eye, FileUp, History, Play, Quote, Sparkles, UserRound } from "lucide-react";
import { EXAMPLE_READY } from "./recorded/ready";
import { SAMPLES } from "./samples";
import { dayLabel } from "./memory";
import { MyTrials } from "./MyTrials";
import { session, type SessionState } from "./session";

/**
 * The one-way flow, drawn: public trial rules fall from the cloud into this
 * computer, where the record stays; the way up is closed. The motion stops
 * for people who ask their system for less motion.
 */
function OneWayIllustration() {
  return (
    <svg className="illustration" viewBox="0 -18 420 400" role="img" aria-labelledby="ill-title ill-desc">
      <title id="ill-title">The one-way flow</title>
      <desc id="ill-desc">Public trial rules come down from the cloud to your computer. Your record stays on your computer and never goes up.</desc>

      {/* The cloud */}
      <g className="ill-cloud">
        <path d="M118 92c-24 0-42-17-42-38s18-38 42-38c6-14 22-24 40-24 16 0 30 8 38 20 5-2 11-3 17-3 26 0 46 20 46 44 0 22-18 39-41 39z" />
        <text x="168" y="62" textAnchor="middle">
          Public trial rules
        </text>
      </g>

      {/* Rules coming down */}
      <path className="ill-lane" d="M168 104 V 220" />
      <g className="ill-chip ill-chip-1">
        <rect x="140" y="104" width="56" height="34" rx="7" />
        <line x1="149" y1="115" x2="187" y2="115" />
        <line x1="149" y1="125" x2="177" y2="125" />
      </g>
      <g className="ill-chip ill-chip-2">
        <rect x="140" y="104" width="56" height="34" rx="7" />
        <line x1="149" y1="115" x2="183" y2="115" />
        <line x1="149" y1="125" x2="171" y2="125" />
      </g>
      <g className="ill-chip ill-chip-3">
        <rect x="140" y="104" width="56" height="34" rx="7" />
        <line x1="149" y1="115" x2="187" y2="115" />
        <line x1="149" y1="125" x2="165" y2="125" />
      </g>

      {/* The way up is closed */}
      <path className="ill-up" d="M318 236 V 120" markerEnd="url(#ill-arrow)" />
      <defs>
        <marker id="ill-arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" className="ill-up-head" />
        </marker>
      </defs>
      <g className="ill-stop">
        <circle cx="318" cy="176" r="19" />
        <line x1="305" y1="189" x2="331" y2="163" />
      </g>
      <text className="ill-up-label" x="346" y="172">
        never
      </text>
      <text className="ill-up-label" x="346" y="188">
        goes up
      </text>

      {/* This computer */}
      <g className="ill-device">
        <rect x="64" y="224" width="300" height="122" rx="14" />
        <rect className="ill-screen-bar" x="64" y="224" width="300" height="24" rx="14" />
        <circle cx="82" cy="236" r="4" />
        <circle cx="96" cy="236" r="4" />
        <circle cx="110" cy="236" r="4" />
      </g>
      <g className="ill-doc">
        <path d="M252 262h44l16 16v54a6 6 0 0 1-6 6h-54a6 6 0 0 1-6-6v-64a6 6 0 0 1 6-6z" />
        <line x1="258" y1="290" x2="298" y2="290" />
        <line x1="258" y1="302" x2="298" y2="302" />
        <line x1="258" y1="314" x2="284" y2="314" />
      </g>
      <g className="ill-lock">
        <rect x="290" y="312" width="30" height="24" rx="5" />
        <path d="M296 312v-6a9 9 0 0 1 18 0v6" />
      </g>
      <g className="ill-match">
        <rect className="ill-match-row" x="90" y="262" width="138" height="20" rx="6" />
        <rect className="ill-match-row ill-match-2" x="90" y="288" width="138" height="20" rx="6" />
        <rect className="ill-match-row ill-match-3" x="90" y="314" width="138" height="20" rx="6" />
        <text className="ill-tick" x="100" y="277">
          ✓
        </text>
        <text className="ill-tick ill-match-2" x="100" y="303">
          ✓
        </text>
        <text className="ill-tick ill-q ill-match-3" x="100" y="329">
          ?
        </text>
      </g>
      <text className="ill-caption" x="214" y="370" textAnchor="middle">
        Your computer: your record, read and compared here
      </text>
    </svg>
  );
}

function scrollToRecord() {
  document.getElementById("record-title")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function Hero({ s }: { s: SessionState }) {
  return (
    <section className="hero bento" aria-labelledby="hero-title">
      <div className="bento-cell bento-intro">
        <p className="hero-eyebrow">
          <Sparkles size={14} aria-hidden="true" />
          Private by design · Gemini Nano runs in your browser
        </p>
        <h1 id="hero-title">
          Find clinical trials <em>without handing over</em> your medical record.
        </h1>
        <p className="lede">
          OneWay reads your record on this computer and checks it against the rules of recruiting trials. Public rules come down from the
          cloud. Your record never goes up.
        </p>
        {!s.returning && (
          <div className="hero-actions">
            <button className="btn btn-primary btn-large" onClick={scrollToRecord}>
              <FileUp size={18} aria-hidden="true" />
              Add my record
              <ArrowRight size={18} aria-hidden="true" className="btn-arrow" />
            </button>
            <button
              className="btn btn-glass btn-large"
              onClick={() => {
                session.useSample(SAMPLES[0]);
                scrollToRecord();
              }}
            >
              <UserRound size={18} aria-hidden="true" />
              Try a fictional patient
            </button>
          </div>
        )}
        {EXAMPLE_READY && !s.returning && (
          <button className="link hero-watch" onClick={() => void session.playExample()}>
            <Play size={15} aria-hidden="true" />
            {s.device !== null && s.device !== "available"
              ? "No on-device model here? Watch a real run recorded with it"
              : "Watch a real run, recorded with the on-device model"}
          </button>
        )}
      </div>

      <div className="bento-cell bento-art">
        <OneWayIllustration />
      </div>

      <div className="bento-cell bento-proof">
        <span className="bento-icon" aria-hidden="true">
          <Cpu size={20} />
        </span>
        <h3>Read on your computer</h3>
        <p>Chrome's built-in model reads your record, photos and scans on this computer. No file is uploaded.</p>
      </div>
      <div className="bento-cell bento-proof">
        <span className="bento-icon" aria-hidden="true">
          <Eye size={20} />
        </span>
        <h3>You approve every word</h3>
        <p>Only a condition name and a city go to the public registry, and you see them first.</p>
      </div>
      <div className="bento-cell bento-proof">
        <span className="bento-icon" aria-hidden="true">
          <Quote size={20} />
        </span>
        <h3>Every answer quotes you</h3>
        <p>Each “yes” or “no” shows the words of your record it rests on, so you can check it.</p>
      </div>
      <div className="bento-cell bento-stat">
        <p className="stat-number">
          84<span>%</span>
        </p>
        <p>
          same answer as physicians, on 120 cases it had never seen, from a public NIH dataset. <span className="stat-sub">GPT-4 in the cloud: 93.5%.</span>
        </p>
      </div>
    </section>
  );
}

/** Shown when the person asked OneWay to keep their last visit on this computer. */
export function WelcomeBack({ s }: { s: SessionState }) {
  const r = s.returning;
  if (!r) return null;
  const savedCount = Object.keys(s.saved).length;
  const what = r.condition ? `“${r.condition}”${r.location ? ` near ${r.location}` : ""}` : "trials";
  return (
    <section className="card welcome" aria-labelledby="welcome-title">
      <div className="welcome-head">
        <span className="welcome-mark" aria-hidden="true">
          <History size={22} />
        </span>
        <div>
          <h2 id="welcome-title" data-phase-title tabIndex={-1}>
            Welcome back
          </h2>
          <p className="note">
            On {dayLabel(r.savedAt)} you looked for {what}
            {r.sample ? " with a fictional patient" : r.documents.length ? `, from ${r.documents.join(", ")}` : ""}.
            {savedCount > 0 ? ` You saved ${savedCount} ${savedCount === 1 ? "trial" : "trials"}.` : ""}
          </p>
        </div>
      </div>
      <p>
        New trials open every week. Your record is kept on this computer, so it does not need to be read again: approve the search and
        OneWay shows what is new since your last visit.
      </p>
      <div className="actions">
        <button className="btn btn-primary btn-large" onClick={() => session.continueFromLastVisit()}>
          <Sparkles size={18} aria-hidden="true" />
          Look for new trials
          <ArrowRight size={18} aria-hidden="true" className="btn-arrow" />
        </button>
        <button className="btn btn-quiet" onClick={() => session.startOver()}>
          Start with another record
        </button>
        <button
          className="link"
          onClick={() => {
            if (window.confirm("Delete your record, your results and your list from this computer? This cannot be undone.")) void session.forgetEverything();
          }}
        >
          Delete everything kept here
        </button>
      </div>
      {savedCount > 0 && <MyTrials s={s} compact />}
    </section>
  );
}

export function HowItWorks() {
  return (
    <section className="how" aria-labelledby="how-title">
      <h2 id="how-title">How your record stays private</h2>
      <ol className="how-steps">
        <li>
          <span className="how-num">1</span>
          <div>
            <strong>Read here.</strong> Chrome's built-in model reads your record on this computer. Photos and scans are read here too.
          </div>
        </li>
        <li>
          <span className="how-num">2</span>
          <div>
            <strong>You approve what leaves.</strong> Two or three words, such as “breast cancer” and a city, go to the public trial registry.
            You see them first and can change them.
          </div>
        </li>
        <li>
          <span className="how-num">3</span>
          <div>
            <strong>Compared here.</strong> Each trial's public rules come down and are checked against your record on this computer, with the
            words from your record that justify each answer.
          </div>
        </li>
      </ol>
    </section>
  );
}

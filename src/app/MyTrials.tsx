import { CalendarPlus, ShieldCheck, Star } from "lucide-react";
import { FOLLOW_UP_LABEL, type FollowUp } from "./memory";
import { session, type SessionState } from "./session";

const FOLLOW_UPS = Object.keys(FOLLOW_UP_LABEL) as FollowUp[];

function goToTrial(nctId: string) {
  const el = document.getElementById(`trial-${nctId}`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  el.classList.add("is-flash");
  setTimeout(() => el.classList.remove("is-flash"), 1600);
}

/**
 * The person's own list of trials: what to raise with their doctor, what was
 * discussed, which study team was contacted, with a note for each. It lives in
 * this page, and on this computer only if the person asked for that.
 */
export function MyTrials({ s, compact = false }: { s: SessionState; compact?: boolean }) {
  const items = Object.values(s.saved).sort((a, b) => a.savedAt.localeCompare(b.savedAt));
  if (items.length === 0) return null;
  const listed = new Set(s.trials.map((t) => t.trial.nctId));
  return (
    <section className={`my-trials ${compact ? "is-compact" : "card"}`} aria-labelledby="my-trials-title">
      <div className="card-head-row">
        <h3 id="my-trials-title">
          <Star size={18} aria-hidden="true" className="my-star" />
          My trials <span className="count">{items.length}</span>
        </h3>
        {!compact && (
          <button className="btn btn-quiet btn-small" onClick={() => session.downloadReminder(14)}>
            <CalendarPlus size={15} aria-hidden="true" />
            Remind me in 2 weeks
          </button>
        )}
      </div>
      <ul className="my-list">
        {items.map((item) => {
          const inList = listed.has(item.nctId);
          return (
            <li key={item.nctId} className={`my-item follow-${item.followUp}`}>
              <div className="my-item-head">
                {inList ? (
                  <button className="link my-title" onClick={() => goToTrial(item.nctId)}>
                    {item.title}
                  </button>
                ) : (
                  <a className="my-title" href={item.url} target="_blank" rel="noreferrer">
                    {item.title}
                    <span aria-hidden="true"> ↗</span>
                  </a>
                )}
                <button className="star is-on" aria-pressed="true" aria-label={`Remove ${item.title} from my trials`} onClick={() => session.toggleSave(item.nctId)}>
                  <Star size={16} aria-hidden="true" />
                </button>
              </div>
              <p className="my-meta">
                {item.nctId}
                {item.place ? ` · ${item.place}` : ""}
                {!compact && s.phase === "results" && !inList ? " · not in today's list of recruiting trials for this search" : ""}
              </p>
              <div className="my-controls">
                <label className="sr-only" htmlFor={`follow-${item.nctId}`}>
                  Where you are with this trial
                </label>
                <select id={`follow-${item.nctId}`} value={item.followUp} onChange={(e) => session.setFollowUp(item.nctId, e.target.value as FollowUp)}>
                  {FOLLOW_UPS.map((f) => (
                    <option key={f} value={f}>
                      {FOLLOW_UP_LABEL[f]}
                    </option>
                  ))}
                </select>
                <label className="sr-only" htmlFor={`note-${item.nctId}`}>
                  Your note
                </label>
                <textarea
                  id={`note-${item.nctId}`}
                  rows={1}
                  placeholder="Your note: what your doctor said, who you called…"
                  value={item.note}
                  onChange={(e) => session.setNote(item.nctId, e.target.value)}
                />
              </div>
            </li>
          );
        })}
      </ul>
      {!s.remember && !compact && (
        <p className="note">This list is lost when you leave the page, unless you keep it on this computer.</p>
      )}
    </section>
  );
}

/** Offers to keep the visit on this computer, once there is something worth coming back to. */
export function RememberOffer({ s }: { s: SessionState }) {
  if (s.remember || s.rememberDeclined || s.replay) return null;
  return (
    <section className="card remember" aria-labelledby="remember-title">
      <div>
        <h3 id="remember-title">Come back without starting over?</h3>
        <p>
          OneWay can keep your record, these results and your list in this browser, on this computer. Next time it will not need to read your
          record again, and it will show which trials are new. Nothing is sent anywhere. Anyone who uses this browser on this computer could
          open it, and you can delete it at any time.
        </p>
      </div>
      <div className="actions">
        <button className="btn btn-primary" onClick={() => session.rememberHere()}>
          <ShieldCheck size={17} aria-hidden="true" />
          Keep it on this computer
        </button>
        <button className="btn btn-quiet" onClick={() => session.declineRemember()}>
          Not now
        </button>
      </div>
    </section>
  );
}

import {
  CalendarPlus,
  Cpu,
  FileUp,
  ListChecks,
  type LucideIcon,
  Monitor,
  Moon,
  Printer,
  RotateCcw,
  Search,
  Sparkles,
  Star,
  Sun,
  Trash2,
  UserRound,
  CircleStop,
  Play,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { EXAMPLE_READY } from "./recorded/ready";
import { SAMPLES } from "./samples";
import { session, type SessionState } from "./session";
import { setTheme } from "./theme";

interface Action {
  id: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  run: () => void;
}

function scrollTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** What can be done from where the person is. */
function actionsFor(s: SessionState): Action[] {
  const list: Action[] = [];
  const replay = Boolean(s.replay);
  if (s.phase === "start" && !replay) {
    if (s.returning) list.push({ id: "continue", label: "Look for new trials", hint: "Your last visit", icon: Sparkles, run: () => session.continueFromLastVisit() });
    list.push({
      id: "file",
      label: "Add a document",
      hint: "PDF, photo, Word or text",
      icon: FileUp,
      run: () => {
        if (s.returning) session.startOver();
        setTimeout(() => document.getElementById("file-input")?.click(), 50);
      },
    });
    for (const p of SAMPLES) {
      list.push({
        id: `sample-${p.id}`,
        label: `Try ${p.name.split(",")[0]}, a fictional patient`,
        hint: p.blurb,
        icon: UserRound,
        run: () => {
          if (s.returning) session.startOver();
          session.useSample(p);
          setTimeout(() => scrollTo("record-title"), 50);
        },
      });
    }
    if (s.record.trim()) list.push({ id: "read", label: "Read my record", hint: "On this computer", icon: Cpu, run: () => void session.read() });
    if (EXAMPLE_READY) {
      list.push({ id: "example", label: "Watch a recorded run", hint: "Made with the on-device model", icon: Play, run: () => void session.playExample() });
    }
  }
  if (s.phase === "results" && !replay) {
    const busy = s.trials.some((t) => t.status === "checking" || t.status === "queued");
    if (busy) list.push({ id: "stop", label: "Stop checking", icon: CircleStop, run: () => session.stopChecking() });
    else list.push({ id: "all", label: "Check every trial", icon: ListChecks, run: () => session.checkAll() });
    if (Object.keys(s.saved).length > 0) list.push({ id: "mine", label: "Go to my trials", icon: Star, run: () => scrollTo("my-trials-title") });
    list.push({ id: "print", label: "Print a summary for my doctor", icon: Printer, run: () => window.print() });
    list.push({ id: "remind", label: "Remind me in 2 weeks", hint: "Calendar file", icon: CalendarPlus, run: () => session.downloadReminder(14) });
    list.push({ id: "words", label: "Change the search words", icon: Search, run: () => session.backToSearch() });
  }
  if (s.phase !== "start") list.push({ id: "over", label: "Start over", icon: RotateCcw, run: () => session.reset() });
  list.push({ id: "light", label: "Light theme", icon: Sun, run: () => setTheme("light") });
  list.push({ id: "dark", label: "Dark theme", icon: Moon, run: () => setTheme("dark") });
  list.push({ id: "system", label: "Theme of my system", icon: Monitor, run: () => setTheme("system") });
  if (s.remember) {
    list.push({
      id: "forget",
      label: "Delete everything kept on this computer",
      icon: Trash2,
      run: () => {
        if (window.confirm("Delete your record, your results and your list from this computer? This cannot be undone.")) void session.forgetEverything();
      },
    });
  }
  return list;
}

export function CommandPalette({ s, open, onClose }: { s: SessionState; open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const all = useMemo(() => actionsFor(s), [s]);
  const shown = all.filter((a) => `${a.label} ${a.hint ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    const t = setTimeout(() => input.current?.focus(), 10);
    return () => clearTimeout(t);
  }, [open]);

  if (!open) return null;

  const run = (a: Action | undefined) => {
    if (!a) return;
    onClose();
    a.run();
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Actions"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => Math.min(shown.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            run(shown[active]);
          }
        }}
      >
        <div className="palette-input">
          <Search size={18} aria-hidden="true" />
          <input
            ref={input}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            placeholder="What do you want to do?"
            aria-label="Search actions"
            aria-controls="palette-list"
            aria-activedescendant={shown[active] ? `palette-${shown[active].id}` : undefined}
          />
          <kbd>Esc</kbd>
        </div>
        <ul id="palette-list" className="palette-list" role="listbox">
          {shown.length === 0 && <li className="palette-empty">Nothing matches.</li>}
          {shown.map((a, i) => {
            const Icon = a.icon;
            return (
              <li
                key={a.id}
                id={`palette-${a.id}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? "is-active" : ""}
                onMouseEnter={() => setActive(i)}
                onClick={() => run(a)}
              >
                <span className="palette-icon" aria-hidden="true">
                  <Icon size={17} />
                </span>
                <span className="palette-label">{a.label}</span>
                {a.hint && <span className="palette-hint">{a.hint}</span>}
              </li>
            );
          })}
        </ul>
        <p className="palette-foot">
          <kbd>↑</kbd> <kbd>↓</kbd> to move · <kbd>Enter</kbd> to run
        </p>
      </div>
    </div>
  );
}

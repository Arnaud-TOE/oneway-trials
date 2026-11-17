import { useSyncExternalStore } from "react";
import { compileTrial, type CompileOutcome } from "../engine/compile";
import {
  appendToRecord,
  carefulReadingMs,
  cleanTranscript,
  compareReadings,
  docxToText,
  dropRepeatedLines,
  kindOf,
  MAX_FILE_BYTES,
  MAX_PDF_PAGES,
  plural,
  removeFromRecord,
  tidyText,
  unsupportedReason,
  type DocumentKind,
} from "../engine/documents";
import { explainCriterion, summarizeTrial, type Explained } from "../engine/explain";
import { MAX_SEMANTIC_PER_TRIAL } from "../engine/judge";
import { ledger } from "../engine/ledger";
import { matchTrial, withPersonAnswers, type PersonAnswer } from "../engine/match";
import { readableParts } from "../engine/parts";
import { LeakError, privacyGuard } from "../engine/privacy";
import { buildProfile, extractBasics, extractDetails, NO_DETAILS } from "../engine/profile";
import { transcribeImage, type PageImage } from "../engine/transcribe";
import { isInterventional, prefilter, searchTrials } from "../engine/trials";
import type { CompiledCriterion, CriterionResult, Profile, RecordLevel, Trial, TrialMatch } from "../engine/types";
import { deviceAvailability, isAbort, prepareDeviceModel, type DeviceAvailability } from "../lib/hybrid";
import { looksUrgent } from "./safety";
import { applyEntry, delayFor, initialView, toRecording, type Recording } from "./recording";
import type { SamplePatient } from "./samples";
import { criteriaSignature, forgetMemory, keptAnswers, loadMemory, saveMemory, type FollowUp, type Memory, type SavedTrial } from "./memory";
import { toast } from "./toast";
import { placesOf, reminderIcs, roughDuration, suggestedLocation } from "./view";

export type Phase = "start" | "reading" | "review" | "searching" | "results";

/** Criteria the on-device model is asked about per click. */
export const CHECK_BATCH = MAX_SEMANTIC_PER_TRIAL;

/** Shortest text worth reading as a record. */
export const MIN_RECORD_CHARS = 40;

export interface TrialState {
  trial: Trial;
  status: "waiting" | "compiling" | "ready" | "queued" | "checking" | "done" | "error";
  origin?: CompileOutcome["origin"];
  criteria?: CompiledCriterion[];
  /** What is shown: code and model results, with the person's own answers laid over them. Partial while checking. */
  match?: TrialMatch;
  /** Code and model results only, so an answer of the person can be taken back. */
  raw?: TrialMatch;
  /** Criteria not yet decided by code, the model or the person. */
  pending: number;
  /** Set when the model's answers come from an earlier visit, kept on this computer. */
  checkedOn?: string;
  /** While checking: how many criteria this pass asks the model, and how many are left. */
  batch?: { total: number; left: number };
  error?: string;
  summary?: Explained | "loading";
  explanations: Record<string, Explained | "loading">;
}

/** A file the person added. It is opened in this page and never uploaded. */
export interface ImportedDocument {
  id: number;
  name: string;
  kind: DocumentKind | null;
  status: "waiting" | "reading" | "done" | "error";
  /** One line under the name: what is happening, what was read, or what went wrong. */
  detail: string;
  /** The text this document added to the record, so it can be taken out again. */
  text: string;
  /** True when the text was read from pixels: the person should check the numbers. */
  transcribed: boolean;
  /** Text of a photo or scanned page as the on-device model writes it. */
  preview: string;
  /** While the careful reading runs: the quick reading, and how many numbers in it the quick reader is unsure of. */
  quick?: { text: string; unsure: number };
  /** True when the person took the quick reading instead of the careful one. */
  usedQuick?: boolean;
  /** Lines where the quick and the careful readings disagree on a number: to check against the document. */
  check?: string[];
}

export interface SessionState {
  phase: Phase;
  level: RecordLevel;
  sampleId: string | null;
  record: string;
  documents: ImportedDocument[];
  urgent: boolean;
  /** When the current reading pass started, for the elapsed-time display. */
  readingSince: number | null;
  /** The person asked to read the record while documents were still being opened: it starts when they are. */
  readWhenReady: boolean;
  /** While a long record is read in parts: which part. Null for a record read in one go. */
  readingPart: { part: number; parts: number } | null;
  /** Parts the record is read in: 1 for most records. */
  recordParts: number;
  /** False while the second pass (treatments and lab values) is still running. */
  detailsReady: boolean;
  profile: Profile | null;
  query: { condition: string; location: string };
  trials: TrialState[];
  screenedOut: { trial: Trial; reason: string }[];
  observational: Trial[];
  device: DeviceAvailability | null;
  download: number | null;
  online: boolean;
  error: string | null;
  /** Set while a recorded run is being shown. Nothing is computed or sent during a replay. */
  replay: { recordedAt: string; environment: string; finished: boolean } | null;
  /** True when the person asked OneWay to keep their record, results and list on this computer. */
  remember: boolean;
  /** True when the person said no to keeping anything: the question is not asked again in this visit. */
  rememberDeclined: boolean;
  /** Shown on the start screen when something was kept from an earlier visit. */
  returning: { savedAt: string; condition: string; location: string; documents: string[]; sample: boolean } | null;
  /** When the previous visit was kept, to point out what is new since. */
  lastVisit: string | null;
  /** When each trial was first seen in earlier visits. */
  seenBefore: Record<string, string>;
  /** The person's list of trials, with their own follow-up and notes. */
  saved: Record<string, SavedTrial>;
  /** The person's own answers to open questions, by trial and criterion. */
  answers: Record<string, Record<string, PersonAnswer>>;
}

/** Facts the person may correct by hand after the record was read. */
export type ProfileCorrection = Partial<Pick<Profile, "age" | "sex" | "ecog">>;

/** Trials compiled automatically after a search. The rest are compiled when asked for. */
const AUTO_COMPILE = 6;

const initial = (): SessionState => ({
  phase: "start",
  level: "private",
  sampleId: null,
  record: "",
  documents: [],
  urgent: false,
  readingSince: null,
  readingPart: null,
  recordParts: 1,
  readWhenReady: false,
  detailsReady: false,
  profile: null,
  query: { condition: "", location: "" },
  trials: [],
  screenedOut: [],
  observational: [],
  device: null,
  download: null,
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  error: null,
  replay: null,
  remember: false,
  rememberDeclined: false,
  returning: null,
  lastVisit: null,
  seenBefore: {},
  saved: {},
  answers: {},
});

const NO_IMAGE_MODEL =
  "Reading a photo or a scanned page needs the on-device model, which is not ready in this browser. Nothing was sent anywhere. You can paste the text instead.";

function message(e: unknown): string {
  if (e instanceof LeakError) return e.message;
  if (e instanceof Error) {
    if (/ONLY_ON_DEVICE|not available|API_NOT_ENABLED|api-not-enabled|unable to create a session/i.test(e.message)) {
      return "The on-device model is not available in this browser, so your record was not read. Nothing was sent anywhere.";
    }
    if (/\b429\b|quota|RESOURCE_EXHAUSTED/i.test(e.message)) {
      return "The cloud model's free quota is used up for the moment. Nothing is wrong with your record. Wait a minute and try this trial again.";
    }
    if (/app check|appcheck|401|403/i.test(e.message)) {
      return "The cloud service could not confirm that this request comes from the real OneWay app (App Check), so it refused it. This can happen in automated, embedded or heavily locked-down browsers. Try again in a regular Chrome window.";
    }
    if (/high demand|overloaded|\b50[0234]\b|UNAVAILABLE/i.test(e.message)) {
      return "The cloud model is very busy right now (Google reports high demand), even after several tries. Nothing is wrong with your record. Try again in a minute.";
    }
    if (/failed to fetch|networkerror|load failed/i.test(e.message)) {
      return "The network request did not go through. Check your connection and try again. Your record was not involved: it never leaves this device.";
    }
    return e.message;
  }
  return String(e);
}

/** Where a trial stands once nothing is running on it. */
function restingStatus(t: TrialState): TrialState["status"] {
  if (!t.criteria) return "waiting";
  const askedModel = (t.raw?.results ?? []).some((r) => r.decidedBy !== "rules");
  return askedModel || t.pending === 0 ? "done" : "ready";
}

interface ViewTransitionLike {
  ready?: Promise<unknown>;
  finished?: Promise<unknown>;
  updateCallbackDone?: Promise<unknown>;
}

/** True when the browser can animate a step change, and the person has not asked for less motion. */
function canTransition(): boolean {
  if (typeof document === "undefined" || !("startViewTransition" in document)) return false;
  // A hidden tab draws no frames: the transition could only time out.
  if (document.visibilityState !== "visible") return false;
  try {
    return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Answers given by a model, as opposed to plain code or the person. */
function isModelAnswer(r: CriterionResult): boolean {
  return r.decidedBy === "device-model" || r.decidedBy === "cloud-model";
}

class Session {
  private state = initial();
  private listeners = new Set<() => void>();
  /** Bumped on reset so stale async work stops touching the state. */
  private run = 0;
  private queue: string[] = [];
  private working = false;
  /** Resolves when the second pass over the record has finished. */
  private details: Promise<void> = Promise.resolve();
  /** Stops the model calls that read the record. */
  private readAbort: AbortController | null = null;
  /** Stops the trial being checked. */
  private checkAbort: AbortController | null = null;
  /** Documents are opened one at a time: the on-device model does one thing at a time. */
  private importing: Promise<void> = Promise.resolve();
  private importAborts = new Map<number, AbortController>();
  /** Stops only the careful reading of a document's image, when the person takes the quick one. */
  private carefulAborts = new Map<number, AbortController>();
  /** Documents whose quick reading the person chose to use. */
  private quickChosen = new Set<number>();
  /** Ends the wait for a careful reading at once, when the person takes the quick one. */
  private quickResolvers = new Map<number, () => void>();
  private nextDocumentId = 1;
  /** Corrections made by hand, kept when the second reading pass rebuilds the profile. */
  private corrections: ProfileCorrection = {};
  /** Counts searches, so work started for an earlier list of trials stops. */
  private searches = 0;

  getState = (): SessionState => this.state;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(patch: Partial<SessionState>): void {
    const before = this.state.phase;
    // The state changes at once; only the redraw waits for the view transition.
    this.state = { ...this.state, ...patch };
    const notify = () => {
      for (const l of this.listeners) l();
    };
    const after = this.state.phase;
    const stepChange = after !== before && !(before === "review" && after === "searching") && !(before === "searching" && after === "review");
    if (stepChange && canTransition()) {
      // Chrome's View Transitions API cross-fades one step into the next.
      const transition = (document as Document & { startViewTransition: (cb: () => Promise<void>) => ViewTransitionLike }).startViewTransition(() => {
        notify();
        // Wait for React to draw the new step; never longer than a moment, even if no frame comes.
        return new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
          setTimeout(resolve, 120);
        });
      });
      // An interrupted or skipped animation is harmless: the new step is already drawn.
      for (const p of [transition?.ready, transition?.finished, transition?.updateCallbackDone]) p?.catch(() => {});
    } else {
      notify();
    }
    if (this.state.remember) this.schedulePersist();
  }

  private patchTrial(nctId: string, patch: Partial<TrialState> | ((t: TrialState) => Partial<TrialState>)): void {
    this.set({
      trials: this.state.trials.map((t) => (t.trial.nctId === nctId ? { ...t, ...(typeof patch === "function" ? patch(t) : patch) } : t)),
    });
  }

  private patchDocument(id: number, patch: Partial<ImportedDocument>): void {
    this.set({ documents: this.state.documents.map((d) => (d.id === id ? { ...d, ...patch } : d)) });
  }

  private trial(nctId: string): TrialState | undefined {
    return this.state.trials.find((t) => t.trial.nctId === nctId);
  }

  /** What is shown for a trial: code and model results with the person's answers laid over them. */
  private matchFields(nctId: string, raw: TrialMatch, criteria: CompiledCriterion[]): Pick<TrialState, "raw" | "match" | "pending"> {
    const match = withPersonAnswers(raw, criteria, this.state.answers[nctId]);
    return { raw, match, pending: criteria.length - match.results.length };
  }

  init(): void {
    void this.refreshDevice();
    void this.loadKept();
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => this.set({ online: true }));
      window.addEventListener("offline", () => this.set({ online: false }));
      // A change made just before leaving the page is still kept.
      window.addEventListener("pagehide", () => this.flushPersist());
    }
  }

  // ---------------------------------------------------------------------------
  // Kept on this computer, when the person asks for it (memory.ts).

  /** What was kept from earlier visits, as it was loaded. */
  private kept: Memory | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  private async loadKept(): Promise<void> {
    const memory = await loadMemory();
    if (!memory || this.state.phase !== "start" || this.state.replay) return;
    this.kept = memory;
    this.set({
      remember: true,
      returning: {
        savedAt: memory.savedAt,
        condition: memory.query.condition,
        location: memory.query.location,
        documents: memory.documents,
        sample: memory.level === "sample",
      },
      lastVisit: memory.savedAt,
      seenBefore: memory.seen,
      saved: memory.saved,
      answers: memory.answers,
    });
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, 700);
  }

  /** Builds what is kept from the current state, on top of what was kept before. */
  private snapshot(): Memory | null {
    const s = this.state;
    const base = this.kept;
    const hasRecord = Boolean(s.profile) && s.record.trim().length > 0;
    if (!hasRecord && !base) return null;
    const now = new Date().toISOString();
    const seen = { ...(base?.seen ?? {}) };
    // The model's answers were given about one record: with another record they are dropped.
    const sameRecord = !hasRecord || base?.record === s.record;
    const checks = sameRecord ? { ...(base?.checks ?? {}) } : {};
    for (const t of s.trials) {
      if (!seen[t.trial.nctId]) seen[t.trial.nctId] = now;
      const model = (t.raw?.results ?? []).filter(isModelAnswer);
      if (t.criteria && model.length > 0) {
        checks[t.trial.nctId] = { criteriaSig: criteriaSignature(t.criteria), checkedAt: t.checkedOn ?? now, results: model };
      }
    }
    return {
      version: 1,
      savedAt: now,
      level: hasRecord ? s.level : base!.level,
      sampleId: hasRecord ? s.sampleId : base!.sampleId,
      record: hasRecord ? s.record : base!.record,
      profile: hasRecord ? s.profile! : base!.profile,
      query: hasRecord && s.query.condition.trim() ? s.query : (base?.query ?? s.query),
      documents: hasRecord ? s.documents.filter((d) => d.status === "done").map((d) => d.name) : (base?.documents ?? []),
      seen,
      checks,
      saved: s.saved,
      answers: s.answers,
    };
  }

  private async persist(): Promise<void> {
    if (!this.state.remember || this.state.replay) return;
    const memory = this.snapshot();
    if (!memory) return;
    if (await saveMemory(memory)) this.kept = memory;
  }

  /** The person said yes: keep the record, results and list in this browser. */
  rememberHere(): void {
    if (this.state.replay) return;
    ledger.record({
      lane: "device",
      kind: "memory",
      label: "Kept your record, results and list in this browser, on this computer. Nothing was sent.",
    });
    this.set({ remember: true, rememberDeclined: false });
    void this.persist();
    toast("Kept on this computer. Nothing was sent.", "success");
  }

  declineRemember(): void {
    this.set({ rememberDeclined: true });
  }

  /** Deletes everything kept on this computer. What is on screen stays until the page is left. */
  async forgetEverything(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    await forgetMemory();
    this.kept = null;
    ledger.record({ lane: "device", kind: "memory", label: "Deleted everything OneWay kept in this browser." });
    this.set({ remember: false, rememberDeclined: true, returning: null, lastVisit: null, seenBefore: {}, saved: {}, answers: {} });
    toast("Everything kept on this computer was deleted.", "success");
  }

  /**
   * Picks up from the last visit: the record and what was read from it come
   * back from this computer, so nothing has to be read again. The person still
   * approves the search before it is sent.
   */
  continueFromLastVisit(): void {
    const m = this.kept;
    if (!m || this.state.phase !== "start") return;
    this.stopEverything();
    if (m.level === "private") privacyGuard.registerPrivateText(m.record);
    ledger.record({ lane: "device", kind: "memory", label: "Took up your last visit from this browser. Nothing was read again or sent." });
    this.set({
      phase: "review",
      record: m.record,
      level: m.level,
      sampleId: m.sampleId,
      profile: m.profile,
      detailsReady: true,
      query: m.query,
      recordParts: readableParts(m.record).length,
      documents: m.documents.map((name) => ({
        id: this.nextDocumentId++,
        name,
        kind: kindOf(name, ""),
        status: "done",
        detail: "kept on this computer from your last visit",
        text: "",
        transcribed: false,
        preview: "",
      })),
      returning: null,
      error: null,
    });
  }

  /** Starts with another record. What was kept stays until a new one replaces it, or the person deletes it. */
  startOver(): void {
    this.set({ returning: null });
  }

  toggleSave(nctId: string): void {
    const t = this.trial(nctId);
    const saved = { ...this.state.saved };
    if (saved[nctId]) {
      delete saved[nctId];
      toast("Removed from My trials.");
    } else if (t) {
      toast("Saved to My trials.", "success");
      saved[nctId] = {
        nctId,
        title: t.trial.title,
        url: t.trial.url,
        savedAt: new Date().toISOString(),
        followUp: "to-discuss",
        note: "",
        place: placesOf(t.trial, this.state.query.location).label,
      };
    }
    this.set({ saved });
  }

  setFollowUp(nctId: string, followUp: FollowUp): void {
    const item = this.state.saved[nctId];
    if (item) this.set({ saved: { ...this.state.saved, [nctId]: { ...item, followUp } } });
  }

  setNote(nctId: string, note: string): void {
    const item = this.state.saved[nctId];
    if (item) this.set({ saved: { ...this.state.saved, [nctId]: { ...item, note: note.slice(0, 2000) } } });
  }

  /** The person answers an open question themselves, or takes their answer back (null). */
  answer(nctId: string, criterionId: string, value: PersonAnswer | null): void {
    const forTrial = { ...(this.state.answers[nctId] ?? {}) };
    if (value) forTrial[criterionId] = value;
    else delete forTrial[criterionId];
    const answers = { ...this.state.answers };
    if (Object.keys(forTrial).length > 0) answers[nctId] = forTrial;
    else delete answers[nctId];
    this.set({ answers });
    const t = this.trial(nctId);
    if (t?.raw && t.criteria) {
      const fields = this.matchFields(nctId, t.raw, t.criteria);
      this.patchTrial(nctId, (cur) => ({ ...fields, status: cur.status === "ready" && fields.pending === 0 ? "done" : cur.status }));
    }
  }

  /** A calendar reminder to look again in a few days. It carries no health information. */
  downloadReminder(days = 14): void {
    const at = new Date(Date.now() + days * 86400000);
    const ics = reminderIcs(at, location.origin + location.pathname);
    const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "oneway-reminder.ics";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("Reminder saved: open the file to add it to your calendar.", "success", 4500);
  }

  async refreshDevice(): Promise<void> {
    this.set({ device: await deviceAvailability(false) });
  }

  /** Must be called from a click: Chrome only starts the download on a user gesture. */
  async downloadModel(): Promise<void> {
    this.set({ download: 0, error: null });
    try {
      await prepareDeviceModel((f) => this.set({ download: Math.round(f * 100) }));
      for (let i = 0; i < 720; i++) {
        const a = await deviceAvailability(false);
        this.set({ device: a });
        if (a !== "downloading" && a !== "downloadable") break;
        await new Promise((r) => setTimeout(r, 4000));
      }
    } catch (e) {
      this.set({ error: message(e) });
    }
    this.set({ download: null });
  }

  setRecord(record: string): void {
    // Typing your own text always means a private record.
    this.set({ record, level: "private", sampleId: null, error: null });
  }

  useSample(sample: SamplePatient): void {
    this.dropDocuments();
    this.set({ record: sample.record, level: "sample", sampleId: sample.id, error: null, query: { condition: "", location: sample.location } });
  }

  /** Empties the record box. */
  clearRecord(): void {
    this.dropDocuments();
    this.set({ record: "", level: "private", sampleId: null, error: null, query: { condition: "", location: "" } });
  }

  private dropDocuments(): void {
    for (const c of this.importAborts.values()) c.abort();
    this.importAborts.clear();
    this.quickChosen.clear();
    this.set({ documents: [], readWhenReady: false });
  }

  /**
   * Adds documents picked, dropped or pasted by the person. Each one is opened
   * in this page: plain code reads text, Word and PDF files, and the on-device
   * model reads photos and scanned pages. No file is uploaded.
   */
  addFiles(files: File[]): void {
    if (files.length === 0 || this.state.replay || this.state.phase !== "start") return;
    // A real document takes the place of a fictional patient.
    if (this.state.level === "sample") this.set({ record: "", level: "private", sampleId: null, query: { condition: "", location: "" } });
    const added = files.map((file) => ({
      file,
      doc: {
        id: this.nextDocumentId++,
        name: file.name || "Pasted image",
        kind: kindOf(file.name, file.type),
        status: "waiting",
        detail: "Waiting for its turn…",
        text: "",
        transcribed: false,
        preview: "",
      } satisfies ImportedDocument as ImportedDocument,
    }));
    this.set({ documents: [...this.state.documents, ...added.map((a) => a.doc)], error: null });
    const run = this.run;
    this.importing = this.importing.then(async () => {
      for (const { file, doc } of added) {
        if (run !== this.run) return;
        await this.importOne(file, doc, run);
      }
      this.maybeStartReading();
    });
  }

  private opening(): boolean {
    return this.state.documents.some((d) => d.status === "reading" || d.status === "waiting");
  }

  /** Starts the reading the person asked for, once every document is open. */
  private maybeStartReading(): void {
    if (!this.state.readWhenReady || this.state.phase !== "start" || this.opening()) return;
    this.set({ readWhenReady: false });
    void this.read();
  }

  cancelReadWhenReady(): void {
    this.set({ readWhenReady: false });
  }

  private async importOne(file: File, doc: ImportedDocument, run: number): Promise<void> {
    const present = () => run === this.run && this.state.documents.some((d) => d.id === doc.id);
    if (!present()) return;
    const fail = (detail: string) => this.patchDocument(doc.id, { status: "error", detail, preview: "" });
    if (!doc.kind) return fail(unsupportedReason(doc.name));
    if (file.size === 0) return fail("This file is empty.");
    if (file.size > MAX_FILE_BYTES) return fail("This file is larger than 25 MB. Use a smaller file, or paste the text.");

    const controller = new AbortController();
    this.importAborts.set(doc.id, controller);
    this.patchDocument(doc.id, { status: "reading", detail: "Opening on this computer…" });
    const needImageModel = async () => {
      if ((await deviceAvailability(true)) !== "available") throw new Error(NO_IMAGE_MODEL);
    };
    const check: string[] = [];
    let usedQuick = false;

    /**
     * Reads one image twice, both times on this computer: a quick reading by
     * Tesseract in a second or two, then a careful one by the on-device model.
     * The careful text is the one added; the lines where the two disagree on a
     * number are kept to show the person. The person may take the quick reading
     * instead of waiting, which stops the careful one.
     */
    const readImage = async (image: PageImage, where: string, label: string): Promise<string> => {
      this.patchDocument(doc.id, { detail: `${where}: quick reading…`, preview: "", quick: undefined });
      let quick = "";
      let unsure = 0;
      try {
        const { recognizeText } = await import("./ocr");
        const result = await recognizeText(`data:${image.mimeType};base64,${image.base64}`);
        quick = cleanTranscript(result.text);
        unsure = result.unsureNumbers;
        ledger.record({ lane: "device", kind: "ocr", label: `Quick text recognition of ${where.toLowerCase()} (Tesseract, in this page)`, ms: result.ms });
      } catch {
        // The quick reader is a help, not a requirement: the careful reading goes on alone.
        quick = "";
      }
      if (!present()) return "";
      if (quick && this.quickChosen.has(doc.id)) {
        usedQuick = true;
        return quick;
      }
      const careful = new AbortController();
      controller.signal.addEventListener("abort", () => careful.abort());
      this.carefulAborts.set(doc.id, careful);
      const wait = roughDuration(carefulReadingMs(quick.length || 1500));
      this.patchDocument(doc.id, {
        detail: quick
          ? `${where}: quick reading done. The on-device model is now reading it carefully, ${wait}…`
          : `${where}: the on-device model is reading it, ${wait}…`,
        quick: quick ? { text: quick, unsure } : undefined,
      });
      // The on-device model notices a stop request late (more than 15 seconds was
      // seen while it was still looking at the image), so taking the quick reading
      // does not wait for it: the careful reading is stopped in the background.
      const reading = transcribeImage(image, label, (soFar) => present() && this.patchDocument(doc.id, { preview: soFar }), careful.signal);
      reading.catch(() => undefined);
      const chosen = new Promise<"quick">((resolve) => this.quickResolvers.set(doc.id, () => resolve("quick")));
      try {
        const text = await Promise.race([reading, chosen]);
        if (text === "quick") {
          usedQuick = true;
          return quick;
        }
        if (quick) check.push(...compareReadings(text, quick));
        return text;
      } finally {
        this.carefulAborts.delete(doc.id);
        this.quickResolvers.delete(doc.id);
      }
    };

    try {
      let text = "";
      let transcribed = false;
      let summary = "";
      if (doc.kind === "text") {
        text = tidyText(await file.text());
        summary = "text file";
      } else if (doc.kind === "docx") {
        text = await docxToText(await file.arrayBuffer());
        summary = "Word document";
      } else if (doc.kind === "image") {
        await needImageModel();
        const { photoToImage } = await import("./importers");
        const image = await photoToImage(file);
        text = await readImage(image, "This photo", "Read a photo of a document");
        transcribed = true;
        summary = usedQuick ? "photo, quick reading only, not checked by the on-device model" : "photo, read by the on-device model";
      } else {
        const { openPdf } = await import("./importers");
        const pdf = await openPdf(await file.arrayBuffer());
        try {
          const parts: string[] = [];
          let fromImage = 0;
          let skipped = 0;
          const canReadImages = pdf.pages.some((p) => p.scanned) ? (await deviceAvailability(true)) === "available" : false;
          for (const page of pdf.pages) {
            if (!present()) return;
            if (!page.scanned) {
              parts.push(page.text);
            } else if (!canReadImages) {
              skipped++;
            } else {
              const image = await page.render();
              const read = await readImage(image, `Scanned page ${page.number}`, "Read a scanned page");
              if (read) parts.push(read);
              fromImage++;
              transcribed = true;
            }
          }
          if (parts.length === 0 && skipped > 0) throw new Error(NO_IMAGE_MODEL);
          text = tidyText(dropRepeatedLines(parts).join("\n\n"));
          summary = [
            pdf.pageCount > MAX_PDF_PAGES ? `first ${MAX_PDF_PAGES} of ${pdf.pageCount} pages` : plural(pdf.pageCount, "page"),
            fromImage > 0 ? `${plural(fromImage, "scanned page")} read ${usedQuick ? "with the quick reading" : "by the on-device model"}` : "",
            skipped > 0 ? `${plural(skipped, "scanned page")} not read (no on-device model)` : "",
          ]
            .filter(Boolean)
            .join(", ");
        } finally {
          pdf.close();
        }
      }

      if (!present()) return;
      if (text.replace(/\s/g, "").length < 20) return fail("No readable text was found in this file.");
      // From this moment the tripwire refuses any outbound request carrying this text.
      privacyGuard.registerPrivateText(text);
      this.set({ record: appendToRecord(this.state.record, text), level: "private", sampleId: null, error: null });
      this.patchDocument(doc.id, {
        status: "done",
        text,
        transcribed,
        usedQuick,
        check,
        preview: "",
        quick: undefined,
        detail: `${summary} · ${plural(text.length, "character")} added`,
      });
      ledger.record({
        lane: "device",
        kind: "file",
        label: `Opened “${doc.name}” here (${summary}). The file was not uploaded.`,
      });
      toast(`${doc.name} opened on this computer.`, "success");
    } catch (e) {
      if (!present() || controller.signal.aborted || isAbort(e)) return;
      fail(message(e));
    } finally {
      this.importAborts.delete(doc.id);
      this.quickChosen.delete(doc.id);
    }
  }

  /** Takes the quick reading of a photo or scan now, instead of waiting for the careful one. */
  useQuickReading(id: number): void {
    const doc = this.state.documents.find((d) => d.id === id);
    if (!doc || doc.status !== "reading") return;
    this.quickChosen.add(id);
    this.quickResolvers.get(id)?.();
    this.carefulAborts.get(id)?.abort();
  }

  /** Takes a document out again, with the text it added if that text is still as it was. */
  removeDocument(id: number): void {
    const doc = this.state.documents.find((d) => d.id === id);
    if (!doc) return;
    this.importAborts.get(id)?.abort();
    this.importAborts.delete(id);
    this.quickChosen.delete(id);
    this.set({
      documents: this.state.documents.filter((d) => d.id !== id),
      record: removeFromRecord(this.state.record, doc.text),
    });
    this.maybeStartReading();
  }

  setQuery(patch: Partial<SessionState["query"]>): void {
    this.set({ query: { ...this.state.query, ...patch } });
  }

  /** Lets the person fix something the model read wrongly. Their word wins over the model's. */
  correctProfile(patch: ProfileCorrection): void {
    if (!this.state.profile || this.state.phase !== "review") return;
    this.corrections = { ...this.corrections, ...patch };
    this.set({ profile: { ...this.state.profile, ...patch } });
  }

  private stopEverything(): void {
    this.run++;
    this.readAbort?.abort();
    this.checkAbort?.abort();
    this.readAbort = null;
    this.checkAbort = null;
    this.queue = [];
    this.working = false;
    this.details = Promise.resolve();
    this.corrections = {};
    this.preparing.clear();
  }

  /** Writes a change that is waiting to be kept, before the state it comes from goes away. */
  private flushPersist(): void {
    if (!this.persistTimer) return;
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
    void this.persist();
  }

  reset(): void {
    this.flushPersist();
    this.stopEverything();
    for (const c of this.importAborts.values()) c.abort();
    this.importAborts.clear();
    this.importing = Promise.resolve();
    privacyGuard.clear();
    ledger.clear();
    const { device, online } = this.state;
    this.state = { ...initial(), device, online };
    this.kept = null;
    for (const l of this.listeners) l();
    // What is kept on this computer, if anything, is offered again on the start screen.
    void this.loadKept();
  }

  /** Goes back to the record, keeping its text: to stop a reading, or to change the record. */
  backToRecord(): void {
    if (this.state.replay) return;
    this.stopEverything();
    this.set({
      phase: "start",
      profile: null,
      detailsReady: false,
      readingSince: null,
      readingPart: null,
      urgent: false,
      trials: [],
      screenedOut: [],
      observational: [],
      error: null,
    });
  }

  /** Step 1: read the record. Private records are read on the device or not at all. */
  async read(): Promise<void> {
    const { record, level, device } = this.state;
    if (this.opening()) {
      // Asked early: the reading starts by itself when the documents are open.
      this.set({ readWhenReady: true, error: null });
      return;
    }
    if (record.trim().length < MIN_RECORD_CHARS) {
      this.set({ error: "Add a document or paste a few lines of the medical record first, or pick a fictional patient." });
      return;
    }
    if (level === "private" && device !== "available") {
      this.set({
        error:
          "This browser cannot run the on-device model yet, so OneWay will not read a real record here. Nothing was sent. You can still try a fictional patient.",
      });
      return;
    }
    this.stopEverything();
    const run = this.run;
    const abort = new AbortController();
    this.readAbort = abort;
    const recordParts = readableParts(record).length;
    const onPart = (part: number, parts: number) => run === this.run && this.set({ readingPart: parts > 1 ? { part, parts } : null });
    this.set({ phase: "reading", detailsReady: false, error: null, urgent: looksUrgent(record), readingSince: Date.now(), readingPart: null, recordParts });
    try {
      // First pass: enough to propose a search. The person can approve it while
      // the second pass is still reading treatments and lab values.
      const basics = await extractBasics(record, level, abort.signal, onPart);
      if (run !== this.run) return;
      const partial = buildProfile(basics, NO_DETAILS, record);
      this.set({
        profile: partial,
        phase: "review",
        readingSince: Date.now(),
        readingPart: null,
        // The place is only a suggestion: the person sees it, can change it, and approves before anything is sent.
        query: { condition: partial.searchTerm, location: this.state.query.location || suggestedLocation(partial.location, record) },
      });

      this.details = (async () => {
        try {
          const details = await extractDetails(record, level, abort.signal, onPart);
          if (run !== this.run) return;
          this.set({
            profile: { ...buildProfile(basics, details, record), ...this.corrections },
            detailsReady: true,
            readingSince: null,
            readingPart: null,
          });
        } catch (e) {
          if (run !== this.run) return;
          this.set({ detailsReady: true, readingSince: null, readingPart: null, error: `Treatments and lab values could not be read. ${message(e)}` });
        }
      })();
    } catch (e) {
      if (run !== this.run) return;
      this.set({ phase: "start", readingSince: null, readingPart: null, error: message(e) });
    }
  }

  /** Step 2: search the public registry with the terms the person approved. */
  async search(): Promise<void> {
    const { profile, query } = this.state;
    if (!profile) return;
    const run = this.run;
    this.set({ phase: "searching", error: null });
    try {
      const found = await searchTrials({ condition: query.condition, location: query.location, pageSize: 15 });
      if (run !== this.run) return;
      const current = this.state.profile ?? profile;
      const observational = found.filter((t) => !isInterventional(t));
      const screenedOut: SessionState["screenedOut"] = [];
      const kept: Trial[] = [];
      for (const trial of found.filter(isInterventional)) {
        const d = prefilter(trial, current);
        if (d.keep) kept.push(trial);
        else screenedOut.push({ trial, reason: d.reason });
      }
      this.set({
        phase: "results",
        observational,
        screenedOut,
        trials: kept.map((trial) => ({ trial, status: "waiting", pending: 0, explanations: {} })),
      });
      void this.prepareTrials(run, ++this.searches);
    } catch (e) {
      if (run !== this.run) return;
      this.set({ phase: "review", error: message(e) });
    }
  }

  /** Back from the list of trials to the search words, to try other words. */
  backToSearch(): void {
    if (this.state.replay || this.state.phase !== "results") return;
    this.searches++;
    this.queue = [];
    this.preparing.clear();
    this.checkAbort?.abort();
    this.set({ phase: "review", trials: [], screenedOut: [], observational: [], error: null });
  }

  /** Nothing recruiting near the place given: the same condition again, with no place. It sends less, not more. */
  async searchWithoutPlace(): Promise<void> {
    if (this.state.replay || this.state.phase !== "results" || !this.state.query.location.trim()) return;
    this.backToSearch();
    this.set({ query: { ...this.state.query, location: "" } });
    await this.search();
  }

  /**
   * Prepares the first trials one after another: rules compiled in the cloud,
   * then what plain code can decide, instantly. Each trial can be checked as
   * soon as its own rules are ready, and the first one with nothing against it
   * is checked without waiting to be asked.
   */
  private async prepareTrials(run: number, search: number): Promise<void> {
    // The first trials, and every trial already checked on an earlier visit kept on this computer:
    // their rules usually come from the shared cache, and their answers come back at once.
    const keptIds =
      this.state.remember && this.kept?.record === this.state.record ? new Set(Object.keys(this.kept?.checks ?? {})) : new Set<string>();
    const first = this.state.trials.filter((t, i) => i < AUTO_COMPILE || keptIds.has(t.trial.nctId));
    const stillHere = () => run === this.run && search === this.searches;
    let autoQueued = false;
    for (const t of first) {
      if (!stillHere()) return;
      await this.prepare(t.trial.nctId, run);
      if (!stillHere()) return;
      const now = this.trial(t.trial.nctId);
      if (!autoQueued && now?.status === "ready" && now.match && now.match.counts.blocker === 0) {
        autoQueued = true;
        this.check(t.trial.nctId);
      }
    }
  }

  /** One preparation per trial at a time, whoever asks for it. */
  private preparing = new Map<string, Promise<boolean>>();

  private prepare(nctId: string, run: number): Promise<boolean> {
    const existing = this.preparing.get(nctId);
    if (existing) return existing;
    const job = this.prepareOnce(nctId, run).finally(() => this.preparing.delete(nctId));
    this.preparing.set(nctId, job);
    return job;
  }

  private async prepareOnce(nctId: string, run: number): Promise<boolean> {
    const t = this.trial(nctId);
    const { record, level } = this.state;
    if (!t || !this.state.profile) return false;
    if (t.criteria) return true;
    this.patchTrial(nctId, { status: "compiling", error: undefined });
    try {
      const compiled = await compileTrial(t.trial);
      // The rules need lab values, so wait for the second pass over the record.
      await this.details;
      if (run !== this.run) return false;
      const profile = this.state.profile;
      if (!profile) return false;
      // Answers the model gave on an earlier visit, for exactly these criteria, are reused rather than asked again.
      const sameRecord = this.kept !== null && this.kept.record === record;
      const earlier = this.state.remember && sameRecord ? keptAnswers(this.kept?.checks[nctId], compiled.criteria) : [];
      const rulesOnly = await matchTrial(t.trial, compiled.criteria, profile, record, { rulesOnly: true, level, already: earlier });
      const fields = this.matchFields(nctId, rulesOnly, compiled.criteria);
      // When everything is decided there is nothing left for the model.
      const status: TrialState["status"] = this.queue.includes(nctId)
        ? "queued"
        : fields.pending === 0 || earlier.length > 0
          ? "done"
          : "ready";
      this.patchTrial(nctId, {
        status,
        origin: compiled.origin,
        criteria: compiled.criteria,
        ...fields,
        ...(earlier.length > 0 ? { checkedOn: this.kept?.checks[nctId]?.checkedAt } : {}),
      });
      return true;
    } catch (e) {
      if (run !== this.run) return false;
      this.patchTrial(nctId, { status: "error", error: message(e) });
      return false;
    }
  }

  /**
   * Step 3: check a trial against the record. Checks run one at a time. Calling
   * this again on a trial that still has unchecked criteria checks the next batch.
   */
  check(nctId: string): void {
    const t = this.trial(nctId);
    if (!t || t.status === "queued" || t.status === "checking") return;
    if (t.status === "done" && t.pending === 0) return;
    if (this.queue.includes(nctId)) return;
    this.queue.push(nctId);
    // A trial whose rules are being prepared keeps saying so; it is in the queue all the same.
    if (t.status !== "compiling") this.patchTrial(nctId, { status: "queued", error: undefined });
    void this.work();
  }

  /** Queues every trial that has not been checked yet. */
  checkAll(): void {
    for (const t of this.state.trials) {
      if (t.status === "waiting" || t.status === "ready" || t.status === "error" || t.status === "compiling") this.check(t.trial.nctId);
    }
  }

  /** Stops the trial being checked and empties the queue. Answers already given are kept. */
  stopChecking(): void {
    const waiting = this.queue;
    this.queue = [];
    for (const nctId of waiting) this.patchTrial(nctId, (t) => (t.status === "queued" ? { status: restingStatus(t) } : {}));
    this.checkAbort?.abort();
  }

  private async work(): Promise<void> {
    if (this.working) return;
    this.working = true;
    const run = this.run;
    while (this.queue.length > 0 && run === this.run) {
      const nctId = this.queue.shift()!;
      const ok = await this.prepare(nctId, run);
      if (!ok || run !== this.run) continue;
      const t = this.trial(nctId);
      const { profile, record, level } = this.state;
      if (!t?.criteria || !profile) continue;
      const criteria = t.criteria;
      // A second pass on the same trial means "check the rest": keep going past blockers.
      const resumed = (t.raw?.results ?? []).filter(isModelAnswer);
      // What the person answered themselves is not put to the model.
      const skip = new Set(Object.keys(this.state.answers[nctId] ?? {}));
      const abort = new AbortController();
      this.checkAbort = abort;
      this.patchTrial(nctId, { status: "checking", batch: undefined });
      let asked: number | null = null;
      try {
        const raw = await matchTrial(t.trial, criteria, profile, record, {
          level,
          already: resumed,
          skip,
          limit: CHECK_BATCH,
          stopAtBlocker: resumed.length === 0,
          signal: abort.signal,
          onProgress: (partial, left) => {
            if (run !== this.run) return;
            if (asked === null) asked = left;
            this.patchTrial(nctId, { ...this.matchFields(nctId, partial, criteria), batch: { total: asked, left } });
          },
        });
        if (run !== this.run) break;
        const fields = this.matchFields(nctId, raw, criteria);
        this.patchTrial(nctId, { status: "done", ...fields, batch: undefined, checkedOn: undefined });
        if (fields.match?.fit === "worth_discussing") {
          const title = t.trial.title.length > 60 ? `${t.trial.title.slice(0, 57)}…` : t.trial.title;
          toast(`Worth discussing with your doctor: ${title}`, "celebrate", 5000);
        }
      } catch (e) {
        if (run !== this.run) break;
        if (abort.signal.aborted || isAbort(e)) {
          // Stopped by the person: what was answered stays on the page.
          this.patchTrial(nctId, (cur) => ({ status: restingStatus(cur), batch: undefined }));
        } else {
          this.patchTrial(nctId, { status: "error", error: message(e), batch: undefined });
        }
      }
    }
    if (run === this.run) {
      this.working = false;
      this.checkAbort = null;
    }
  }

  /** Plain-language explanation of one public criterion (PREFER_ON_DEVICE). */
  async explain(nctId: string, criterion: CompiledCriterion): Promise<void> {
    const t = this.trial(nctId);
    if (!t || t.explanations[criterion.id]) return;
    this.patchTrial(nctId, (cur) => ({ explanations: { ...cur.explanations, [criterion.id]: "loading" } }));
    try {
      const res = await explainCriterion(criterion.text, `${nctId}:${criterion.id}`);
      this.patchTrial(nctId, (cur) => ({ explanations: { ...cur.explanations, [criterion.id]: res } }));
    } catch (e) {
      this.patchTrial(nctId, (cur) => {
        const { [criterion.id]: _drop, ...rest } = cur.explanations;
        return { explanations: rest };
      });
      this.set({ error: message(e) });
    }
  }

  /** Plain-language summary of a public trial description (PREFER_IN_CLOUD). */
  async summarize(nctId: string): Promise<void> {
    const t = this.trial(nctId);
    if (!t || t.summary) return;
    this.patchTrial(nctId, { summary: "loading" });
    try {
      this.patchTrial(nctId, { summary: await summarizeTrial(t.trial) });
    } catch (e) {
      this.patchTrial(nctId, { summary: undefined });
      this.set({ error: message(e) });
    }
  }

  /**
   * Shows a recorded run of the app. Used when this browser cannot run the
   * on-device model or the cloud refuses it, and as a quick tour. It replays
   * saved results step by step: no model is called and no request is made.
   */
  async playRecording(rec: Recording): Promise<void> {
    this.reset();
    const run = this.run;
    // The recorded record is registered as private, so the ledger proof is a real
    // check of the recorded outbound payloads, not a canned sentence.
    privacyGuard.registerPrivateText(rec.record);
    let view = initialView(rec);
    this.set({ ...view, record: rec.record, level: "private", replay: { recordedAt: rec.recordedAt, environment: rec.environment, finished: false } });
    for (const entry of rec.ledger) {
      await new Promise((r) => setTimeout(r, delayFor(entry.kind)));
      if (run !== this.run) return;
      ledger.record(entry);
      view = applyEntry(view, rec, entry);
      this.set({ ...view });
    }
    if (run === this.run && this.state.replay) this.set({ replay: { ...this.state.replay, finished: true } });
  }

  /** Loads and plays the built-in recorded example. */
  async playExample(): Promise<void> {
    const mod = await import("./recorded/example.json");
    await this.playRecording(mod.default as unknown as Recording);
  }

  /** Development helper: captures the current live session as a recording. */
  exportRecording(environment: string): Recording {
    return toRecording(this.state, ledger.all(), environment);
  }

  dismissError(): void {
    this.set({ error: null });
  }
}

export const session = new Session();

if (import.meta.env.DEV && typeof window !== "undefined") {
  // Development only: lets a real run be captured from the browser console.
  (window as unknown as { __oneway?: Session }).__oneway = session;
}

export function useSession(): SessionState {
  return useSyncExternalStore(session.subscribe, session.getState);
}

export function useLedger() {
  return useSyncExternalStore(
    (l) => ledger.subscribe(l),
    () => ledger.all(),
  );
}

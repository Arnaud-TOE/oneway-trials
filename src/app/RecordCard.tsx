import {
  CheckCircle2,
  Cpu,
  FileText,
  FileType,
  FileUp,
  FileWarning,
  Image as ImageIcon,
  Loader2,
  type LucideIcon,
  Play,
  ShieldCheck,
  X,
} from "lucide-react";
import { useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { ACCEPT } from "../engine/documents";
import { MAX_PARTS, PART_CHARS, partsNeeded, readableChars } from "../engine/parts";
import { isFirebaseConfigured } from "../lib/firebase";
import { EXAMPLE_READY } from "./recorded/ready";
import { SAMPLES } from "./samples";
import { MIN_RECORD_CHARS, session, type ImportedDocument, type SessionState } from "./session";

const KIND_LABEL: Record<string, string> = { pdf: "PDF", image: "Photo", docx: "Word", text: "Text" };
const KIND_ICON: Record<string, LucideIcon> = { pdf: FileText, image: ImageIcon, docx: FileType, text: FileText };

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

function DocumentRow({ d }: { d: ImportedDocument }) {
  const busy = d.status === "reading" || d.status === "waiting";
  const KindIcon = d.kind ? KIND_ICON[d.kind] : FileWarning;
  return (
    <li className={`doc doc-${d.status}`}>
      <span className="doc-kind" aria-hidden="true">
        <KindIcon size={18} />
        <span>{d.kind ? KIND_LABEL[d.kind] : "File"}</span>
      </span>
      <div className="doc-main">
        <p className="doc-name">{d.name}</p>
        <p className="doc-detail" role={d.status === "error" ? "alert" : "status"}>
          {busy && <Loader2 size={14} className="spin" aria-hidden="true" />}
          {d.status === "done" && <CheckCircle2 size={15} className="doc-tick" aria-hidden="true" />}
          {d.detail}
        </p>
        {d.status === "reading" && d.preview && (
          <pre className="doc-preview" aria-label="Text read so far by the on-device model">
            {d.preview}
          </pre>
        )}
        {d.status === "reading" && !d.preview && d.quick && (
          <>
            <p className="doc-quick-label">Quick reading, not checked yet:</p>
            <pre className="doc-preview doc-preview-quick" aria-label="Quick reading, not checked yet">
              {d.quick.text}
            </pre>
          </>
        )}
        {d.status === "reading" && d.quick && (
          <div className="doc-quick-choice">
            <button className="btn btn-quiet btn-small" onClick={() => session.useQuickReading(d.id)}>
              Use the quick reading now
            </button>
            <span className="actions-hint">
              Only for a clean, sharp document.
              {d.quick.unsure > 0
                ? ` The quick reader is unsure of ${d.quick.unsure} ${d.quick.unsure === 1 ? "number" : "numbers"} in it.`
                : ""}{" "}
              You will need to check the numbers yourself.
            </span>
          </div>
        )}
        {d.status === "done" && d.check && d.check.length > 0 && (
          <div className="doc-check" role="note">
            <p>
              <strong>Check {d.check.length === 1 ? "this line" : `these ${d.check.length} lines`} against your document.</strong> Two readings of the
              image differ here, on a number or on the spelling of a word; the one shown is the on-device model's.
            </p>
            <ul>
              {d.check.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <button className="doc-remove" onClick={() => session.removeDocument(d.id)} aria-label={`${busy ? "Stop and remove" : "Remove"} ${d.name}`}>
        <X size={16} aria-hidden="true" />
      </button>
    </li>
  );
}

/** Says plainly what this browser can do, and what to do when it cannot run the private model. */
function ModelNotice({ s }: { s: SessionState }) {
  if (s.device === null || s.device === "available") return null;
  if (s.device === "downloadable" || s.device === "downloading") {
    const running = s.download !== null || s.device === "downloading";
    return (
      <div className="notice notice-setup">
        <p>
          <strong>One-time setup.</strong> To read a real record, Chrome first downloads its on-device model to this computer. It is a
          large download, done once, and it is what keeps your record here.
        </p>
        {running ? (
          <div className="download" role="status">
            <div className="bar" aria-hidden="true">
              <span style={{ width: `${s.download ?? 0}%` }} />
            </div>
            <span>{s.download !== null ? `Downloading… ${s.download}%` : "Chrome is downloading the model…"}</span>
          </div>
        ) : (
          <button className="btn btn-quiet" onClick={() => void session.downloadModel()}>
            Download the on-device model
          </button>
        )}
        <p className="note">Meanwhile, a fictional patient shows how OneWay works.</p>
      </div>
    );
  }
  return (
    <div className="notice notice-setup">
      <p>
        <strong>This browser cannot read a real record.</strong> OneWay only reads a real record with a model that runs on your own
        computer, and this browser does not have one.{" "}
        {s.device === "no-api"
          ? "It needs Chrome 148 or later on a desktop computer (Windows, macOS or Linux)."
          : "Chrome runs it on Windows 10 or 11, macOS 13 or later, or Linux, with 22 GB of free disk space and either 16 GB of memory with 4 processor cores or a graphics card with more than 4 GB of memory."}
      </p>
      <p className="note">You can still see how it works with a fictional patient below. Nothing you add here is sent anywhere.</p>
      {EXAMPLE_READY && (
        <button className="btn btn-quiet" onClick={() => void session.playExample()}>
          <Play size={16} aria-hidden="true" />
          Watch a real run recorded with the on-device model
        </button>
      )}
    </div>
  );
}

export function RecordCard({ s }: { s: SessionState }) {
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const depth = useRef(0);

  const opening = s.documents.some((d) => d.status === "reading" || d.status === "waiting");
  const transcribed = s.documents.some((d) => d.status === "done" && d.transcribed);
  const quickOnly = s.documents.some((d) => d.status === "done" && d.usedQuick);
  const chars = s.record.length;
  // Counting parts splits the text; only worth doing once it can be long.
  const parts = chars > PART_CHARS ? partsNeeded(s.record) : 1;
  const readParts = Math.min(parts, MAX_PARTS);
  const tooLong = parts > MAX_PARTS;
  const tooShort = s.record.trim().length < MIN_RECORD_CHARS;
  const sampleInCloud = s.level === "sample" && s.device !== null && s.device !== "available";
  const blockedPrivate = s.level === "private" && s.device !== null && s.device !== "available";
  // While a document is still being opened the button stays available: the reading then starts by itself when it is ready.
  const canRead = isFirebaseConfigured && !blockedPrivate && !s.readWhenReady && (opening || !tooShort);

  const add = (list: FileList | File[] | null | undefined) => {
    const files = Array.from(list ?? []);
    if (files.length > 0) session.addFiles(files);
  };

  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth.current = 0;
    setDragging(false);
    add(e.dataTransfer.files);
  };

  // A screenshot or a copied image can be pasted straight in. Pasted text goes to the box as usual.
  const onPaste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    // Text copied from Word or a web page often comes with a picture of itself: the text wins.
    if ((e.clipboardData?.getData("text/plain") ?? "").trim() !== "") return;
    e.preventDefault();
    add(files);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && canRead) {
      e.preventDefault();
      void session.read();
    }
  };

  return (
    <section
      className={`card record ${dragging ? "is-dragging" : ""}`}
      aria-labelledby="record-title"
      onDragEnter={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current++;
        setDragging(true);
      }}
      onDragOver={(e) => hasFiles(e) && e.preventDefault()}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
      }}
      onDrop={onDrop}
      onPaste={onPaste}
    >
      <div className="card-head">
        <h2 id="record-title" data-phase-title tabIndex={-1}>
          Your medical record
        </h2>
        <p className="note">A clinic letter, a discharge summary, lab results. It is opened and read on this computer.</p>
      </div>

      <ModelNotice s={s} />

      <div className="dropzone">
        <input
          ref={picker}
          id="file-input"
          type="file"
          className="sr-only"
          accept={ACCEPT}
          multiple
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            add(e.target.files);
            e.target.value = "";
          }}
        />
        <span className="dropzone-icon" aria-hidden="true">
          <FileUp size={24} />
        </span>
        <p className="dropzone-main">
          {dragging ? (
            <strong>Drop it here. It stays on this computer.</strong>
          ) : (
            <>
              <strong>Drop a document here</strong>, or{" "}
              <button className="link link-strong" onClick={() => picker.current?.click()}>
                choose a file
              </button>
            </>
          )}
        </p>
        <p className="dropzone-hint">PDF, photo or scan (JPG, PNG), Word (.docx) or text. Opened here, never uploaded.</p>
      </div>

      {s.documents.length > 0 && (
        <ul className="docs" aria-label="Documents added">
          {s.documents.map((d) => (
            <DocumentRow key={d.id} d={d} />
          ))}
        </ul>
      )}

      {transcribed && (
        <p className="notice notice-check" role="note">
          <strong>Please check the numbers.</strong>{" "}
          {quickOnly
            ? "Part of this text comes from the quick reading of an image, which was not checked by the on-device model and often misreads a digit."
            : "Part of this text was read from an image by the on-device model, which can misread a digit or a drug name."}{" "}
          Compare it with your document and correct it below before going on.
        </p>
      )}

      <div className="record-text">
        <div className="record-text-head">
          <label htmlFor="record">Text OneWay will read</label>
          <span className={`counter ${tooLong ? "is-over" : ""}`} aria-live="polite">
            {chars.toLocaleString("en-US")} characters{readParts > 1 ? ` · read in ${readParts} parts` : ""}
            {chars > 0 && (
              <button className="link" onClick={() => session.clearRecord()}>
                Clear
              </button>
            )}
          </span>
        </div>
        <textarea
          id="record"
          rows={8}
          value={s.record}
          onChange={(e) => session.setRecord(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="…or paste or type the text here. English works best for now. You can edit anything before it is read."
          spellCheck={false}
        />
        {readParts > 1 && (
          <p className={`note ${tooLong ? "note-warn" : ""}`} role="status">
            This is a long record. All of it is read, in {readParts} parts, so reading it and checking each trial take about {readParts}{" "}
            times longer than for a one-page letter.
            {tooLong &&
              ` It is longer than OneWay reads on a laptop: only the first ${readableChars(s.record).toLocaleString("en-US")} characters are read. Remove pages that do not matter, such as bills or appointment letters.`}
          </p>
        )}
      </div>

      <div className="samples">
        <p className="samples-title">No record at hand? Try a fictional patient:</p>
        <div className="sample-list">
          {SAMPLES.map((p) => (
            <button key={p.id} className={`sample sample-${p.id} ${s.sampleId === p.id ? "is-on" : ""}`} onClick={() => session.useSample(p)} aria-pressed={s.sampleId === p.id}>
              <span className="sample-avatar" aria-hidden="true">
                {p.name.charAt(0)}
              </span>
              <span className="sample-text">
                <strong>{p.name}</strong>
                <span>{p.blurb}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      {s.level === "sample" ? (
        <p className="note">
          This patient is fictional, so it is not treated as private: on a browser without the on-device model, the cloud model stands in. A
          real record is only ever read on the device.
        </p>
      ) : (
        <p className="note note-device note-icon">
          <ShieldCheck size={16} aria-hidden="true" />
          Read on this device only. If the on-device model is missing, OneWay stops instead of uploading.
        </p>
      )}

      <div className="actions">
        <button className="btn btn-primary btn-large" onClick={() => void session.read()} disabled={!canRead}>
          {s.readWhenReady
            ? "Starts when your documents are open…"
            : sampleInCloud
              ? "Read this fictional record"
              : "Read my record on this device"}
          {!s.readWhenReady && <Cpu size={18} aria-hidden="true" />}
        </button>
        {s.readWhenReady && (
          <button className="link" onClick={() => session.cancelReadWhenReady()}>
            Cancel
          </button>
        )}
        <span className="actions-hint">
          {opening
            ? s.readWhenReady
              ? "Your record will be read as soon as every document is open. You can check the text meanwhile."
              : "A document is still being opened. You can already click: the reading will start when it is ready."
            : blockedPrivate
              ? "A real record needs the on-device model. Pick a fictional patient to try OneWay."
              : tooShort
                ? "Add a document, paste some text or pick a fictional patient to continue."
                : "Takes one to two minutes on a laptop. Nothing is uploaded."}
        </span>
      </div>
    </section>
  );
}

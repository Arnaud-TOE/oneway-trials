/**
 * Turning a document the person picked into text, on the device.
 *
 * Nothing here touches the network. Text files, Word files and PDFs with a text
 * layer are read by plain code. Photos and scanned pages are read by the
 * on-device model (see transcribe.ts). The file itself is never uploaded.
 */

export type DocumentKind = "text" | "pdf" | "image" | "docx";

/** What the file picker offers. */
export const ACCEPT =
  ".pdf,.txt,.md,.text,.docx,.jpg,.jpeg,.png,.webp,application/pdf,text/plain,image/jpeg,image/png,image/webp,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Pages read from one PDF. Pages with a text layer take no time; the record length limit (parts.ts) applies after. */
export const MAX_PDF_PAGES = 40;
/** A PDF page with less text than this is treated as a scan and read from its image. */
export const SCANNED_PAGE_CHARS = 24;

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Decides how a file is read, from its type and its name. Returns null for a file OneWay cannot open. */
export function kindOf(name: string, type: string): DocumentKind | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (type === "application/pdf" || ext === "pdf") return "pdf";
  if (type === DOCX_TYPE || ext === "docx") return "docx";
  if (/^image\/(jpeg|png|webp|bmp|gif)$/.test(type) || ["jpg", "jpeg", "png", "webp", "bmp", "gif"].includes(ext)) return "image";
  if (type.startsWith("text/") || ["txt", "md", "text", "csv"].includes(ext)) return "text";
  return null;
}

/** Why a file cannot be opened, in words for the person. */
export function unsupportedReason(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "doc" || ext === "rtf" || ext === "odt") {
    return "This older document format cannot be opened here. Save it as PDF or .docx, or paste its text.";
  }
  if (ext === "heic" || ext === "heif") return "This photo format cannot be opened here. Save it as JPG or PNG first.";
  return "This kind of file cannot be opened here. Use a PDF, a photo (JPG or PNG), a Word file (.docx) or plain text.";
}

/** Normalises extracted text: line endings, stray control characters, runs of blank lines. */
export function tidyText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f﻿]/g, "")
    .replace(/ /g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Adds the text of a document after what is already there. */
export function appendToRecord(record: string, text: string): string {
  const before = record.trim();
  return before ? `${before}\n\n${text.trim()}` : text.trim();
}

/** Takes a document's text back out, if the person has not edited it since. Otherwise leaves the record alone. */
export function removeFromRecord(record: string, text: string): string {
  const piece = text.trim();
  if (!piece || !record.includes(piece)) return record;
  return record.replace(piece, "").replace(/\n{3,}/g, "\n\n").trim();
}

// "Page 2", "Page 2 of 5", "2 of 5". Not a lone number or "120/80": those can be results.
const PAGE_NUMBER = /^page\s*#+(?:\s*(?:of|\/)\s*#+)?$|^#+\s+of\s+#+$/i;

/**
 * Removes what a document repeats on every page: the letterhead, the patient
 * banner, "Page 2 of 5". A short line found on at least half of the pages (and
 * at least two) is kept once, where it first appears; page numbers are dropped
 * everywhere. On a long PDF this leaves more room for what the pages actually say.
 */
export function dropRepeatedLines(pages: string[]): string[] {
  if (pages.length < 2) return pages;
  // Lines are compared exactly, digits included: "Creatinine 0.9 mg/dL" on one
  // page and "Creatinine 1.1 mg/dL" on the next are two results, not a header.
  const key = (line: string) => line.trim().toLowerCase().replace(/\s+/g, " ");
  const onPages = new Map<string, number>();
  for (const page of pages) {
    for (const k of new Set(page.split("\n").map(key).filter(Boolean))) onPages.set(k, (onPages.get(k) ?? 0) + 1);
  }
  const repeated = (k: string) => k.length <= 100 && (onPages.get(k) ?? 0) >= Math.max(2, Math.ceil(pages.length / 2));
  const kept = new Set<string>();
  return pages.map((page) =>
    page
      .split("\n")
      .filter((line) => {
        const k = key(line);
        if (!k) return true;
        // Only page numbers are recognised with their digits ignored: "Page 2 of 5".
        if (PAGE_NUMBER.test(k.replace(/\d+/g, "#"))) return false;
        if (!repeated(k)) return true;
        if (kept.has(k)) return false;
        kept.add(k);
        return true;
      })
      .join("\n"),
  );
}

/** One piece of text on a PDF page, with where it sits. */
export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Rebuilds reading order from the positioned text of a PDF page: pieces on the
 * same baseline form a line, lines run from the top of the page down, and a
 * larger vertical gap is kept as a blank line.
 */
export function linesFromItems(items: PdfTextItem[]): string {
  const pieces = items.filter((it) => it.str.trim() !== "");
  if (pieces.length === 0) return "";
  const sorted = [...pieces].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: { y: number; height: number; items: PdfTextItem[] }[] = [];
  for (const it of sorted) {
    const size = it.height || 10;
    const line = lines.find((l) => Math.abs(l.y - it.y) <= Math.max(2, Math.min(l.height, size) * 0.5));
    if (line) line.items.push(it);
    else lines.push({ y: it.y, height: size, items: [it] });
  }
  lines.sort((a, b) => b.y - a.y);
  let out = "";
  let previous: { y: number; height: number } | null = null;
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    let text = "";
    let end = 0;
    for (const it of line.items) {
      const gap = it.x - end;
      // A visible gap between two pieces is a space; a wide one is a column break.
      if (text && !text.endsWith(" ") && !it.str.startsWith(" ") && gap > line.height * 0.15) {
        text += gap > line.height * 2.5 ? "   " : " ";
      }
      text += it.str;
      end = it.x + it.width;
    }
    if (previous && previous.y - line.y > Math.max(previous.height, line.height) * 1.9) out += "\n";
    out += `${text.trim()}\n`;
    previous = line;
  }
  return tidyText(out);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/**
 * The text of a Word document, from its main XML part. Paragraphs become lines
 * and each table row becomes one line, so a row such as "Creatinine | 0.9 mg/dL"
 * stays together. Deleted text kept by "track changes" is left out.
 */
export function documentXmlToText(xml: string): string {
  const token = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:(?:br|cr)\b[^>]*\/>|<\/w:p>|<\/w:tc>|<\/w:tr>/g;
  let out = "";
  for (const m of xml.matchAll(token)) {
    const tag = m[0];
    if (m[1] !== undefined) out += decodeXml(m[1]);
    else if (tag.startsWith("<w:tab")) out += "\t";
    else if (tag === "</w:tc>") out = `${out.replace(/\n+$/, "")}   `;
    else if (tag === "</w:tr>") out = `${out.replace(/[ \t]+$/, "")}\n`;
    else out += "\n";
  }
  return tidyText(out);
}

const u16 = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8);
const u32 = (b: Uint8Array, at: number): number => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/**
 * Reads one file out of a zip archive (a .docx is one). Small on purpose: it
 * handles what Word writes, stored or deflated entries, and nothing else.
 */
export async function unzipEntry(buffer: ArrayBuffer, path: string): Promise<Uint8Array | null> {
  const b = new Uint8Array(buffer);
  // The directory is at the end of the file, after an optional comment.
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (u32(b, i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const count = u16(b, end + 10);
  let at = u32(b, end + 16);
  for (let n = 0; n < count && at + 46 <= b.length; n++) {
    if (u32(b, at) !== 0x02014b50) return null;
    const method = u16(b, at + 10);
    const packed = u32(b, at + 20);
    const nameLength = u16(b, at + 28);
    const extraLength = u16(b, at + 30);
    const commentLength = u16(b, at + 32);
    const local = u32(b, at + 42);
    const name = new TextDecoder().decode(b.subarray(at + 46, at + 46 + nameLength));
    if (name === path) {
      if (u32(b, local) !== 0x04034b50) return null;
      const start = local + 30 + u16(b, local + 26) + u16(b, local + 28);
      const data = b.subarray(start, start + packed);
      if (method === 0) return data;
      if (method !== 8) return null;
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

/** The text of a .docx file. Throws when the file is not a Word document. */
export async function docxToText(buffer: ArrayBuffer): Promise<string> {
  const part = await unzipEntry(buffer, "word/document.xml").catch(() => null);
  if (!part) throw new Error("This file is not a Word document that can be opened here.");
  return documentXmlToText(new TextDecoder("utf-8").decode(part));
}

/**
 * Cleans what the on-device model returns for a photo: a small model sometimes
 * wraps the text in a code fence or announces it first.
 */
export function cleanTranscript(text: string): string {
  let t = text.trim();
  t = t.replace(/^```[a-z]*\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  t = t.replace(/^(here is|here's|the text in the image|transcription)[^\n:]{0,60}:\s*\n+/i, "");
  return tidyText(t);
}

/** Writes powers of ten the same way whatever the reader made of the caret: "x10^9", "x10*9", "x10”9" all go. */
function withoutPowersOfTen(text: string): string {
  return text.replace(/10\s*[\^*”"'`°’]\s*\d{1,2}\b/g, " ");
}

function numbersIn(text: string): string[] {
  return (withoutPowersOfTen(text).match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(",", ".").replace(/^0+(?=\d)/, ""));
}

/** Words long enough to be a drug or a diagnosis, in lower case. */
function longWordsIn(text: string): string[] {
  return (text.toLowerCase().match(/\p{L}{6,}/gu) ?? []);
}

/** True when a and b differ by one or two letters (inserted, removed or changed). */
export function nearlySame(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 2) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length] <= 2;
}

/**
 * Compares two independent readings of the same image: the careful one (the
 * on-device model) and the quick one (Tesseract). Returns the lines of the
 * careful reading worth checking against the document, because one of the two
 * readers misread something there:
 *
 * - a number the quick reading did not find;
 * - a long word the quick reading spelled differently, by one or two letters.
 *   Seen in testing: the careful reading once wrote "osimeratinib" for
 *   osimertinib, a drug name that then appeared in the profile.
 *
 * Measured on a blurred photo of a lab report: it pointed out exactly the two
 * lines where the quick reading was wrong ("0.0" for 0.9, "6oo" for 600), and
 * nothing on a clean photo.
 */
export function compareReadings(careful: string, quick: string): string[] {
  const available = new Map<string, number>();
  for (const n of numbersIn(quick)) available.set(n, (available.get(n) ?? 0) + 1);
  const quickWords = new Set(longWordsIn(quick));
  const lines: string[] = [];
  for (const line of careful.split("\n")) {
    let differs = false;
    for (const n of numbersIn(line)) {
      const left = available.get(n) ?? 0;
      if (left > 0) available.set(n, left - 1);
      else differs = true;
    }
    for (const w of longWordsIn(line)) {
      if (differs) break;
      if (quickWords.has(w)) continue;
      for (const q of quickWords) {
        if (nearlySame(w, q)) {
          differs = true;
          break;
        }
      }
    }
    if (differs && line.trim()) lines.push(line.trim());
  }
  return lines;
}

/** Rough time the on-device model takes to write out a page of `chars` characters, measured on a laptop with no graphics card. */
export function carefulReadingMs(chars: number): number {
  return 20000 + chars * 80;
}

/** "2 pages", "1 page". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

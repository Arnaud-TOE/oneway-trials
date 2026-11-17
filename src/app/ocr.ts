import type { Worker } from "tesseract.js";

/**
 * Quick text recognition for photos and scanned pages: Tesseract (Apache-2.0),
 * compiled to WebAssembly and run in a worker in this page.
 *
 * It reads a page in one or two seconds, against a minute or more for the
 * on-device model, but it is less reliable: on a slightly blurred photo it read
 * "Creatinine 0.0 mg/dL" for 0.9, with a confidence of 88 out of 100, higher
 * than some words it read right. So its text is shown at once as a draft, the
 * on-device model reads the page carefully, and every number on which the two
 * readings disagree is pointed out to the person (see compareReadings).
 *
 * Every file it needs (worker, engine, English data) is served by the site
 * itself from /vendor/ocr/: no image and no request leaves for a third party.
 */

export interface OcrResult {
  text: string;
  /** Tesseract's mean word confidence, from 0 to 100. */
  confidence: number;
  /** Words containing a digit that Tesseract itself is unsure of (confidence below 90). */
  unsureNumbers: number;
  ms: number;
}

let worker: Promise<Worker> | null = null;
/** Set when the quick reader did not answer in time: it is not tried again in this visit. */
let givenUp = false;

/**
 * Longest wait for the quick reading, first download included (about 7 MB).
 * Seen in testing: when its language data cannot be loaded, the engine never
 * answers, which must not hold back the careful reading.
 */
export const QUICK_READING_TIMEOUT_MS = 30000;

function vendorUrl(): string {
  return new URL(`${import.meta.env.BASE_URL}vendor/ocr/`, location.href).href;
}

function getWorker(): Promise<Worker> {
  if (!worker) {
    worker = (async () => {
      const { createWorker, OEM } = await import("tesseract.js");
      const base = vendorUrl();
      return createWorker("eng", OEM.LSTM_ONLY, { workerPath: `${base}worker.min.js`, corePath: base, langPath: base, gzip: true });
    })();
    // A failed start is not kept: the next document tries again.
    worker.catch(() => {
      worker = null;
    });
  }
  return worker;
}

interface Word {
  text: string;
  confidence: number;
}

/**
 * Reads the text of an image: a data URL, a Blob or a canvas. Throws if the
 * engine cannot start, or does not answer within QUICK_READING_TIMEOUT_MS.
 */
export async function recognizeText(image: string | Blob | HTMLCanvasElement): Promise<OcrResult> {
  if (givenUp) throw new Error("The quick reader is not available in this visit.");
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      givenUp = true;
      reject(new Error("The quick reader did not answer in time."));
    }, QUICK_READING_TIMEOUT_MS);
  });
  const read = (async () => {
    const w = await getWorker();
    return w.recognize(image, {}, { text: true, blocks: true });
  })();
  const { data } = await Promise.race([read, timeout]).finally(() => clearTimeout(timer));
  const words: Word[] = (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words)));
  return {
    text: data.text ?? "",
    confidence: data.confidence,
    unsureNumbers: words.filter((x) => /\d/.test(x.text) && x.confidence < 90).length,
    ms: Math.round(performance.now() - started),
  };
}

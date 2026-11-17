import { linesFromItems, MAX_PDF_PAGES, SCANNED_PAGE_CHARS, type PdfTextItem } from "../engine/documents";
import type { PageImage } from "../engine/transcribe";

/**
 * Browser-side file handling: decoding images and opening PDFs. Everything
 * runs in this page. The PDF reader (Mozilla's pdf.js) and its worker are part
 * of the app's own files, loaded only when a PDF is picked.
 */

/** Longest side, in pixels, of an image handed to the on-device model. */
const MAX_SIDE = 1600;

function toJpeg(source: CanvasImageSource, width: number, height: number): PageImage {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const g = canvas.getContext("2d");
  if (!g) throw new Error("This browser could not prepare the image.");
  // A white background, so a transparent PNG does not turn black as a JPEG.
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(source, 0, 0, canvas.width, canvas.height);
  return { mimeType: "image/jpeg", base64: canvas.toDataURL("image/jpeg", 0.9).split(",")[1] };
}

/** Decodes a photo and resizes it for the on-device model. */
export async function photoToImage(file: Blob): Promise<PageImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("This image could not be opened. Try a JPG or PNG file.");
  }
  try {
    return toJpeg(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

export interface PdfPage {
  number: number;
  /** Text from the page's text layer. Empty for a scanned page. */
  text: string;
  /** True when the page is a picture of text and has to be read by the model. */
  scanned: boolean;
  /** Draws the page, for a scanned page. */
  render: () => Promise<PageImage>;
}

export interface OpenedPdf {
  /** Pages in the file, which may be more than the pages read. */
  pageCount: number;
  pages: PdfPage[];
  close: () => void;
}

export async function openPdf(data: ArrayBuffer): Promise<OpenedPdf> {
  const pdfjs = await import("pdfjs-dist");
  const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;

  const task = pdfjs.getDocument({
    data: new Uint8Array(data),
    // Image decoders for scanned pages, served with the app. No other file is fetched.
    wasmUrl: `${import.meta.env.BASE_URL}vendor/pdfjs-wasm/`,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "PasswordException") throw new Error("This PDF is protected by a password. Remove the password, or paste its text.");
    throw new Error("This PDF could not be opened. It may be damaged. You can paste its text instead.");
  }

  const pages: PdfPage[] = [];
  for (let n = 1; n <= Math.min(doc.numPages, MAX_PDF_PAGES); n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const items: PdfTextItem[] = [];
    for (const it of content.items) {
      if (!("str" in it)) continue;
      items.push({ str: it.str, x: Number(it.transform[4]), y: Number(it.transform[5]), width: it.width, height: it.height });
    }
    const text = linesFromItems(items);
    pages.push({
      number: n,
      text,
      scanned: text.replace(/\s/g, "").length < SCANNED_PAGE_CHARS,
      render: async () => {
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(2.5, MAX_SIDE / Math.max(base.width, base.height)) });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvas, viewport }).promise;
        return toJpeg(canvas, canvas.width, canvas.height);
      },
    });
  }
  return { pageCount: doc.numPages, pages, close: () => void task.destroy() };
}

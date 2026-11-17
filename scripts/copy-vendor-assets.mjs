// Copies the files that document reading loads at run time from node_modules
// into public/vendor/, so the site serves them itself: no CDN is contacted when
// a document is opened. Runs before `dev` and `build`. public/vendor/ is not
// committed; it is rebuilt from the exact versions in package-lock.json.
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const from = (...p) => resolve(root, "node_modules", ...p);
const out = resolve(root, "public", "vendor");

const files = [
  // pdf.js image decoders, for scanned PDF pages (Apache-2.0 and the licences shipped with them).
  ...["jbig2.wasm", "openjpeg.wasm", "qcms_bg.wasm", "LICENSE_JBIG2", "LICENSE_OPENJPEG", "LICENSE_QCMS", "LICENSE_PDFJS_JBIG2", "LICENSE_PDFJS_OPENJPEG", "LICENSE_PDFJS_QCMS"].map(
    (f) => [from("pdfjs-dist", "wasm", f), resolve(out, "pdfjs-wasm", f)],
  ),
  // Tesseract text recognition (Apache-2.0): worker, the three LSTM builds of the core, English data.
  [from("tesseract.js", "dist", "worker.min.js"), resolve(out, "ocr", "worker.min.js")],
  ...["tesseract-core-relaxedsimd-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js", "tesseract-core-lstm.wasm.js"].map((f) => [
    from("tesseract.js-core", f),
    resolve(out, "ocr", f),
  ]),
  [from("tesseract.js", "LICENSE.md"), resolve(out, "ocr", "LICENSE.md")],
  [from("@tesseract.js-data", "eng", "4.0.0_best_int", "eng.traineddata.gz"), resolve(out, "ocr", "eng.traineddata.gz")],
];

rmSync(out, { recursive: true, force: true });
for (const [src, dst] of files) {
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
}
console.log(`vendor assets: ${files.length} files copied to public/vendor/`);

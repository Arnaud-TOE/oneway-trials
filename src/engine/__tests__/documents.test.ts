import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  appendToRecord,
  carefulReadingMs,
  cleanTranscript,
  compareReadings,
  nearlySame,
  dropRepeatedLines,
  documentXmlToText,
  docxToText,
  kindOf,
  linesFromItems,
  removeFromRecord,
  tidyText,
  unsupportedReason,
  unzipEntry,
} from "../documents";

/** Builds a zip archive in memory, the way Word stores a .docx. No CRC: the reader does not check it. */
function zip(files: Record<string, string>, deflate = true): ArrayBuffer {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
  const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
  for (const [name, content] of Object.entries(files)) {
    const raw = enc.encode(content);
    const data = deflate ? new Uint8Array(deflateRawSync(raw)) : raw;
    const nameBytes = enc.encode(name);
    const method = deflate ? 8 : 0;
    const local = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(method), ...u16(0), ...u16(0),
      ...u32(0), ...u32(data.length), ...u32(raw.length), ...u16(nameBytes.length), ...u16(0),
      ...nameBytes,
    ]);
    central.push(
      new Uint8Array([
        ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(method), ...u16(0), ...u16(0),
        ...u32(0), ...u32(data.length), ...u32(raw.length), ...u16(nameBytes.length), ...u16(0), ...u16(0),
        ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
        ...nameBytes,
      ]),
    );
    chunks.push(local, data);
    offset += local.length + data.length;
  }
  const dirSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length),
    ...u32(dirSize), ...u32(offset), ...u16(0),
  ]);
  const all = [...chunks, ...central, end];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of all) {
    out.set(c, at);
    at += c.length;
  }
  return out.buffer;
}

const WORD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="x"><w:body>
<w:p><w:r><w:t>62-year-old woman, ER 90% &amp; PR 40%.</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Never received </w:t></w:r><w:r><w:t>tamoxifen.</w:t></w:r></w:p>
<w:p><w:del><w:r><w:delText>deleted words</w:delText></w:r></w:del><w:r><w:t>ECOG 1</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Creatinine</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>0.9 mg/dL</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>Platelets</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>210 x10^9/L</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t>Temp &#8805; 38 &#x00B0;C</w:t></w:r></w:p>
</w:body></w:document>`;

describe("which files can be opened", () => {
  it("recognises PDFs, photos, Word files and text, by type or by name", () => {
    expect(kindOf("letter.pdf", "")).toBe("pdf");
    expect(kindOf("scan", "application/pdf")).toBe("pdf");
    expect(kindOf("IMG_2041.JPG", "")).toBe("image");
    expect(kindOf("clipboard", "image/png")).toBe("image");
    expect(kindOf("notes.docx", "")).toBe("docx");
    expect(kindOf("notes.txt", "")).toBe("text");
    expect(kindOf("labs", "text/plain")).toBe("text");
    expect(kindOf("old.doc", "application/msword")).toBeNull();
    expect(kindOf("photo.heic", "image/heic")).toBeNull();
  });

  it("explains what to do with a file it cannot open", () => {
    expect(unsupportedReason("old.doc")).toMatch(/PDF or \.docx/);
    expect(unsupportedReason("photo.HEIC")).toMatch(/JPG or PNG/);
    expect(unsupportedReason("data.xlsx")).toMatch(/PDF, a photo/);
  });
});

describe("text clean-up", () => {
  it("normalises line endings, invisible characters and blank lines", () => {
    expect(tidyText("﻿A\r\nB  \r\n\r\n\r\n\r\nC\u0000 D")).toBe("A\nB\n\nC D");
  });

  it("adds a document after the text already there, and takes it out again", () => {
    const first = appendToRecord("", "Letter one.");
    const both = appendToRecord(first, "Letter two.");
    expect(both).toBe("Letter one.\n\nLetter two.");
    expect(removeFromRecord(both, "Letter one.")).toBe("Letter two.");
    // Edited since: left alone rather than cutting the wrong words.
    expect(removeFromRecord("Letter one, edited.", "Letter one.")).toBe("Letter one, edited.");
  });

  it("strips what a small model adds around a transcription", () => {
    expect(cleanTranscript("```\nECOG 1\nHbA1c 6.9%\n```")).toBe("ECOG 1\nHbA1c 6.9%");
    expect(cleanTranscript("Here is the text in the image:\n\nECOG 1")).toBe("ECOG 1");
    expect(cleanTranscript("ECOG 1")).toBe("ECOG 1");
  });
});

describe("two readings of the same image", () => {
  // Measured on a blurred photo of a lab report: what each reader returned.
  const careful = [
    "Northside Laboratory - Patient report",
    "Collected: 02/11/2026 08:40",
    "Hemoglobin 11.8 g/dL (12.0-15.5) L",
    "Platelets 210 x10^9/L",
    "ANC 2.1 x10^9/L",
    "Creatinine 0.9 mg/dL",
    "Total bilirubin 0.7 mg/dL",
    "HbA1c 6.9 %",
    "Medications: ribociclib 600 mg, letrozole 2.5 mg",
  ].join("\n");
  const quickBlurred =
    "Northside Laboratory - Patient report\n\nCollected: 02/11/2026 08:40\n\nHemoglobin 11.8 g/dL (12.0-15.5) 1\n\nPlatelets 210 x1049/L,\n\nANC2.1x10%9/L\n\nCreatinine 0.0 mg/di,\n\nTotal bilirubin 0,7 mg/dL\nHbA1¢ 6.9 %\nMedications: ribociclib 6oo mg, letrozole 2.5 mg\n";
  const quickClean =
    "Northside Laboratory - Patient report\n\nCollected: 02/11/2026 08:40\n\nHemoglobin 11.8 g/dL (12.0-15.5) L\n\nPlatelets 210 x1029/L\n\nANC 2.1 x10”9/L\n\nCreatinine 0.9 mg/dL\n\nTotal bilirubin 0.7 mg/dL\n\nHbA1c 6.9 %\n\nMedications: ribociclib 600 mg, letrozole 2.5 mg\n";

  it("points out exactly the lines where a number was read differently", () => {
    expect(compareReadings(careful, quickBlurred)).toEqual(["Creatinine 0.9 mg/dL", "Medications: ribociclib 600 mg, letrozole 2.5 mg"]);
  });

  it("finds nothing to check when the two readings agree on every number", () => {
    expect(compareReadings(careful, quickClean)).toEqual([]);
  });

  it("points out a drug name the two readings spell differently", () => {
    // Seen in testing: the careful reading wrote "osimeratinib" for osimertinib.
    const carefulNote = "58-year-old man, lung cancer.\nTreated with osimeratinib since 2025. ECOG 1.";
    const quickNote = "58-year-old man, lung cancer.\nTreated with osimertinib since 2025. ECOG 1.";
    expect(compareReadings(carefulNote, quickNote)).toEqual(["Treated with osimeratinib since 2025. ECOG 1."]);
  });

  it("does not flag a word the quick reading simply missed", () => {
    expect(compareReadings("Treated with osimertinib since 2025.", "Treated with since 2025.")).toEqual([]);
  });

  it("tells near spellings from different words", () => {
    expect(nearlySame("osimeratinib", "osimertinib")).toBe(true);
    expect(nearlySame("letrozole", "letrozole")).toBe(false);
    expect(nearlySame("ribociclib", "palbociclib")).toBe(false);
  });

  it("estimates the careful reading from the length of the page", () => {
    expect(carefulReadingMs(250)).toBe(40000);
    expect(carefulReadingMs(2000)).toBeGreaterThan(150000);
  });
});

describe("text repeated on every page", () => {
  it("keeps the letterhead once and drops page numbers", () => {
    const pages = [
      "Riverside Oncology Clinic\nPatient: J. Doe, DOB 01/02/1964\nClinic letter, page one.\nPage 1 of 3",
      "Riverside Oncology Clinic\nPatient: J. Doe, DOB 01/02/1964\nLabs: creatinine 0.8 mg/dL.\nPage 2 of 3",
      "Riverside Oncology Clinic\nPatient: J. Doe, DOB 01/02/1964\nPlan: review in 3 months.\nPage 3 of 3",
    ];
    expect(dropRepeatedLines(pages)).toEqual([
      "Riverside Oncology Clinic\nPatient: J. Doe, DOB 01/02/1964\nClinic letter, page one.",
      "Labs: creatinine 0.8 mg/dL.",
      "Plan: review in 3 months.",
    ]);
  });

  it("never drops a result because it looks like one on another page", () => {
    const pages = ["Visit 1\nCreatinine 0.9 mg/dL\nBP 120/80\n12", "Visit 2\nCreatinine 1.1 mg/dL\nBP 120/80\n12"];
    // Different values are two lines: both kept. A line repeated word for word is kept once, where it first appears.
    expect(dropRepeatedLines(pages)).toEqual(["Visit 1\nCreatinine 0.9 mg/dL\nBP 120/80\n12", "Visit 2\nCreatinine 1.1 mg/dL"]);
  });

  it("leaves a single page alone", () => {
    expect(dropRepeatedLines(["Page 1 of 1\nText"])).toEqual(["Page 1 of 1\nText"]);
  });
});

describe("PDF text layer", () => {
  it("rebuilds lines in reading order, top to bottom and left to right", () => {
    const text = linesFromItems([
      { str: "Labs:", x: 50, y: 700, width: 30, height: 10 },
      { str: "creatinine 0.9 mg/dL", x: 84, y: 700.4, width: 110, height: 10 },
      { str: "Patient: 62-year-old woman", x: 50, y: 740, width: 150, height: 10 },
      { str: "ECOG 1", x: 50, y: 686, width: 40, height: 10 },
      { str: "Page 1", x: 50, y: 60, width: 30, height: 10 },
      { str: " ", x: 0, y: 500, width: 2, height: 10 },
    ]);
    expect(text).toBe("Patient: 62-year-old woman\n\nLabs: creatinine 0.9 mg/dL\nECOG 1\n\nPage 1");
  });

  it("returns nothing for a page with no text layer", () => {
    expect(linesFromItems([])).toBe("");
  });
});

describe("Word documents", () => {
  it("keeps paragraphs and table rows, decodes entities, skips deleted text", () => {
    expect(documentXmlToText(WORD_XML)).toBe(
      "62-year-old woman, ER 90% & PR 40%.\nNever received tamoxifen.\nECOG 1\nCreatinine   0.9 mg/dL\nPlatelets   210 x10^9/L\nTemp ≥ 38 °C",
    );
  });

  it("opens a real .docx archive, compressed or stored", async () => {
    const compressed = zip({ "[Content_Types].xml": "<Types/>", "word/document.xml": WORD_XML });
    expect(await docxToText(compressed)).toContain("Never received tamoxifen.");
    const stored = zip({ "word/document.xml": WORD_XML }, false);
    expect(await docxToText(stored)).toContain("Creatinine   0.9 mg/dL");
  });

  it("refuses a file that is not a Word document", async () => {
    await expect(docxToText(new TextEncoder().encode("not a zip at all").buffer as ArrayBuffer)).rejects.toThrow(/not a Word document/);
    expect(await unzipEntry(zip({ "other.xml": "<x/>" }), "word/document.xml")).toBeNull();
  });
});

/**
 * Long records, read in parts.
 *
 * The on-device model reads at most about 9,000 characters at a time. A longer
 * record is no longer cut short: it is split into parts that each fit, at line
 * breaks, with a small overlap so a sentence or a table row cut in two is read
 * whole in one of the parts. Every part is read on the device.
 *
 * A record that fits in one part is read exactly as before, so the measured
 * results on the evaluation bench (notes of at most 1,447 characters) are
 * unchanged by this file.
 */

/** Characters the on-device model reads in one call. */
export const PART_CHARS = 9000;
/** Characters repeated at the start of the next part. */
export const PART_OVERLAP = 400;
/** Parts read at most: beyond this, checking a trial would take too long on a laptop. */
export const MAX_PARTS = 6;

function hardSplit(text: string, size: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > size) {
    // Cut at the last sentence end or space before the limit, if there is one.
    const window = rest.slice(0, size);
    const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("; "));
    const space = window.lastIndexOf(" ");
    const cut = sentence > size * 0.5 ? sentence + 1 : space > size * 0.5 ? space : size;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Splits a record into parts of at most `size` characters. A short record is one part, unchanged. */
export function recordParts(record: string, size = PART_CHARS, overlap = PART_OVERLAP): string[] {
  if (record.length <= size) return [record];
  const lines = record.split("\n").flatMap((line) => (line.length > size - overlap ? hardSplit(line, size - overlap) : [line]));
  const parts: string[] = [];
  let current: string[] = [];
  let length = 0;
  for (const line of lines) {
    const extra = line.length + (current.length > 0 ? 1 : 0);
    if (length + extra > size && current.length > 0) {
      parts.push(current.join("\n"));
      // Carry the last lines over, up to `overlap` characters.
      const carried: string[] = [];
      let carriedLength = 0;
      for (let i = current.length - 1; i >= 0; i--) {
        const l = current[i].length + 1;
        if (carriedLength + l > overlap) break;
        carried.unshift(current[i]);
        carriedLength += l;
      }
      current = carried;
      length = carried.join("\n").length;
    }
    current.push(line);
    length += line.length + (current.length > 1 ? 1 : 0);
  }
  if (current.length > 0) parts.push(current.join("\n"));
  return parts;
}

/** How many parts a record needs, before the cap. */
export function partsNeeded(record: string): number {
  return recordParts(record).length;
}

/** The parts that are read: all of them, up to MAX_PARTS. */
export function readableParts(record: string): string[] {
  return recordParts(record).slice(0, MAX_PARTS);
}

/** Characters read when the record needs more than MAX_PARTS parts. */
export function readableChars(record: string): number {
  const parts = recordParts(record);
  if (parts.length <= MAX_PARTS) return record.length;
  // The parts overlap, so this is where the last part read ends in the record.
  const last = parts[MAX_PARTS - 1];
  const at = record.indexOf(last);
  return at >= 0 ? at + last.length : MAX_PARTS * (PART_CHARS - PART_OVERLAP);
}

const STOP_WORDS = new Set(
  "this that with from have does patient patients record their there than they them were been being which what when will would should could about into only also more most other such than then these those your yours under over within least last days weeks months years study during".split(" "),
);

function words(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).filter((w) => !STOP_WORDS.has(w)))];
}

/**
 * The order in which the parts are asked about one question: the parts that
 * share the most words with it first, then the others in reading order. Every
 * part is still asked unless a part gives a quoted "yes" first.
 */
export function rankParts(parts: string[], question: string): number[] {
  const wanted = words(question);
  const score = parts.map((p) => {
    const lower = p.toLowerCase();
    return wanted.filter((w) => lower.includes(w)).length;
  });
  return parts.map((_, i) => i).sort((a, b) => score[b] - score[a] || a - b);
}

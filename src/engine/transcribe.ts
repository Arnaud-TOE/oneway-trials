import { generateStream, InferenceMode } from "../lib/hybrid";
import { cleanTranscript } from "./documents";

/**
 * Reading a photo or a scanned page of a medical document.
 *
 * This is always ONLY_ON_DEVICE: a picture of a record is as private as the
 * record. If the on-device model cannot take images in this browser, the call
 * throws and nothing is sent anywhere.
 *
 * Measured on the development laptop (no graphics card): about 85 seconds for a
 * typed page of 700 characters, with one misspelt drug name. The interface
 * therefore shows the text as it is written and asks the person to check the
 * numbers against the document.
 */
export const TRANSCRIBE_PROMPT = `Transcribe all the text in this image exactly as it is written, line by line.
Copy every number, unit, date and name exactly. Do not summarise, correct, translate or add anything.
If part of the image cannot be read, write [unreadable] in its place.
Output only the text.`;

export interface PageImage {
  mimeType: "image/jpeg" | "image/png";
  base64: string;
}

export async function transcribeImage(
  image: PageImage,
  label: string,
  onText?: (soFar: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const res = await generateStream(
    {
      mode: InferenceMode.ONLY_ON_DEVICE,
      label,
      kind: "transcribe",
      prompt: TRANSCRIBE_PROMPT,
      image,
      signal,
    },
    (soFar) => onText?.(soFar),
  );
  return cleanTranscript(res.text);
}

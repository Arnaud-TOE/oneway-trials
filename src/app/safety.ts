/**
 * Emergency gate. A plain keyword check that runs locally before anything else.
 * It does not diagnose; it only makes sure someone describing an emergency sees
 * where to get immediate help before reading about clinical trials.
 */
const URGENT = [
  /\bsuicid/i,
  /\bkill (myself|himself|herself|themselves)\b/i,
  /\bend (my|his|her|their) life\b/i,
  /\boverdos/i,
  /\bchest pain\b/i,
  /\bcan(no|')?t breathe\b/i,
  /\bshortness of breath at rest\b/i,
  /\bstroke symptoms\b/i,
  /\bunresponsive\b/i,
  /\bsevere bleeding\b/i,
  /\banaphyla/i,
];

export function looksUrgent(record: string): boolean {
  return URGENT.some((p) => p.test(record));
}

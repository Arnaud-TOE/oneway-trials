import { ledger } from "./ledger";
import { privacyGuard } from "./privacy";
import type { Profile, Trial } from "./types";

const API = "https://clinicaltrials.gov/api/v2/studies";

const FIELDS = [
  "NCTId",
  "BriefTitle",
  "BriefSummary",
  "Condition",
  "EligibilityCriteria",
  "MinimumAge",
  "MaximumAge",
  "Sex",
  "HealthyVolunteers",
  "StudyType",
  "Phase",
  "LocationFacility",
  "LocationCity",
  "LocationState",
  "LocationCountry",
  "LocationStatus",
  "LocationContactName",
  "LocationContactPhone",
  "LocationContactEMail",
  "CentralContactName",
  "CentralContactPhone",
  "CentralContactEMail",
  "LeadSponsorName",
  "OverallStatus",
  "LastUpdatePostDate",
].join(",");

/** A public contact published in the registry for a trial or one of its sites. */
export interface TrialContact {
  name: string;
  phone: string;
  email: string;
}

function contactsOf(list: unknown): TrialContact[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((c: Raw) => ({ name: String(c?.name ?? "").trim(), phone: String(c?.phone ?? "").trim(), email: String(c?.email ?? "").trim() }))
    .filter((c) => c.phone || c.email);
}

/** Parses registry ages such as "18 Years" or "6 Months" into years. */
export function parseAgeYears(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(year|month|week|day|hour|minute)s?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2].toLowerCase()) {
    case "year":
      return n;
    case "month":
      return n / 12;
    case "week":
      return n / 52;
    case "day":
      return n / 365;
    default:
      return 0;
  }
}

type Raw = Record<string, any>;

/** Converts one ClinicalTrials.gov v2 study record into the app's Trial shape. */
export function parseStudy(study: Raw): Trial | null {
  const p: Raw = study?.protocolSection ?? {};
  const nctId: unknown = p.identificationModule?.nctId;
  const criteriaText: unknown = p.eligibilityModule?.eligibilityCriteria;
  if (typeof nctId !== "string" || typeof criteriaText !== "string" || !criteriaText.trim()) return null;
  const sexRaw = String(p.eligibilityModule?.sex ?? "ALL").toUpperCase();
  const locations: Raw[] = Array.isArray(p.contactsLocationsModule?.locations) ? p.contactsLocationsModule.locations : [];
  return {
    nctId,
    title: String(p.identificationModule?.briefTitle ?? nctId),
    summary: String(p.descriptionModule?.briefSummary ?? ""),
    conditions: Array.isArray(p.conditionsModule?.conditions) ? p.conditionsModule.conditions.map(String) : [],
    sponsor: String(p.sponsorCollaboratorsModule?.leadSponsor?.name ?? ""),
    phases: Array.isArray(p.designModule?.phases) ? p.designModule.phases.map(String) : [],
    studyType: String(p.designModule?.studyType ?? ""),
    status: String(p.statusModule?.overallStatus ?? ""),
    // The registry escapes comparison signs with a backslash.
    criteriaText: criteriaText.replace(/\\([<>=])/g, "$1"),
    minAgeYears: parseAgeYears(p.eligibilityModule?.minimumAge),
    maxAgeYears: parseAgeYears(p.eligibilityModule?.maximumAge),
    sex: sexRaw === "FEMALE" || sexRaw === "MALE" ? sexRaw : "ALL",
    healthyVolunteers: Boolean(p.eligibilityModule?.healthyVolunteers),
    locations: locations.map((l) => ({
      facility: String(l.facility ?? ""),
      city: String(l.city ?? ""),
      state: String(l.state ?? ""),
      country: String(l.country ?? ""),
      ...(l.status ? { status: String(l.status) } : {}),
      ...(contactsOf(l.contacts).length ? { contacts: contactsOf(l.contacts) } : {}),
    })),
    contacts: contactsOf(p.contactsLocationsModule?.centralContacts),
    updatedOn: String(p.statusModule?.lastUpdatePostDateStruct?.date ?? ""),
    url: `https://clinicaltrials.gov/study/${nctId}`,
  };
}

export interface TrialQuery {
  /** Condition name. This is the only health information sent to the registry, and the person approves it first. */
  condition: string;
  /** Optional city, state or country. */
  location?: string;
  pageSize?: number;
}

export function buildSearchUrl(q: TrialQuery): string {
  const params = new URLSearchParams();
  params.set("query.cond", q.condition.trim());
  if (q.location?.trim()) params.set("query.locn", q.location.trim());
  params.set("filter.overallStatus", "RECRUITING");
  params.set("pageSize", String(q.pageSize ?? 12));
  params.set("fields", FIELDS);
  return `${API}?${params.toString()}`;
}

/**
 * Searches the public registry. Deliberately coarse: age, sex and everything else
 * in the profile are NOT sent as filters. Narrowing happens locally in `prefilter`.
 */
export async function searchTrials(q: TrialQuery, fetchImpl: typeof fetch = fetch): Promise<Trial[]> {
  const condition = q.condition.trim();
  if (!condition) throw new Error("A condition is needed to search the registry.");
  if (condition.length > 60 || condition.split(/\s+/).length > 5) {
    throw new Error("The search term must be a short, general condition name.");
  }
  // The query may name a condition, but it may not carry a passage of the record.
  privacyGuard.assertPublic(`${condition} ${q.location ?? ""}`, "ClinicalTrials.gov");
  const url = buildSearchUrl(q);
  const started = performance.now();
  const res = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`ClinicalTrials.gov answered ${res.status}`);
  const json = (await res.json()) as { studies?: Raw[] };
  const trials = (json.studies ?? []).map(parseStudy).filter((t): t is Trial => t !== null);
  ledger.record({
    lane: "outbound",
    destination: "ClinicalTrials.gov",
    label: `Searched the public registry (${trials.length} recruiting studies returned)`,
    kind: "search",
    ms: Math.round(performance.now() - started),
    payload: `condition: ${q.condition.trim()}${q.location?.trim() ? `\nlocation: ${q.location.trim()}` : ""}`,
  });
  return trials;
}

export interface PrefilterDecision {
  keep: boolean;
  reason: string;
}

/**
 * Local, model-free screening on the registry's structured fields. Runs on the
 * device with the private profile, so the registry never learns age or sex.
 */
export function prefilter(trial: Trial, profile: Profile): PrefilterDecision {
  if (profile.age !== null) {
    if (trial.minAgeYears !== null && profile.age < trial.minAgeYears) {
      return { keep: false, reason: `Minimum age is ${trial.minAgeYears}` };
    }
    if (trial.maxAgeYears !== null && profile.age > trial.maxAgeYears) {
      return { keep: false, reason: `Maximum age is ${trial.maxAgeYears}` };
    }
  }
  if (trial.sex !== "ALL" && profile.sex !== "unknown" && trial.sex.toLowerCase() !== profile.sex) {
    return { keep: false, reason: `Open to ${trial.sex.toLowerCase()} participants only` };
  }
  return { keep: true, reason: "" };
}

/** Observational registries are listed separately from trials that test a treatment. */
export function isInterventional(trial: Trial): boolean {
  return trial.studyType.toUpperCase() === "INTERVENTIONAL";
}

import type { ContactItem, DeltaResult, SelfIdentity } from "../types.js";
import { googleGet, SyncTokenExpiredError } from "./http.js";

/** Thin Google People REST client: incremental contact sync + the "me" profile. */

const BASE = "https://people.googleapis.com/v1";
const PERSON_FIELDS =
  "names,nicknames,emailAddresses,phoneNumbers,organizations,birthdays,metadata";

interface PersonName {
  displayName?: string;
}
interface PersonEmail {
  value?: string;
}
interface PersonPhone {
  value?: string;
}
interface PersonOrg {
  name?: string;
  title?: string;
}
interface PersonBirthday {
  date?: { year?: number; month?: number; day?: number };
}
interface Person {
  resourceName: string;
  names?: PersonName[];
  nicknames?: Array<{ value?: string }>;
  emailAddresses?: PersonEmail[];
  phoneNumbers?: PersonPhone[];
  organizations?: PersonOrg[];
  birthdays?: PersonBirthday[];
  metadata?: { deleted?: boolean };
}
interface ConnectionsResponse {
  connections?: Person[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

function formatBirthday(b?: PersonBirthday): string | undefined {
  const d = b?.date;
  if (!d || d.month == null || d.day == null) return undefined;
  const mm = String(d.month).padStart(2, "0");
  const dd = String(d.day).padStart(2, "0");
  return d.year ? `${d.year}-${mm}-${dd}` : `${mm}-${dd}`;
}

function normalize(person: Person): ContactItem {
  const id = person.resourceName.replace(/^people\//, "");
  return {
    externalId: person.resourceName,
    displayName: person.names?.[0]?.displayName?.trim() || "Unknown contact",
    nicknames: (person.nicknames ?? []).map((n) => n.value?.trim()).filter((v): v is string => !!v),
    emails: (person.emailAddresses ?? [])
      .map((e) => e.value?.trim())
      .filter((v): v is string => !!v),
    phones: (person.phoneNumbers ?? []).map((p) => p.value?.trim()).filter((v): v is string => !!v),
    organisation: person.organizations?.[0]?.name?.trim() || undefined,
    jobTitle: person.organizations?.[0]?.title?.trim() || undefined,
    birthday: formatBirthday(person.birthdays?.[0]),
    deepLink: `https://contacts.google.com/person/${id}`,
  };
}

/** The account owner's name + email, for anchoring "knows" edges to you. */
export async function fetchSelf(accessToken: string): Promise<SelfIdentity> {
  const data = await googleGet<{ names?: PersonName[]; emailAddresses?: PersonEmail[] }>(
    `${BASE}/people/me?personFields=names,emailAddresses`,
    accessToken,
  );
  return {
    name: data.names?.[0]?.displayName?.trim() || data.emailAddresses?.[0]?.value?.trim() || "Me",
    email: data.emailAddresses?.[0]?.value?.trim() || "",
  };
}

/**
 * Pull contacts changed since `syncToken` (or all, on first run), following
 * pagination. Returns the items, the next cursor to persist, and deletions. A
 * stale cursor surfaces as `fullResync` so the caller re-pulls from scratch.
 */
export async function fetchContactsDelta(
  accessToken: string,
  syncToken?: string | null,
): Promise<DeltaResult<ContactItem>> {
  const items: ContactItem[] = [];
  const deletions: string[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;

  try {
    do {
      const params = new URLSearchParams({
        personFields: PERSON_FIELDS,
        pageSize: "200",
        requestSyncToken: "true",
      });
      if (syncToken) params.set("syncToken", syncToken);
      if (pageToken) params.set("pageToken", pageToken);

      const data = await googleGet<ConnectionsResponse>(
        `${BASE}/people/me/connections?${params.toString()}`,
        accessToken,
      );
      for (const person of data.connections ?? []) {
        if (person.metadata?.deleted) deletions.push(person.resourceName);
        else items.push(normalize(person));
      }
      pageToken = data.nextPageToken;
      nextSyncToken = data.nextSyncToken ?? nextSyncToken;
    } while (pageToken);
  } catch (error) {
    if (error instanceof SyncTokenExpiredError)
      return { items: [], deletions: [], fullResync: true };
    throw error;
  }

  return { items, deletions, nextSyncToken: nextSyncToken ?? null };
}

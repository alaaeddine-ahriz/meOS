import type { Extraction } from "../../extract/schema.js";
import type { ContactItem } from "../types.js";
import { observation, personEntity } from "./helpers.js";

/**
 * Map a Google contact to an extraction: one person entity plus typed facts.
 * Email and phone are tagged `private` so they're searchable but stay out of the
 * git-synced wiki (the existing `visibleObservations()` boundary). Contacts are
 * user-curated, so confidence is high.
 */
export function mapContact(item: ContactItem): Extraction {
  const name = item.displayName;
  // Emails also become aliases so a future merge can fold a calendar attendee or
  // email sender with the same address into this person (name match today; an
  // email-keyed resolver is a noted follow-up).
  const aliases = [...item.nicknames, ...item.emails];
  const observations: Extraction["observations"] = [];

  for (const email of item.emails) {
    observations.push(
      observation({
        entity: name,
        claim: `${name}'s email is ${email}.`,
        kind: "fact",
        confidence: 0.9,
        sensitivity: "private",
      }),
    );
  }
  for (const phone of item.phones) {
    observations.push(
      observation({
        entity: name,
        claim: `${name}'s phone number is ${phone}.`,
        kind: "fact",
        confidence: 0.9,
        sensitivity: "private",
      }),
    );
  }
  if (item.organisation) {
    observations.push(
      observation({
        entity: name,
        claim: `${name} works at ${item.organisation}.`,
        kind: "fact",
        confidence: 0.85,
      }),
    );
  }
  if (item.jobTitle) {
    observations.push(
      observation({
        entity: name,
        claim: `${name}'s role is ${item.jobTitle}.`,
        kind: "fact",
        confidence: 0.85,
      }),
    );
  }
  if (item.birthday) {
    observations.push(
      observation({
        entity: name,
        claim: `${name}'s birthday is ${item.birthday}.`,
        kind: "fact",
        confidence: 0.85,
        sensitivity: "private",
      }),
    );
  }

  const relationships: Extraction["relationships"] = [];
  if (item.organisation) {
    relationships.push({ from: name, to: item.organisation, label: "works at" });
  }

  const entities = [personEntity({ name, aliases })];
  if (item.organisation) {
    entities.push({
      name: item.organisation,
      type: "organisation",
      aliases: [],
      summary: "",
      relevance: "high",
    });
  }

  return { entities, relationships, observations };
}

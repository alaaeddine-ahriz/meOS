import type { Extraction } from "../../extract/schema.js";
import type { ObservationKind, Sensitivity } from "../../knowledge/schema-doc.js";

type EntityInput = Extraction["entities"][number];
type ObservationInput = Extraction["observations"][number];

/**
 * A person entity for a connector item. Always `relevance: "high"` so the merge
 * relevance gate (which suppresses brand-new low-relevance entities) never drops
 * a real person from the user's contacts/calendar/inbox.
 */
export function personEntity(input: {
  name: string;
  aliases?: string[];
  summary?: string;
}): EntityInput {
  return {
    name: input.name,
    type: "person",
    aliases: input.aliases ?? [],
    summary: input.summary ?? "",
    relevance: "high",
  };
}

/**
 * An observation with the full schema shape filled in. Connector facts are
 * deterministic, so there's no source quote to cite (`sourceQuote: null`).
 */
export function observation(input: {
  entity: string;
  claim: string;
  kind: ObservationKind;
  confidence: number;
  sensitivity?: Sensitivity;
  validFrom?: string | null;
}): ObservationInput {
  return {
    entity: input.entity,
    claim: input.claim,
    kind: input.kind,
    sourceQuote: null,
    validFrom: input.validFrom ?? null,
    validUntil: null,
    confidence: input.confidence,
    sensitivity: input.sensitivity ?? "normal",
  };
}

/** A best-effort display name from an email address ("ada.lovelace@x" → "Ada Lovelace"). */
export function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  const words = local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.join(" ") || email;
}

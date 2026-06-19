import type { Extraction } from "../../extract/schema.js";
import type { SelfIdentity } from "../types.js";
import { nameFromEmail, observation, personEntity } from "./helpers.js";

/** A provider-agnostic email correspondent (sender or recipient). */
export interface EmailAddress {
  name?: string;
  email: string;
}

/**
 * The minimal, provider-agnostic shape an email mapper needs: subject + date +
 * correspondents. IMAP envelopes and Gmail metadata both reduce to this, so the
 * mapping below is shared regardless of the source connector.
 */
export interface EmailMessageMeta {
  subject: string;
  /** ISO date the message was sent, or null when the header is missing. */
  date?: string | null;
  from: EmailAddress;
  to: EmailAddress[];
}

/**
 * Map an email's metadata to an extraction: a person entity per correspondent, a
 * dated `event` observation recording the exchange (metadata only — subject +
 * date, never the body), and a `knows` edge between you and them. The exchange
 * fact is `private` so it stays out of the git-synced wiki. Deterministic — the
 * IMAP connector reuses Gmail's exact email→graph posture.
 */
export function mapEmailMessage(item: EmailMessageMeta, self: SelfIdentity): Extraction {
  const selfEmail = self.email.toLowerCase();
  const isSelf = (email: string) => selfEmail && email.toLowerCase() === selfEmail;

  // Correspondents = everyone on the message who isn't you (sender + recipients).
  const parties = [item.from, ...item.to].filter((p) => p.email && !isSelf(p.email));
  const byEmail = new Map(parties.map((p) => [p.email.toLowerCase(), p]));
  const correspondents = [...byEmail.values()].map((p) => ({
    name: p.name?.trim() || nameFromEmail(p.email),
    email: p.email,
  }));
  if (correspondents.length === 0) return { entities: [], relationships: [], observations: [] };

  const date = item.date ? item.date.slice(0, 10) : null;
  const when = date ? ` on ${date}` : "";

  const entities: Extraction["entities"] = correspondents.map((c) =>
    personEntity({ name: c.name, aliases: [c.email] }),
  );
  const observations: Extraction["observations"] = correspondents.map((c) =>
    observation({
      entity: c.name,
      claim: `Exchanged email "${item.subject}"${when}.`,
      kind: "event",
      confidence: 0.75,
      sensitivity: "private",
      validFrom: date,
    }),
  );

  const relationships: Extraction["relationships"] = [];
  // Anchor "knows" edges to you only when we know your name.
  if (self.name) {
    entities.push(personEntity({ name: self.name, aliases: self.email ? [self.email] : [] }));
    for (const c of correspondents) {
      relationships.push({ from: self.name, to: c.name, label: "knows" });
    }
  }

  return { entities, relationships, observations };
}

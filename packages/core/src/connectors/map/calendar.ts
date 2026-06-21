import type { Extraction } from "../../extract/schema.js";
import type { CalendarEventItem, SelfIdentity } from "../types.js";
import { nameFromEmail, observation, personEntity } from "./helpers.js";

/**
 * Map a calendar event to an extraction: a person entity per attendee, a dated
 * `event` observation tying each co-attendee to the meeting, and `knows` edges
 * between everyone who attended. The account owner is folded in under their real
 * name (so edges connect to "you" rather than a bare email). A future-dated
 * event surfaces as "upcoming" via the existing temporal layer.
 */
export function mapCalendarEvent(item: CalendarEventItem, self: SelfIdentity): Extraction {
  // Resolve every attendee to a display name, mapping the owner to `self.name`.
  const people = item.attendees.map((a) => {
    const isSelf = Boolean(
      a.self || (self.email && a.email.toLowerCase() === self.email.toLowerCase()),
    );
    return {
      name: isSelf ? self.name : a.name?.trim() || nameFromEmail(a.email),
      email: a.email,
      isSelf,
    };
  });
  // Dedupe by name (an attendee list can repeat the owner across calendars).
  const byName = new Map(people.map((p) => [p.name.toLowerCase(), p]));
  const unique = [...byName.values()];

  const entities: Extraction["entities"] = unique.map((p) =>
    personEntity({ name: p.name, aliases: [p.email] }),
  );

  const observations: Extraction["observations"] = [];
  const date = item.start ? item.start.slice(0, 10) : null;
  const when = date ? ` on ${date}` : "";
  for (const person of unique) {
    if (person.isSelf) continue;
    const others = unique.filter((p) => p !== person).map((p) => p.name);
    const withClause = others.length ? ` with ${others.join(", ")}` : "";
    observations.push(
      observation({
        entity: person.name,
        claim: `Met at "${item.title}"${when}${withClause}.`,
        kind: "event",
        confidence: 0.8,
        validFrom: date,
      }),
    );
  }

  // `knows` between every pair of attendees (small meetings — fine to enumerate).
  const relationships: Extraction["relationships"] = [];
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      relationships.push({ from: unique[i]!.name, to: unique[j]!.name, label: "knows" });
    }
  }

  return { entities, relationships, observations };
}

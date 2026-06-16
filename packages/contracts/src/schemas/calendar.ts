import { z } from "zod";

/**
 * Calendar events surfaced for `@`-mention autocomplete. Read-only projection of
 * the synced `google:calendar` sources — enough to render a chip and prefill a
 * meeting note's date + attendees.
 */

/** One event in the `@`-mention picker. */
export const CalendarEventSchema = z.object({
  /** The materialized source id (stable local handle). */
  sourceId: z.number(),
  /** The provider's event id, when known. */
  externalId: z.string().nullable(),
  title: z.string(),
  /** ISO start (date or date-time), or null when unknown. */
  start: z.string().nullable(),
  attendees: z.array(z.string()),
  /** Deep link back into the provider's calendar. */
  htmlLink: z.string(),
});

/** GET /api/calendar/events?q=&limit= */
export const ListCalendarEventsResponse = z.object({
  events: z.array(CalendarEventSchema),
});

export type CalendarEvent = z.infer<typeof CalendarEventSchema>;

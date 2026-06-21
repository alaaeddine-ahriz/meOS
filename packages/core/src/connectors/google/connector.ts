/**
 * Google behind the connector framework (#5). The first {@link Connector}: it
 * keeps the thin REST clients (people/calendar/gmail) and the deterministic
 * mappers as its normalize step, and exposes the OAuth client as its
 * {@link OAuthProvider}. Adding a second provider means writing a sibling of this
 * file — the orchestrator never learns Google's name.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type {
  AgentToolContext,
  Connector,
  ConnectorManifest,
  NormalizedDelta,
  NormalizedItem,
  OAuthProvider,
  SyncContext,
} from "../framework.js";
import { mapCalendarEvent } from "../map/calendar.js";
import { mapContact } from "../map/contacts.js";
import { mapGmailMessage } from "../map/gmail.js";
import { mapTask } from "../map/tasks.js";
import type {
  CalendarEventItem,
  CalendarListEntry,
  ContactItem,
  DeltaResult,
  GmailMessageItem,
  SelfIdentity,
  TaskItem,
} from "../types.js";
import { fetchCalendarDelta, fetchCalendarList, searchCalendarEvents } from "./calendar.js";
import { fetchGmailDelta, searchThreadsText } from "./gmail.js";
import { createTask, fetchTasksDelta, listTaskLists, listTasks } from "./tasks.js";
import {
  buildAuthUrl,
  exchangeCode,
  GOOGLE_SCOPES,
  refreshAccessToken,
  revokeToken,
} from "./oauth.js";
import { fetchContactsDelta, fetchSelf, searchContacts } from "./people.js";

/** The Google connector's static description: id, kinds, auth model. */
export const GOOGLE_MANIFEST: ConnectorManifest = {
  id: "google",
  displayName: "Google",
  logo: "google",
  summary: "Index your contacts, calendar, email and tasks.",
  brandColor: "#4285F4",
  auth: { kind: "oauth2", scopes: GOOGLE_SCOPES },
  kinds: [
    {
      kind: "contacts",
      displayName: "Contacts",
      sourceType: "google:contacts",
      contentMode: "metadata",
      defaultIntervalMinutes: 60,
      logo: "google-contacts",
      noun: { one: "contact", many: "contacts" },
      blurb: "The people you know, as entities in your graph.",
      // An address book records that people exist; it doesn't author content about
      // them. A contact stays searchable but earns no page until a calendar event,
      // email, or note names them. Calendar/Gmail/Tasks below are content, so they
      // are wiki-eligible (private — local wiki only — but not directory).
      directory: true,
    },
    {
      kind: "calendar",
      displayName: "Calendar",
      sourceType: "google:calendar",
      contentMode: "metadata",
      defaultIntervalMinutes: 30,
      logo: "google-calendar",
      noun: { one: "event", many: "events" },
      blurb: "Your events and who you meet with.",
      capabilities: { coverageWindow: true, subResources: "calendars" },
    },
    {
      kind: "gmail",
      displayName: "Gmail",
      sourceType: "google:gmail",
      contentMode: "metadata",
      defaultIntervalMinutes: 15,
      logo: "gmail",
      noun: { one: "email", many: "emails" },
      blurb: "Email metadata, and optionally message content.",
      capabilities: { coverageWindow: true, labelFilters: true },
    },
    {
      kind: "tasks",
      displayName: "Tasks",
      sourceType: "google:tasks",
      contentMode: "metadata",
      defaultIntervalMinutes: 30,
      logo: "google-tasks",
      noun: { one: "task", many: "tasks" },
      blurb: "Your to-dos — the agent can read and create them.",
      capabilities: { subResources: "taskLists", writeable: true },
    },
  ],
};

/** Google's OAuth surface, the framework's {@link OAuthProvider} over `oauth.ts`. */
const oauth: OAuthProvider = {
  scopes: GOOGLE_SCOPES,
  buildAuthUrl,
  exchangeCode,
  refreshAccessToken,
  revokeToken,
};

/**
 * A human-readable rendering of a Google item — the NORMALIZED text that gets
 * chunked, embedded, indexed, and extracted (#19). Kept terse and label-led so
 * the document is searchable by the same phrases a user would type, without
 * leaking the raw API envelope into retrieval.
 */
function renderContact(c: ContactItem): string {
  const lines = [`Contact: ${c.displayName}`];
  if (c.nicknames?.length) lines.push(`Also known as: ${c.nicknames.join(", ")}`);
  if (c.emails?.length) lines.push(`Email: ${c.emails.join(", ")}`);
  if (c.phones?.length) lines.push(`Phone: ${c.phones.join(", ")}`);
  if (c.organisation) lines.push(`Organisation: ${c.organisation}`);
  if (c.jobTitle) lines.push(`Role: ${c.jobTitle}`);
  if (c.birthday) lines.push(`Birthday: ${c.birthday}`);
  return lines.join("\n");
}

function renderEvent(e: CalendarEventItem): string {
  const lines = [`Event: ${e.title}`];
  if (e.start) lines.push(`When: ${e.start}`);
  if (e.organiserEmail) lines.push(`Organiser: ${e.organiserEmail}`);
  if (e.attendees?.length)
    lines.push(`Attendees: ${e.attendees.map((a) => a.name || a.email).join(", ")}`);
  return lines.join("\n");
}

function renderTask(t: TaskItem): string {
  const lines = [`Task: ${t.title}`];
  lines.push(`Status: ${t.completed ? "completed" : "to do"}`);
  if (t.due) lines.push(`Due: ${t.due.slice(0, 10)}`);
  if (t.taskListTitle) lines.push(`List: ${t.taskListTitle}`);
  if (t.notes) lines.push(`Notes: ${t.notes}`);
  return lines.join("\n");
}

function renderMessage(m: GmailMessageItem): string {
  const lines = [`Email: ${m.subject}`];
  if (m.date) lines.push(`Date: ${m.date}`);
  lines.push(`From: ${m.from.name || m.from.email}`);
  if (m.to?.length) lines.push(`To: ${m.to.map((t) => t.name || t.email).join(", ")}`);
  if (m.snippet) lines.push(`Snippet: ${m.snippet}`);
  // The full body is present only in the explicit "rich" opt-in mode.
  if (m.body) lines.push(`Body: ${m.body}`);
  return lines.join("\n");
}

/** The raw provider payload, stored verbatim so a reprocess needs no re-fetch (#19). */
function rawPayload(item: unknown): string {
  return JSON.stringify(item, null, 2);
}

function toNormalized(
  delta: DeltaResult<unknown>,
  map: (item: unknown) => NormalizedItem,
): NormalizedDelta {
  return {
    items: delta.items.map(map),
    deletions: delta.deletions,
    nextCursor: delta.nextSyncToken ?? null,
    fullResync: delta.fullResync,
    nextConfig: delta.nextConfig,
    hasMore: delta.hasMore,
  };
}

export class GoogleConnector implements Connector {
  readonly manifest = GOOGLE_MANIFEST;
  readonly oauth = oauth;

  /** List the user's Google calendars for the multi-calendar picker (#68). */
  async listCalendars(ctx: SyncContext): Promise<CalendarListEntry[]> {
    return fetchCalendarList(ctx.accessToken);
  }

  /**
   * The chat-agent tools Google contributes when connected — one live fetch/search
   * tool per enabled content kind, so the agent can reach the user's real Google
   * data the knowledge base doesn't hold (email/thread bodies, future calendar
   * events, current task state) and act on it (creating a task). Each tool is gated
   * on its kind being synced, and the access token is minted lazily inside `execute`
   * so a connected-but-unused kind adds no per-turn network cost.
   */
  agentTools(ctx: AgentToolContext): ToolSet {
    const tools: ToolSet = {};
    const fail = (what: string, error: unknown) =>
      `Couldn't ${what}: ${error instanceof Error ? error.message : String(error)}`;

    if (ctx.enabledKinds.has("gmail")) {
      tools.fetch_email_threads = tool({
        description:
          "Fetch the text of the user's actual email threads matching a query (a contact name, subject, or keywords). Use when a question needs the contents of correspondence — email bodies are not in the knowledge base, so this is the only way to read them. Cite what you find in prose.",
        inputSchema: z.object({
          query: z.string().describe("Gmail search query — a contact, subject, or keywords."),
        }),
        execute: async ({ query }) => {
          try {
            return await searchThreadsText(await ctx.getAccessToken(), query);
          } catch (error) {
            return fail("fetch email threads", error);
          }
        },
      });
    }

    if (ctx.enabledKinds.has("calendar")) {
      tools.search_calendar = tool({
        description:
          "Search the user's Google Calendar for live events — by free-text query (a person, title, or keywords) and/or a time window. Use for scheduling and agenda questions ('what's on my calendar next week', 'when do I next meet with X'), including FUTURE events the knowledge base may not hold. Results are ordered by start time; cite what you find.",
        inputSchema: z.object({
          query: z
            .string()
            .optional()
            .describe("Free-text match across event title, description, and attendees."),
          timeMin: z
            .string()
            .optional()
            .describe("ISO lower bound for the event start, e.g. 2026-06-19T00:00:00Z."),
          timeMax: z
            .string()
            .optional()
            .describe("ISO upper bound for the event start, e.g. 2026-06-26T00:00:00Z."),
        }),
        execute: async ({ query, timeMin, timeMax }) => {
          try {
            const events = await searchCalendarEvents(await ctx.getAccessToken(), {
              query,
              timeMin,
              timeMax,
            });
            if (events.length === 0) return "No calendar events matched.";
            return events.map(renderEvent).join("\n\n");
          } catch (error) {
            return fail("search the calendar", error);
          }
        },
      });
    }

    if (ctx.enabledKinds.has("tasks")) {
      tools.list_tasks = tool({
        description:
          "List the user's current Google Tasks — their open to-dos across all lists, soonest-due first. Use to answer 'what's on my task list' or to find a task before acting on it.",
        inputSchema: z.object({
          includeCompleted: z
            .boolean()
            .optional()
            .describe("Include completed tasks too. Defaults to open tasks only."),
        }),
        execute: async ({ includeCompleted }) => {
          try {
            const tasks = await listTasks(await ctx.getAccessToken(), { includeCompleted });
            if (tasks.length === 0) return "No tasks found.";
            return tasks.map(renderTask).join("\n\n");
          } catch (error) {
            return fail("list tasks", error);
          }
        },
      });

      tools.create_task = tool({
        description:
          "Create a new task in the user's Google Tasks. Use only when the user clearly asks to add a to-do or reminder. It is added to their primary task list and syncs back into the knowledge base.",
        inputSchema: z.object({
          title: z.string().describe("The task title — what to do."),
          notes: z.string().optional().describe("Optional longer details for the task."),
          due: z
            .string()
            .optional()
            .describe("Optional due date as an ISO/RFC3339 date, e.g. 2026-06-25."),
        }),
        execute: async ({ title, notes, due }) => {
          try {
            const token = await ctx.getAccessToken();
            const lists = await listTaskLists(token);
            const listId = lists[0]?.id;
            if (!listId) return "Couldn't create the task: no Google Tasks list is available.";
            const task = await createTask(token, listId, { title, notes, due: due ?? null });
            const when = task.due ? ` (due ${task.due.slice(0, 10)})` : "";
            return `Created task "${task.title}"${when} in ${task.taskListTitle}.`;
          } catch (error) {
            return fail("create the task", error);
          }
        },
      });
    }

    if (ctx.enabledKinds.has("contacts")) {
      tools.lookup_contact = tool({
        description:
          "Look up a person in the user's Google Contacts by name, email, or phone, returning their live details (emails, phone numbers, organisation). Use when a question needs someone's current contact details.",
        inputSchema: z.object({
          query: z
            .string()
            .describe("A name, email, or phone to match against the user's contacts."),
        }),
        execute: async ({ query }) => {
          try {
            const matches = await searchContacts(await ctx.getAccessToken(), query);
            if (matches.length === 0) return `No contact matched "${query}".`;
            return matches.map(renderContact).join("\n\n");
          } catch (error) {
            return fail("look up the contact", error);
          }
        },
      });
    }

    return tools;
  }

  /**
   * System-prompt hint, appended only when Google contributes at least one tool.
   * Each tool surfaces only for its connected kind (the model can only call tools
   * actually in its toolset), so the hint frames the suite and the model picks the
   * ones present.
   */
  readonly promptHint =
    "Google tools (each present only when its service is connected): fetch_email_threads pulls the text of the user's real email threads — email bodies are NOT in the knowledge base, so reach for it whenever a question needs the contents of correspondence; search_calendar reads live calendar events by query and/or time window, including FUTURE events; list_tasks reads the user's current Google Tasks and create_task adds one; lookup_contact fetches a person's live contact details. Prefer these for up-to-the-minute facts or write actions, and cite what you find.";

  async fetchDelta(
    ctx: SyncContext,
    kind: string,
    cursor: string | null,
  ): Promise<NormalizedDelta> {
    const { accessToken, config } = ctx;
    if (kind === "contacts") {
      const delta = await fetchContactsDelta(accessToken, cursor);
      return toNormalized(delta, (raw) => {
        const c = raw as ContactItem;
        return {
          externalId: c.externalId,
          title: c.displayName,
          path: c.deepLink,
          rawContent: rawPayload(c),
          normalizedContent: renderContact(c),
          extraction: mapContact(c),
        };
      });
    }

    if (kind === "tasks") {
      // Tasks are things-to-do, not relationships — no self identity needed.
      // A task-list subset (#88) narrows the pull to the enabled lists.
      const delta = await fetchTasksDelta(accessToken, cursor, {
        taskListIds: config?.enabledTaskLists,
      });
      return toNormalized(delta, (raw) => {
        const t = raw as TaskItem;
        return {
          externalId: t.externalId,
          title: t.title,
          path: t.deepLink,
          rawContent: rawPayload(t),
          normalizedContent: renderTask(t),
          extraction: mapTask(t),
        };
      });
    }

    if (kind !== "calendar" && kind !== "gmail") {
      throw new Error(`Google connector does not support kind: ${kind}`);
    }

    // Calendar + Gmail anchor "knows" edges to you, so they need the self identity.
    const self: SelfIdentity = await fetchSelf(accessToken);
    if (kind === "calendar") {
      const delta = await fetchCalendarDelta(accessToken, cursor, config);
      return toNormalized(delta, (raw) => {
        const e = raw as CalendarEventItem;
        return {
          externalId: e.externalId,
          title: e.title,
          path: e.htmlLink,
          rawContent: rawPayload(e),
          normalizedContent: renderEvent(e),
          extraction: mapCalendarEvent(e, self),
        };
      });
    }
    // The only remaining kind is gmail (the guard above rejected anything else).
    const delta = await fetchGmailDelta(accessToken, cursor, config);
    return toNormalized(delta, (raw) => {
      const m = raw as GmailMessageItem;
      return {
        externalId: m.externalId,
        title: m.subject,
        path: m.deepLink,
        rawContent: rawPayload(m),
        normalizedContent: renderMessage(m),
        extraction: mapGmailMessage(m, self),
      };
    });
  }
}

/** The shared Google connector instance (stateless — safe to reuse). */
export const googleConnector = new GoogleConnector();

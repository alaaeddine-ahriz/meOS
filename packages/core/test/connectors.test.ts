import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrations, openDatabase } from "../src/db/database.js";
import { HashEmbedder } from "../src/embedding/embedder.js";
import { IngestionPipeline } from "../src/ingest/pipeline.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { StubLlmClient } from "../src/llm/stub.js";
import { WikiWriter } from "../src/wiki/writer.js";
import { mapCalendarEvent } from "../src/connectors/map/calendar.js";
import { mapContact } from "../src/connectors/map/contacts.js";
import { mapGmailMessage } from "../src/connectors/map/gmail.js";
import { mapTask } from "../src/connectors/map/tasks.js";
import { createTask, fetchTasksDelta, listTasks } from "../src/connectors/google/tasks.js";
import { googleConnector } from "../src/connectors/google/connector.js";
import type {
  CalendarEventItem,
  ContactItem,
  GmailMessageItem,
  SelfIdentity,
  TaskItem,
} from "../src/connectors/types.js";
import type {
  AgentToolContext,
  Connector,
  NormalizedDelta,
  OAuthProvider,
  SyncContext,
} from "../src/connectors/framework.js";
import type { ToolCallOptions, ToolSet } from "ai";
import { connectorRegistry, ConnectorRegistry } from "../src/connectors/registry.js";
import { syncConnector } from "../src/connectors/sync.js";
import { defaultVisibilityForType } from "../src/knowledge/visibility.js";
import { deriveCoverageState } from "../src/connectors/types.js";

const self: SelfIdentity = { name: "Ada Lovelace", email: "ada@example.com" };

describe("connector mappers", () => {
  it("maps a contact to a person with private email/phone facts", () => {
    const contact: ContactItem = {
      externalId: "people/c1",
      displayName: "Charles Babbage",
      nicknames: ["Charlie"],
      emails: ["charles@example.com"],
      phones: ["+44 20 7946 0000"],
      organisation: "Analytical Engine Co",
      jobTitle: "Inventor",
      deepLink: "https://contacts.google.com/person/c1",
    };
    const extraction = mapContact(contact);

    const person = extraction.entities.find((e) => e.name === "Charles Babbage")!;
    expect(person.type).toBe("person");
    expect(person.relevance).toBe("high");
    // Emails fold in as aliases so a future merge can match by address.
    expect(person.aliases).toContain("charles@example.com");

    const email = extraction.observations.find((o) => o.claim.includes("email"))!;
    expect(email.sensitivity).toBe("private");
    const phone = extraction.observations.find((o) => o.claim.includes("phone"))!;
    expect(phone.sensitivity).toBe("private");
    const org = extraction.observations.find((o) => o.claim.includes("works at"))!;
    expect(org.sensitivity).toBe("normal");

    // Organisation becomes its own entity + a "works at" edge.
    expect(extraction.entities.some((e) => e.name === "Analytical Engine Co")).toBe(true);
    expect(extraction.relationships).toContainEqual({
      from: "Charles Babbage",
      to: "Analytical Engine Co",
      label: "works at",
    });
  });

  it("maps a calendar event to dated attendee observations and knows edges", () => {
    const event: CalendarEventItem = {
      externalId: "evt1",
      title: "Engine sync",
      start: "2026-07-01T10:00:00Z",
      attendees: [
        { email: "ada@example.com", self: true },
        { email: "charles@example.com", name: "Charles Babbage" },
      ],
      htmlLink: "https://calendar.google.com/event?eid=evt1",
    };
    const extraction = mapCalendarEvent(event, self);

    // Owner folds in under their real name, not their email.
    expect(extraction.entities.some((e) => e.name === "Ada Lovelace")).toBe(true);
    expect(extraction.entities.some((e) => e.name === "Charles Babbage")).toBe(true);

    const met = extraction.observations.find((o) => o.entity === "Charles Babbage")!;
    expect(met.kind).toBe("event");
    expect(met.validFrom).toBe("2026-07-01");
    expect(met.claim).toContain("Engine sync");

    expect(extraction.relationships).toContainEqual({
      from: "Ada Lovelace",
      to: "Charles Babbage",
      label: "knows",
    });
  });

  it("maps a gmail message to a private exchange fact and a knows edge to you", () => {
    const message: GmailMessageItem = {
      externalId: "m1",
      threadId: "t1",
      subject: "Re: punched cards",
      date: "2026-06-01T09:00:00Z",
      from: { email: "charles@example.com", name: "Charles Babbage" },
      to: [{ email: "ada@example.com" }],
      snippet: "About the cards…",
      deepLink: "https://mail.google.com/mail/u/0/#all/t1",
    };
    const extraction = mapGmailMessage(message, self);

    const exchange = extraction.observations.find((o) => o.entity === "Charles Babbage")!;
    expect(exchange.kind).toBe("event");
    expect(exchange.sensitivity).toBe("private");
    expect(exchange.validFrom).toBe("2026-06-01");
    // You are not a correspondent of your own message.
    expect(extraction.observations.every((o) => o.entity !== "Ada Lovelace")).toBe(true);
    expect(extraction.relationships).toContainEqual({
      from: "Ada Lovelace",
      to: "Charles Babbage",
      label: "knows",
    });
  });

  it("maps a task to a searchable task observation with list + due provenance", () => {
    const task: TaskItem = {
      externalId: "task1",
      title: "Punch the cards",
      notes: "Use the spare deck",
      due: "2026-08-01T00:00:00.000Z",
      status: "needsAction",
      completed: false,
      taskListId: "list1",
      taskListTitle: "Engine work",
      updated: "2026-06-10T09:00:00.000Z",
      deepLink: "https://tasks.google.com/",
    };
    const extraction = mapTask(task);

    // The task itself is the entity, kept high-relevance so it survives the gate.
    const entity = extraction.entities.find((e) => e.name === "Punch the cards")!;
    expect(entity.relevance).toBe("high");

    const obs = extraction.observations.find((o) => o.entity === "Punch the cards")!;
    expect(obs.kind).toBe("task");
    expect(obs.validFrom).toBe("2026-08-01");
    // Provenance: the list anchors it and the notes ride along.
    expect(obs.claim).toContain("Engine work");
    expect(obs.claim).toContain("Use the spare deck");
    expect(obs.claim).toContain("To do");
    // No people edges — a task is a thing-to-do, not a relationship.
    expect(extraction.relationships).toHaveLength(0);
  });

  it("marks a completed task as Completed in its observation", () => {
    const extraction = mapTask({
      externalId: "task2",
      title: "File the report",
      due: null,
      status: "completed",
      completed: true,
      taskListId: "list1",
      taskListTitle: "Admin",
      updated: "2026-06-10T09:00:00.000Z",
      deepLink: "https://tasks.google.com/",
    });
    const obs = extraction.observations.find((o) => o.entity === "File the report")!;
    expect(obs.claim).toContain("Completed");
  });
});

describe("Google Tasks REST client (read + write)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // A minimal fetch stub: route by URL to a scripted JSON body.
  function stubFetch(routes: (url: string, init?: RequestInit) => unknown) {
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const body = routes(url, init);
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    });
  }

  it("pages through lists and tasks, returning a high-water cursor", async () => {
    stubFetch((url) => {
      if (url.includes("/users/@me/lists")) {
        return { items: [{ id: "list1", title: "Engine work" }] };
      }
      if (url.includes("/lists/list1/tasks")) {
        return {
          items: [
            {
              id: "t1",
              title: "First",
              status: "needsAction",
              updated: "2026-06-01T00:00:00.000Z",
            },
            { id: "t2", title: "Second", status: "completed", updated: "2026-06-03T00:00:00.000Z" },
          ],
        };
      }
      return {};
    });

    const delta = await fetchTasksDelta("tok", null);
    expect(delta.items.map((t) => t.externalId)).toEqual(["t1", "t2"]);
    expect(delta.items[1]!.completed).toBe(true);
    expect(delta.items[0]!.taskListTitle).toBe("Engine work");
    // Cursor is the latest `updated` we saw — the basis for the next incremental run.
    expect(delta.nextSyncToken).toBe("2026-06-03T00:00:00.000Z");
  });

  it("passes the saved cursor as updatedMin for an incremental pull", async () => {
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      if (url.includes("/users/@me/lists")) return { items: [{ id: "list1", title: "L" }] };
      if (url.includes("/lists/list1/tasks")) {
        return { items: [{ id: "t9", title: "New", updated: "2026-07-01T00:00:00.000Z" }] };
      }
      return {};
    });

    const cursor = "2026-06-03T00:00:00.000Z";
    const delta = await fetchTasksDelta("tok", cursor);
    const tasksCall = seen.find((u) => u.includes("/lists/list1/tasks"))!;
    // updatedMin is the cursor bumped by 1ms so the boundary task isn't re-fetched.
    expect(tasksCall).toContain("updatedMin=");
    expect(decodeURIComponent(tasksCall)).toContain("2026-06-03T00:00:00.001Z");
    expect(delta.items.map((t) => t.externalId)).toEqual(["t9"]);
  });

  it("reports deleted tasks as deletions", async () => {
    stubFetch((url) => {
      if (url.includes("/users/@me/lists")) return { items: [{ id: "list1", title: "L" }] };
      if (url.includes("/lists/list1/tasks")) {
        return {
          items: [
            { id: "keep", title: "Keep", updated: "2026-06-01T00:00:00.000Z" },
            { id: "gone", deleted: true },
          ],
        };
      }
      return {};
    });
    const delta = await fetchTasksDelta("tok", null);
    expect(delta.items.map((t) => t.externalId)).toEqual(["keep"]);
    expect(delta.deletions).toEqual(["gone"]);
  });

  it("creates a task via the write path and returns it normalized", async () => {
    let posted: unknown;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      let body: unknown = {};
      if (url.includes("/users/@me/lists")) {
        body = { items: [{ id: "list1", title: "Engine work" }] };
      } else if (init?.method === "POST" && url.includes("/lists/list1/tasks")) {
        posted = JSON.parse(String(init.body));
        body = { id: "created1", title: "Punch cards", status: "needsAction" };
      }
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    });

    const task = await createTask("tok", "list1", { title: "Punch cards", notes: "deck" });
    expect(posted).toMatchObject({ title: "Punch cards", notes: "deck" });
    expect(task.externalId).toBe("created1");
    expect(task.taskListTitle).toBe("Engine work");
    expect(task.completed).toBe(false);
  });
});

describe("GoogleConnector agent tools (live fetch/search)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Route Google REST calls by URL to a scripted JSON body (mirrors the sync suite).
  function stubFetch(routes: (url: string, init?: RequestInit) => unknown) {
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const body = routes(url, init);
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    });
  }

  // A minimal AgentToolContext: the agent tools only use enabledKinds + getAccessToken;
  // store/embedder are never touched by Google's tools.
  function agentCtx(enabled: string[], onToken?: () => void): AgentToolContext {
    return {
      store: {} as never,
      embedder: {} as never,
      enabledKinds: new Set(enabled),
      getAccessToken: async () => {
        onToken?.();
        return "tok";
      },
    } satisfies AgentToolContext;
  }

  const opts: ToolCallOptions = { toolCallId: "t1", messages: [] };
  async function callTool(tools: ToolSet, name: string, input: Record<string, unknown>) {
    const t = tools[name];
    if (!t || typeof t.execute !== "function") throw new Error(`tool ${name} is not executable`);
    const exec = t.execute as (i: Record<string, unknown>, o: ToolCallOptions) => Promise<unknown>;
    return String(await exec(input, opts));
  }

  it("contributes one tool per enabled content kind, each gated on its kind", () => {
    expect(Object.keys(googleConnector.agentTools(agentCtx([])))).toEqual([]);
    expect(Object.keys(googleConnector.agentTools(agentCtx(["gmail"])))).toEqual([
      "fetch_email_threads",
    ]);
    expect(Object.keys(googleConnector.agentTools(agentCtx(["calendar"])))).toEqual([
      "search_calendar",
    ]);
    expect(Object.keys(googleConnector.agentTools(agentCtx(["tasks"])))).toEqual([
      "list_tasks",
      "create_task",
    ]);
    expect(Object.keys(googleConnector.agentTools(agentCtx(["contacts"])))).toEqual([
      "lookup_contact",
    ]);
    // All four content kinds enabled → the full suite.
    const all = Object.keys(
      googleConnector.agentTools(agentCtx(["gmail", "calendar", "tasks", "contacts"])),
    ).sort();
    expect(all).toEqual([
      "create_task",
      "fetch_email_threads",
      "list_tasks",
      "lookup_contact",
      "search_calendar",
    ]);
  });

  it("builds tools lazily — no token is minted until a tool runs", () => {
    let minted = 0;
    googleConnector.agentTools(
      agentCtx(["gmail", "calendar", "tasks", "contacts"], () => minted++),
    );
    expect(minted).toBe(0);
  });

  it("search_calendar fetches live events, drops cancellations, orders by start", async () => {
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      if (url.includes("/calendars/primary/events")) {
        return {
          items: [
            {
              id: "e2",
              summary: "Later sync",
              status: "confirmed",
              start: { dateTime: "2026-06-22T10:00:00Z" },
              organizer: { email: "ada@example.com" },
            },
            {
              id: "e1",
              summary: "Sooner sync",
              status: "confirmed",
              start: { dateTime: "2026-06-20T09:00:00Z" },
            },
            {
              id: "x",
              summary: "Cancelled sync",
              status: "cancelled",
              start: { dateTime: "2026-06-21T00:00:00Z" },
            },
            // A startless event must sink to the end, not jump to the front.
            { id: "n", summary: "Startless sync", status: "confirmed" },
          ],
        };
      }
      return {};
    });

    const tools = googleConnector.agentTools(agentCtx(["calendar"]));
    const out = await callTool(tools, "search_calendar", {
      query: "sync",
      timeMin: "2026-06-19T00:00:00Z",
    });

    const call = seen.find((u) => u.includes("/calendars/primary/events"))!;
    expect(call).toContain("singleEvents=true");
    expect(call).toContain("orderBy=startTime");
    expect(call).toContain("q=sync");
    expect(decodeURIComponent(call)).toContain("timeMin=2026-06-19T00:00:00Z");
    // Cancelled event dropped; survivors rendered soonest-first, startless last.
    expect(out).toContain("Event: Sooner sync");
    expect(out).toContain("Event: Later sync");
    expect(out).not.toContain("Cancelled sync");
    expect(out.indexOf("Sooner sync")).toBeLessThan(out.indexOf("Later sync"));
    expect(out.indexOf("Later sync")).toBeLessThan(out.indexOf("Startless sync"));
  });

  it("list_tasks returns open tasks soonest-due first; includeCompleted flips the flag", async () => {
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      if (url.includes("/users/@me/lists")) return { items: [{ id: "list1", title: "Inbox" }] };
      if (url.includes("/lists/list1/tasks")) {
        return {
          items: [
            {
              id: "a",
              title: "Later task",
              status: "needsAction",
              due: "2026-07-01T00:00:00.000Z",
            },
            {
              id: "b",
              title: "Sooner task",
              status: "needsAction",
              due: "2026-06-25T00:00:00.000Z",
            },
            { id: "c", title: "Undated task", status: "needsAction" },
          ],
        };
      }
      return {};
    });

    const tools = googleConnector.agentTools(agentCtx(["tasks"]));
    const out = await callTool(tools, "list_tasks", {});
    const openCall = seen.find((u) => u.includes("/lists/list1/tasks"))!;
    expect(openCall).toContain("showCompleted=false");
    // Open-only must also keep hidden (first-party-completed) tasks out.
    expect(openCall).toContain("showHidden=false");
    // Dated tasks ahead of undated, soonest-due first.
    expect(out.indexOf("Sooner task")).toBeLessThan(out.indexOf("Later task"));
    expect(out.indexOf("Later task")).toBeLessThan(out.indexOf("Undated task"));

    seen.length = 0;
    await callTool(tools, "list_tasks", { includeCompleted: true });
    const completedCall = seen.find((u) => u.includes("/lists/list1/tasks"))!;
    expect(completedCall).toContain("showCompleted=true");
    // showHidden must also flip true, else tasks completed in Google's own apps
    // (marked hidden) stay invisible.
    expect(completedCall).toContain("showHidden=true");
  });

  it("listTasks pages each list to completion before applying the due-sort + cap", async () => {
    stubFetch((url) => {
      if (url.includes("/users/@me/lists")) return { items: [{ id: "list1", title: "Inbox" }] };
      if (url.includes("/lists/list1/tasks")) {
        // Google returns manual/position order: the soonest-due task sits on page 2,
        // behind a far-future task on page 1. Paging must follow nextPageToken to the
        // end before the global sort, or the cap would keep the wrong task.
        if (url.includes("pageToken=p2")) {
          return {
            items: [
              {
                id: "soon",
                title: "Soonest",
                status: "needsAction",
                due: "2026-06-20T00:00:00.000Z",
              },
            ],
          };
        }
        return {
          items: [
            {
              id: "far",
              title: "Farthest",
              status: "needsAction",
              due: "2027-01-01T00:00:00.000Z",
            },
          ],
          nextPageToken: "p2",
        };
      }
      return {};
    });

    // Even with max=1 — where a count-bounded loop would stop after page 1 and
    // return "far" — the genuine soonest task wins because paging finishes first.
    const tasks = await listTasks("tok", { max: 1 });
    expect(tasks.map((t) => t.externalId)).toEqual(["soon"]);
  });

  it("create_task adds to the primary list and confirms what it created", async () => {
    let posted: unknown;
    stubFetch((url, init) => {
      if (url.includes("/users/@me/lists")) return { items: [{ id: "list1", title: "Inbox" }] };
      if (init?.method === "POST" && url.includes("/lists/list1/tasks")) {
        posted = JSON.parse(String(init.body));
        return {
          id: "new1",
          title: "Ship it",
          status: "needsAction",
          due: "2026-06-25T00:00:00.000Z",
        };
      }
      return {};
    });

    const tools = googleConnector.agentTools(agentCtx(["tasks"]));
    const out = await callTool(tools, "create_task", { title: "Ship it", due: "2026-06-25" });

    // A bare YYYY-MM-DD is widened to an RFC3339 timestamp Google Tasks accepts.
    expect(posted).toMatchObject({ title: "Ship it", due: "2026-06-25T00:00:00.000Z" });
    expect(out).toContain('Created task "Ship it"');
    expect(out).toContain("due 2026-06-25");
    expect(out).toContain("Inbox");
  });

  it("lookup_contact searches contacts and renders the matches' details", async () => {
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      if (url.includes("/people:searchContacts")) {
        return {
          results: [
            {
              person: {
                resourceName: "people/c1",
                names: [{ displayName: "Grace Hopper" }],
                emailAddresses: [{ value: "grace@example.com" }],
                phoneNumbers: [{ value: "+1 555 0100" }],
              },
            },
          ],
        };
      }
      return {};
    });

    const tools = googleConnector.agentTools(agentCtx(["contacts"]));
    const out = await callTool(tools, "lookup_contact", { query: "grace" });

    const searchCalls = seen.filter((u) => u.includes("/people:searchContacts"));
    // A warmup (empty query) primes the cache before the real query — two calls.
    expect(searchCalls.length).toBe(2);
    expect(searchCalls[0]).toContain("query=&");
    expect(searchCalls[1]).toContain("query=grace");
    expect(out).toContain("Contact: Grace Hopper");
    expect(out).toContain("grace@example.com");
  });

  it("returns a graceful message instead of throwing when the provider call fails", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        ({
          ok: false,
          status: 500,
          json: async () => ({}),
          text: async () => "boom",
        }) as Response,
    );
    const tools = googleConnector.agentTools(agentCtx(["calendar"]));
    const out = await callTool(tools, "search_calendar", { query: "x" });
    expect(out).toContain("Couldn't search the calendar");
  });
});

describe("connector store ledger", () => {
  it("dedups by content hash and tracks per-kind sync state", () => {
    const db = openDatabase(":memory:");
    const store = new KnowledgeStore(db);

    const accountId = store.upsertConnectorAccount({
      provider: "google",
      clientId: "id",
      clientSecret: "secret",
      accessToken: "tok",
      refreshToken: "refresh",
    });
    expect(store.getConnectorAccount("google")!.id).toBe(accountId);

    expect(store.connectorItemUnchanged(accountId, "contacts", "people/c1", "hashA")).toBe(false);
    store.recordConnectorItem(accountId, "contacts", "people/c1", "hashA", null);
    expect(store.connectorItemUnchanged(accountId, "contacts", "people/c1", "hashA")).toBe(true);
    // A changed item (new hash) is no longer considered unchanged.
    expect(store.connectorItemUnchanged(accountId, "contacts", "people/c1", "hashB")).toBe(false);

    store.setSyncState(accountId, "contacts", { enabled: true, intervalMinutes: 30 });
    let state = store.getSyncState(accountId, "contacts")!;
    expect(state.enabled).toBe(1);
    expect(state.interval_minutes).toBe(30);

    // A cursor write must not reset the enabled toggle or interval.
    store.setSyncState(accountId, "contacts", { syncToken: "cursor1", lastStatus: "ok" });
    state = store.getSyncState(accountId, "contacts")!;
    expect(state.enabled).toBe(1);
    expect(state.interval_minutes).toBe(30);
    expect(state.sync_token).toBe("cursor1");

    db.close();
  });

  it("ingests a mapped extraction as a typed, deep-linkable source", async () => {
    const db = openDatabase(":memory:");
    const store = new KnowledgeStore(db);
    const embedder = new HashEmbedder();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-conn-"));
    const llm = new StubLlmClient({});
    const wiki = new WikiWriter(store, llm, tmpDir);
    let scheduled = 0;
    const pipeline = new IngestionPipeline({
      store,
      llm,
      embedder,
      wiki,
      scheduleWikiRefresh: () => {
        scheduled++;
      },
    });

    const contact: ContactItem = {
      externalId: "people/c2",
      displayName: "Charles Babbage",
      nicknames: [],
      emails: ["charles@example.com"],
      phones: [],
      deepLink: "https://contacts.google.com/person/c2",
    };
    const { sourceId } = await pipeline.ingestExtraction({
      type: "google:contacts",
      title: contact.displayName,
      content: "contact",
      path: contact.deepLink,
      extraction: mapContact(contact),
    });

    const source = store.getSource(sourceId)!;
    expect(source.type).toBe("google:contacts");
    expect(source.path).toBe("https://contacts.google.com/person/c2");
    expect(scheduled).toBe(1);

    const person = store.findEntityByName("Charles Babbage")!;
    // The connector source attaches to the person's page (private facts included).
    expect(store.sourcesForEntity(person.id).some((s) => s.type === "google:contacts")).toBe(true);

    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("connector materialization (#19)", () => {
  function setup() {
    const db = openDatabase(":memory:");
    const store = new KnowledgeStore(db);
    const embedder = new HashEmbedder();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-mat-"));
    const llm = new StubLlmClient({});
    const wiki = new WikiWriter(store, llm, tmpDir);
    const pipeline = new IngestionPipeline({
      store,
      llm,
      embedder,
      wiki,
      scheduleWikiRefresh: () => {},
    });
    const accountId = store.upsertConnectorAccount({
      provider: "google",
      clientId: "id",
      clientSecret: "secret",
      accessToken: "tok",
      refreshToken: "refresh",
    });
    const cleanup = () => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    };
    return { db, store, embedder, pipeline, accountId, cleanup };
  }

  const contact: ContactItem = {
    externalId: "people/c9",
    displayName: "Charles Babbage",
    nicknames: ["Charlie"],
    emails: ["charles@example.com"],
    phones: ["+44 20 7946 0000"],
    organisation: "Analytical Engine Co",
    deepLink: "https://contacts.google.com/person/c9",
  };

  it("materializes a connector item as a searchable source + revision with chunks", async () => {
    const { store, pipeline, cleanup } = setup();
    const out = await pipeline.materialize({
      type: "google:contacts",
      title: contact.displayName,
      path: contact.deepLink,
      rawContent: JSON.stringify(contact),
      normalizedContent: `Contact: ${contact.displayName}\nEmail: ${contact.emails[0]}`,
      extraction: mapContact(contact),
    });

    expect(out.status).toBe("done");
    const source = store.getSource(out.sourceId)!;
    expect(source.type).toBe("google:contacts");
    // Connector visibility default (#11): searchable but not synced/exported.
    const vis = store.sourceVisibility(out.sourceId);
    expect(vis.searchable).toBe(true);
    expect(vis.syncable).toBe(false);
    expect(vis.exportable).toBe(false);
    // Searchable even before/independent of extraction: chunks landed on the revision.
    const chunks = store.chunksForSource(out.sourceId);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.source_revision_id).toBe(out.sourceRevisionId);
    // Raw payload stored apart from the normalized indexed text.
    expect(store.getSourceRawContent(out.sourceId)).toContain("people/c9");
    expect(store.getSourceContent(out.sourceId)).toContain("Contact: Charles Babbage");
    // The derived extraction reached the graph linked to the revision.
    expect(store.findEntityByName("Charles Babbage")).toBeTruthy();
    expect(store.activeRevision(out.sourceId)?.id).toBe(out.sourceRevisionId);

    cleanup();
  });

  it("advances the same logical source's revision when a changed item re-syncs", async () => {
    const { store, pipeline, cleanup } = setup();
    const first = await pipeline.materialize({
      type: "google:contacts",
      title: contact.displayName,
      path: contact.deepLink,
      rawContent: JSON.stringify(contact),
      normalizedContent: "Contact: Charles Babbage\nRole: Inventor",
      extraction: mapContact(contact),
    });

    const changed: ContactItem = { ...contact, jobTitle: "Chief Engineer" };
    const second = await pipeline.materialize({
      type: "google:contacts",
      title: changed.displayName,
      path: changed.deepLink,
      rawContent: JSON.stringify(changed),
      normalizedContent: "Contact: Charles Babbage\nRole: Chief Engineer",
      extraction: mapContact(changed),
      existingSourceId: first.sourceId,
    });

    // Same source row, new revision — provenance is not overwritten.
    expect(second.sourceId).toBe(first.sourceId);
    expect(second.sourceRevisionId).not.toBe(first.sourceRevisionId);
    const revisions = store.revisionsForSource(first.sourceId);
    expect(revisions).toHaveLength(2);
    expect(store.getRevision(first.sourceRevisionId)!.status).toBe("superseded");
    expect(store.activeRevision(first.sourceId)!.id).toBe(second.sourceRevisionId);
    // Re-indexed: chunks now belong to the new revision (old ones cleared).
    const chunks = store.chunksForSource(first.sourceId);
    expect(chunks.every((c) => c.source_revision_id === second.sourceRevisionId)).toBe(true);

    cleanup();
  });

  it("skips an unchanged item by content hash via the ledger", () => {
    const { store, accountId, cleanup } = setup();
    const sourceId = store.createSource({
      type: "google:contacts",
      title: "Charles Babbage",
      content: "Contact: Charles Babbage",
    });
    const revisionId = store.createSourceRevision({ sourceId });
    const hash = "hashX";
    expect(store.connectorItemUnchanged(accountId, "contacts", "people/c9", hash)).toBe(false);
    store.recordConnectorItem(accountId, "contacts", "people/c9", hash, sourceId, revisionId);
    expect(store.connectorItemUnchanged(accountId, "contacts", "people/c9", hash)).toBe(true);
    // The ledger remembers the materialized source + revision for the next sync.
    const ledger = store.getConnectorItem(accountId, "contacts", "people/c9")!;
    expect(ledger.source_id).toBe(sourceId);
    expect(ledger.source_revision_id).toBe(revisionId);
    cleanup();
  });

  it("marks the revision inactive on a connector deletion without losing history", async () => {
    const { store, pipeline, accountId, cleanup } = setup();
    const out = await pipeline.materialize({
      type: "google:contacts",
      title: contact.displayName,
      path: contact.deepLink,
      rawContent: JSON.stringify(contact),
      normalizedContent: "Contact: Charles Babbage",
      extraction: mapContact(contact),
    });
    store.recordConnectorItem(
      accountId,
      "contacts",
      contact.externalId,
      "h",
      out.sourceId,
      out.sourceRevisionId,
    );

    // A delta deletion: locate the materialized source via the ledger and retire
    // its latest revision (soft delete) — exactly what sync.ts does.
    const ledger = store.getConnectorItem(accountId, "contacts", contact.externalId)!;
    store.markSourceGone(ledger.source_id!, "deleted");

    expect(store.getRevision(out.sourceRevisionId)!.status).toBe("deleted");
    // Audit history survives: the source row and revision are still there.
    expect(store.getSource(out.sourceId)).toBeTruthy();
    expect(store.revisionsForSource(out.sourceId)).toHaveLength(1);
    // Facts it backed are now flagged stale.
    expect(store.staleBackedObservations().length).toBeGreaterThan(0);
    cleanup();
  });

  it("leaves the item searchable when the derived extraction fails", async () => {
    const { store, embedder, cleanup } = setup();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-mat-fail-"));
    const llm = new StubLlmClient({});
    const wiki = new WikiWriter(store, llm, tmpDir);
    // A pipeline whose merge stage throws — the search index must still land.
    const pipeline = new IngestionPipeline({
      store,
      llm,
      embedder,
      wiki,
      scheduleWikiRefresh: () => {},
      events: {
        emit: async () => {
          throw new Error("extraction boom");
        },
      } as never,
    });

    const out = await pipeline.materialize({
      type: "google:contacts",
      title: contact.displayName,
      path: contact.deepLink,
      rawContent: JSON.stringify(contact),
      normalizedContent: "Contact: Charles Babbage",
      extraction: mapContact(contact),
    });

    expect(out.status).toBe("indexed");
    // Searchable: chunks committed before the failing extraction stage.
    expect(store.chunksForSource(out.sourceId).length).toBeGreaterThan(0);
    // Revision parked incomplete so it doesn't look fully ingested — retryable.
    expect(store.getRevision(out.sourceRevisionId)!.status).toBe("incomplete");
    cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("connector framework (#5) — a second provider slots in", () => {
  // A fake OAuth surface: refresh returns a fresh token so ensureAccessToken
  // works without any network. The framework never inspects how tokens are minted.
  const fakeOAuth: OAuthProvider = {
    scopes: ["read"],
    buildAuthUrl: () => "https://example.com/auth",
    exchangeCode: async () => ({ accessToken: "fresh", refreshToken: "r", expiry: null }),
    refreshAccessToken: async () => ({ accessToken: "refreshed", refreshToken: "r", expiry: null }),
    revokeToken: async () => {},
  };

  /**
   * An in-memory connector for a fictional "memo" provider. It supports one kind
   * ("notes"), serves a scripted delta keyed by cursor, and normalizes each memo
   * into a NormalizedItem — exactly what a real connector emits. No DB, no
   * network, no Google: proof the orchestrator is provider-agnostic.
   */
  class FakeMemoConnector implements Connector {
    readonly manifest = {
      id: "memo",
      displayName: "Memo",
      auth: { kind: "oauth2", scopes: ["read"] } as const,
      kinds: [
        {
          kind: "notes",
          displayName: "Notes",
          sourceType: "memo:notes",
          contentMode: "document" as const,
          defaultIntervalMinutes: 30,
        },
      ],
    };
    readonly oauth = fakeOAuth;
    /** cursor → the delta to serve. `fetchDelta` advances through this script. */
    deltas: Record<string, NormalizedDelta>;
    calls: Array<{ kind: string; cursor: string | null; token: string }> = [];

    constructor(deltas: Record<string, NormalizedDelta>) {
      this.deltas = deltas;
    }

    async fetchDelta(
      ctx: SyncContext,
      kind: string,
      cursor: string | null,
    ): Promise<NormalizedDelta> {
      this.calls.push({ kind, cursor, token: ctx.accessToken });
      return this.deltas[cursor ?? "initial"] ?? { items: [], deletions: [], nextCursor: cursor };
    }
  }

  function setupPipeline() {
    const db = openDatabase(":memory:");
    const store = new KnowledgeStore(db);
    const embedder = new HashEmbedder();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-fake-"));
    const llm = new StubLlmClient({});
    const wiki = new WikiWriter(store, llm, tmpDir);
    const pipeline = new IngestionPipeline({
      store,
      llm,
      embedder,
      wiki,
      scheduleWikiRefresh: () => {},
    });
    const cleanup = () => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    };
    return { store, pipeline, cleanup };
  }

  const note = (id: string, title: string, body: string): NormalizedDelta["items"][number] => ({
    externalId: id,
    title,
    path: `https://memo.example/${id}`,
    rawContent: JSON.stringify({ id, title, body }),
    normalizedContent: `Note: ${title}\n${body}`,
    extraction: {
      entities: [{ name: title, type: "concept", aliases: [], summary: "", relevance: "high" }],
      relationships: [],
      observations: [],
    },
  });

  it("registers + resolves a connector by provider id without touching the orchestrator", () => {
    const memo = new FakeMemoConnector({});
    const registry = new ConnectorRegistry([memo]);
    expect(registry.get("memo")).toBe(memo);
    expect(registry.require("memo").manifest.displayName).toBe("Memo");
    expect(() => registry.require("nope")).toThrow();
    expect(registry.list()).toHaveLength(1);
  });

  it("drives a fake connector through delta → normalize → materialize", async () => {
    const { store, pipeline, cleanup } = setupPipeline();
    const memo = new FakeMemoConnector({
      initial: {
        items: [note("n1", "Quantum notes", "spin and entanglement")],
        deletions: [],
        nextCursor: "cursor-1",
      },
    });
    const registry = new ConnectorRegistry([memo]);
    const account = store.upsertConnectorAccount({
      provider: "memo",
      clientId: "id",
      clientSecret: "secret",
      accessToken: "tok",
      refreshToken: "refresh",
    });

    const result = await syncConnector(
      { store, pipeline },
      store.getConnectorAccount("memo")!,
      "notes",
      registry.require("memo"),
    );

    expect(result.ingested).toBe(1);
    // The item was materialized as a memo:notes source.
    const ledger = store.getConnectorItem(account, "notes", "n1")!;
    expect(ledger.source_id).toBeTruthy();
    const source = store.getSource(ledger.source_id!)!;
    expect(source.type).toBe("memo:notes");
    expect(store.getSourceContent(source.id)).toContain("Quantum notes");
    // The connector's extraction reached the graph.
    expect(store.findEntityByName("Quantum notes")).toBeTruthy();
    // Cursor persisted for the next run.
    expect(store.getSyncState(account, "notes")!.sync_token).toBe("cursor-1");
    cleanup();
  });

  it("skips unchanged items and soft-deletes on a delta removal", async () => {
    const { store, pipeline, cleanup } = setupPipeline();
    const memo = new FakeMemoConnector({
      initial: {
        items: [note("n1", "Keep me", "v1"), note("n2", "Delete me", "v1")],
        deletions: [],
        nextCursor: "c1",
      },
      // Second run: n1 unchanged (same content hash), n2 removed.
      c1: {
        items: [note("n1", "Keep me", "v1")],
        deletions: ["n2"],
        nextCursor: "c2",
      },
    });
    const registry = new ConnectorRegistry([memo]);
    const accountId = store.upsertConnectorAccount({
      provider: "memo",
      clientId: "id",
      clientSecret: "secret",
      accessToken: "tok",
      refreshToken: "refresh",
    });

    const first = await syncConnector(
      { store, pipeline },
      store.getConnectorAccount("memo")!,
      "notes",
      registry.require("memo"),
    );
    expect(first.ingested).toBe(2);

    const second = await syncConnector(
      { store, pipeline },
      store.getConnectorAccount("memo")!,
      "notes",
      registry.require("memo"),
    );
    // n1 unchanged → skipped; n2 → soft-deleted.
    expect(second.skipped).toBe(1);
    expect(second.ingested).toBe(0);
    expect(second.deleted).toBe(1);

    const deletedLedger = store.getConnectorItem(accountId, "notes", "n2")!;
    const rev = store.activeRevision(deletedLedger.source_id!);
    // The source survives (audit history) but its revision is retired.
    expect(store.getSource(deletedLedger.source_id!)).toBeTruthy();
    expect(rev?.status === "deleted" || rev == null).toBe(true);
    cleanup();
  });

  it("retries from scratch when the saved cursor is stale (fullResync)", async () => {
    const { store, pipeline, cleanup } = setupPipeline();
    const memo = new FakeMemoConnector({
      // A run with the stale cursor signals fullResync; the re-pull from `initial`
      // (cursor=null) returns the real data.
      stale: { items: [], deletions: [], fullResync: true },
      initial: {
        items: [note("n1", "Recovered", "after resync")],
        deletions: [],
        nextCursor: "c-fresh",
      },
    });
    const registry = new ConnectorRegistry([memo]);
    const accountId = store.upsertConnectorAccount({
      provider: "memo",
      clientId: "id",
      clientSecret: "secret",
      accessToken: "tok",
      refreshToken: "refresh",
    });
    store.setSyncState(accountId, "notes", { syncToken: "stale" });

    const result = await syncConnector(
      { store, pipeline },
      store.getConnectorAccount("memo")!,
      "notes",
      registry.require("memo"),
    );
    expect(result.ingested).toBe(1);
    // Two fetchDelta calls: the stale cursor, then a full re-pull (null).
    expect(memo.calls.map((c) => c.cursor)).toEqual(["stale", null]);
    expect(store.getSyncState(accountId, "notes")!.sync_token).toBe("c-fresh");
    cleanup();
  });
});

describe("connector coverage state + structured sync metrics (#88)", () => {
  it("derives the user-facing coverage state from config", () => {
    // Never synced.
    expect(deriveCoverageState({})).toBe("idle");
    // A failed last attempt dominates.
    expect(
      deriveCoverageState({ lastSync: { at: "t", ok: false, indexed: 0, skipped: 0, deleted: 0 } }),
    ).toBe("failed");
    // Non-"recent" window without a backfill reads as recent-only.
    expect(
      deriveCoverageState({
        coverageWindow: "1y",
        lastSync: { at: "t", ok: true, indexed: 5, skipped: 0, deleted: 0 },
      }),
    ).toBe("recent-only");
    // An in-progress backfill reads as backfilling.
    expect(
      deriveCoverageState({
        coverageWindow: "all",
        backfill: {
          pageToken: "p",
          afterIso: null,
          indexed: 3,
          oldestIndexed: null,
          complete: false,
        },
        lastSync: { at: "t", ok: true, indexed: 3, skipped: 0, deleted: 0 },
      }),
    ).toBe("backfilling");
    // A finished backfill with no exclusions reads as complete.
    expect(
      deriveCoverageState({
        coverageWindow: "all",
        backfill: {
          pageToken: null,
          afterIso: null,
          indexed: 9,
          oldestIndexed: null,
          complete: true,
        },
        lastSync: { at: "t", ok: true, indexed: 9, skipped: 0, deleted: 0 },
      }),
    ).toBe("complete");
    // A task-list subset reads as partial.
    expect(
      deriveCoverageState({
        enabledTaskLists: ["list-1"],
        lastSync: { at: "t", ok: true, indexed: 2, skipped: 0, deleted: 0 },
      }),
    ).toBe("partial");
    // A plain "recent" window that synced cleanly reads as complete.
    expect(
      deriveCoverageState({
        coverageWindow: "recent",
        lastSync: { at: "t", ok: true, indexed: 4, skipped: 0, deleted: 0 },
      }),
    ).toBe("complete");
  });

  it("persists structured last-sync metrics on a successful sync", async () => {
    const db = openDatabase(":memory:");
    const store = new KnowledgeStore(db);
    const embedder = new HashEmbedder();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-metrics-"));
    const llm = new StubLlmClient({});
    const wiki = new WikiWriter(store, llm, tmpDir);
    const pipeline = new IngestionPipeline({
      store,
      llm,
      embedder,
      wiki,
      scheduleWikiRefresh: () => {},
    });

    const memo: Connector = {
      manifest: {
        id: "memo2",
        displayName: "Memo2",
        auth: { kind: "oauth2", scopes: ["read"] } as const,
        kinds: [
          {
            kind: "notes",
            displayName: "Notes",
            sourceType: "memo:notes",
            contentMode: "document" as const,
            defaultIntervalMinutes: 30,
          },
        ],
      },
      oauth: {
        scopes: ["read"],
        buildAuthUrl: () => "https://example.com/auth",
        exchangeCode: async () => ({ accessToken: "fresh", refreshToken: "r", expiry: null }),
        refreshAccessToken: async () => ({
          accessToken: "refreshed",
          refreshToken: "r",
          expiry: null,
        }),
        revokeToken: async () => {},
      },
      fetchDelta: async () => ({
        items: [
          {
            externalId: "n1",
            title: "Note one",
            path: "https://memo.example/n1",
            rawContent: JSON.stringify({ id: "n1" }),
            normalizedContent: "Note one body",
            extraction: { entities: [], relationships: [], observations: [] },
          },
        ],
        deletions: [],
        nextCursor: "c1",
      }),
    };

    const accountId = store.upsertConnectorAccount({
      provider: "memo2",
      clientId: "id",
      clientSecret: "secret",
      accessToken: "tok",
      refreshToken: "refresh",
    });
    await syncConnector({ store, pipeline }, store.getConnectorAccount("memo2")!, "notes", memo);

    const config = store.getSyncConfig(accountId, "notes");
    expect(config.lastSync).toBeDefined();
    expect(config.lastSync!.ok).toBe(true);
    expect(config.lastSync!.indexed).toBe(1);
    expect(config.lastSync!.okAt).toBeTruthy();
    // The free-text status is still written for legacy clients.
    expect(store.getSyncState(accountId, "notes")!.last_status).toContain("1 updated");

    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("migration 23 (connector materialization)", () => {
  it("migrates a v22-shape DB cleanly, preserving connector ledger rows", () => {
    expect(migrations.length).toBe(40);

    const file = path.join(os.tmpdir(), `meos-mig23-${Date.now()}-${Math.random()}.db`);
    try {
      const db = openDatabase(file);
      const store = new KnowledgeStore(db);
      const accountId = store.upsertConnectorAccount({
        provider: "google",
        clientId: "id",
        clientSecret: "secret",
        accessToken: "tok",
        refreshToken: "refresh",
      });
      const sourceId = store.createSource({
        type: "google:contacts",
        title: "Legacy contact",
        content: "old text",
      });
      store.recordConnectorItem(accountId, "contacts", "people/legacy", "hash0", sourceId);

      // Rewind to v22: drop the migration-23 column + the migration-24 priority
      // artifacts, and reset user_version, simulating a DB created before #19.
      db.exec(`DROP INDEX IF EXISTS idx_meeting_links_source;`);
      db.exec(`DROP TABLE IF EXISTS meeting_link_suggestions;`);
      db.exec(`DROP TABLE IF EXISTS meeting_notes;`);
      db.exec(`ALTER TABLE connector_items DROP COLUMN source_revision_id;`);
      db.exec(`DROP INDEX IF EXISTS idx_ingest_jobs_claim;`);
      db.exec(`ALTER TABLE ingest_jobs DROP COLUMN priority;`);
      db.exec(`ALTER TABLE connector_sync_state DROP COLUMN config;`);
      db.exec(
        `ALTER TABLE connector_accounts DROP COLUMN auth_config; ALTER TABLE wiki_pages DROP COLUMN body_hash; ALTER TABLE wiki_pages DROP COLUMN authored_by; ALTER TABLE wiki_runs DROP COLUMN author;`,
      );
      db.exec(
        `DROP TABLE IF EXISTS agent_task_runs; DROP TABLE IF EXISTS agent_tasks; DROP TABLE IF EXISTS message_agent_meta;`,
      );
      db.pragma("user_version = 22");
      db.close();

      // Re-open through the real migrator: migration 23 must apply cleanly.
      const upgraded = openDatabase(file);
      expect(upgraded.pragma("user_version", { simple: true })).toBe(migrations.length);
      const upStore = new KnowledgeStore(upgraded);
      // Legacy ledger row survived, with the new column back-filled to null.
      const ledger = upStore.getConnectorItem(accountId, "contacts", "people/legacy")!;
      expect(ledger.source_id).toBe(sourceId);
      expect(ledger.source_revision_id).toBeNull();
      // And the new revision link is now writable.
      const revisionId = upStore.createSourceRevision({ sourceId });
      upStore.recordConnectorItem(
        accountId,
        "contacts",
        "people/legacy",
        "hash1",
        sourceId,
        revisionId,
      );
      expect(
        upStore.getConnectorItem(accountId, "contacts", "people/legacy")!.source_revision_id,
      ).toBe(revisionId);
      upgraded.close();
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          fs.rmSync(file + suffix);
        } catch {
          /* ignore */
        }
      }
    }
  });
});

describe("migration 25 (provider-agnostic connector kinds)", () => {
  it("drops the kind CHECK so a non-Google kind is accepted, preserving rows", () => {
    expect(migrations.length).toBe(40);

    const file = path.join(os.tmpdir(), `meos-mig25-${Date.now()}-${Math.random()}.db`);
    try {
      const db = openDatabase(file);
      const store = new KnowledgeStore(db);
      const accountId = store.upsertConnectorAccount({
        provider: "google",
        clientId: "id",
        clientSecret: "secret",
        accessToken: "tok",
        refreshToken: "refresh",
      });
      // An existing Google sync-state row that must survive the table rebuild.
      store.setSyncState(accountId, "contacts", {
        enabled: true,
        intervalMinutes: 45,
        syncToken: "cursorA",
        lastStatus: "ok",
      });

      // Rewind to v24: restore the old CHECK-constrained table shape and reset
      // user_version, simulating a DB created before #5.
      db.exec(`
        CREATE TABLE connector_sync_state_old (
          account_id INTEGER NOT NULL REFERENCES connector_accounts(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('contacts','calendar','gmail')),
          enabled INTEGER NOT NULL DEFAULT 0,
          interval_minutes INTEGER NOT NULL DEFAULT 15,
          sync_token TEXT,
          last_synced_at TEXT,
          last_status TEXT,
          UNIQUE(account_id, kind)
        );
        INSERT INTO connector_sync_state_old
          SELECT account_id, kind, enabled, interval_minutes, sync_token, last_synced_at, last_status
          FROM connector_sync_state;
        DROP TABLE connector_sync_state;
        ALTER TABLE connector_sync_state_old RENAME TO connector_sync_state;
      `);
      // Drop the migration-26 (meeting-notes) artifacts created after #5 shipped,
      // so re-migrating from v24 re-applies them cleanly instead of colliding.
      db.exec(`DROP INDEX IF EXISTS idx_meeting_links_source;`);
      db.exec(`DROP TABLE IF EXISTS meeting_link_suggestions;`);
      db.exec(`DROP TABLE IF EXISTS meeting_notes;`);
      db.exec(
        `ALTER TABLE connector_accounts DROP COLUMN auth_config; ALTER TABLE wiki_pages DROP COLUMN body_hash; ALTER TABLE wiki_pages DROP COLUMN authored_by; ALTER TABLE wiki_runs DROP COLUMN author;`,
      );
      db.exec(
        `DROP TABLE IF EXISTS agent_task_runs; DROP TABLE IF EXISTS agent_tasks; DROP TABLE IF EXISTS message_agent_meta;`,
      );
      db.pragma("user_version = 24");
      // The old shape rejects a non-Google kind — the bug migration 25 fixes.
      expect(() =>
        db
          .prepare(`INSERT INTO connector_sync_state (account_id, kind) VALUES (?, 'notes')`)
          .run(accountId),
      ).toThrow();
      db.close();

      // Re-open through the real migrator: migration 25 rebuilds the table.
      const upgraded = openDatabase(file);
      expect(upgraded.pragma("user_version", { simple: true })).toBe(migrations.length);
      const upStore = new KnowledgeStore(upgraded);
      // The Google row carried over verbatim — cursor + interval + status intact.
      const state = upStore.getSyncState(accountId, "contacts")!;
      expect(state.sync_token).toBe("cursorA");
      expect(state.interval_minutes).toBe(45);
      expect(state.enabled).toBe(1);
      // And a non-Google kind is now accepted.
      upStore.setSyncState(accountId, "notes", { enabled: true, intervalMinutes: 10 });
      expect(upStore.getSyncState(accountId, "notes")!.enabled).toBe(1);
      upgraded.close();
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          fs.rmSync(file + suffix);
        } catch {
          /* ignore */
        }
      }
    }
  });
});

describe("content connectors name entities (pages); directory connectors stay references", () => {
  function setup() {
    const db = openDatabase(":memory:");
    const store = new KnowledgeStore(db);
    const embedder = new HashEmbedder();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-refs-"));
    const llm = new StubLlmClient({});
    const wiki = new WikiWriter(store, llm, tmpDir);
    const pipeline = new IngestionPipeline({
      store,
      llm,
      embedder,
      wiki,
      scheduleWikiRefresh: () => {},
    });
    const cleanup = () => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    };
    return { store, pipeline, wiki, cleanup };
  }

  const contact: ContactItem = {
    externalId: "people/ref1",
    displayName: "Grace Hopper",
    nicknames: [],
    emails: ["grace@example.com"],
    phones: [],
    deepLink: "https://contacts.google.com/person/ref1",
  };

  it("a contact-only person earns no page but stays searchable + linkable", async () => {
    const { store, pipeline, wiki, cleanup } = setup();
    await pipeline.ingestExtraction({
      type: "google:contacts",
      title: contact.displayName,
      content: "contact",
      path: contact.deepLink,
      extraction: mapContact(contact),
    });

    const person = store.findEntityByName("Grace Hopper")!;
    // No page-worthy backing → excluded from the page set; merge never marks stale.
    expect(store.entityWarrantsWikiPage(person.id)).toBe(false);
    expect(store.wikiPageEntityIds().has(person.id)).toBe(false);
    // New entities default to wiki_stale = 1; a regeneration pass clears it without
    // writing a noise page (no LLM call — the page-worthiness guard short-circuits).
    await wiki.regenerateStale();
    expect(store.getEntity(person.id)!.wiki_stale).toBe(0);
    expect(wiki.readPage(store.getEntity(person.id)!)).toBeNull();
    // But the entity exists and the connector source is attached (chip data).
    expect(store.sourcesForEntity(person.id).some((s) => s.type === "google:contacts")).toBe(true);

    cleanup();
  });

  it("a person also mentioned by a document earns a page and keeps the connector chip", async () => {
    const { store, pipeline, cleanup } = setup();
    await pipeline.ingestExtraction({
      type: "google:contacts",
      title: contact.displayName,
      content: "contact",
      path: contact.deepLink,
      extraction: mapContact(contact),
    });

    // A real (wiki-eligible) source now mentions the same person by name.
    await pipeline.ingestExtraction({
      type: "file",
      title: "Project notes",
      content: "Grace Hopper leads the compiler effort.",
      extraction: {
        entities: [{ name: "Grace Hopper", type: "person", aliases: [], summary: "Engineer." }],
        relationships: [],
        // Three normal facts from a wiki-eligible source clear the richness bar.
        observations: [
          {
            entity: "Grace Hopper",
            claim: "Grace Hopper leads the compiler effort.",
            kind: "fact",
            sourceQuote: "Grace Hopper leads the compiler effort.",
            validFrom: null,
            validUntil: null,
            confidence: 0.8,
            sensitivity: "normal",
          },
          {
            entity: "Grace Hopper",
            claim: "Grace Hopper coordinates the language working group.",
            kind: "fact",
            sourceQuote: "Grace Hopper coordinates the language working group.",
            validFrom: null,
            validUntil: null,
            confidence: 0.8,
            sensitivity: "normal",
          },
          {
            entity: "Grace Hopper",
            claim: "Grace Hopper authored the project's design memo.",
            kind: "fact",
            sourceQuote: "Grace Hopper authored the project's design memo.",
            validFrom: null,
            validUntil: null,
            confidence: 0.8,
            sensitivity: "normal",
          },
        ],
      },
    });

    const person = store.findEntityByName("Grace Hopper")!;
    // The document gives the person page-worthy backing → now warrants a page.
    expect(store.entityWarrantsWikiPage(person.id)).toBe(true);
    expect(store.wikiPageEntityIds().has(person.id)).toBe(true);
    // The connector source is still attached as a reference (chip data).
    expect(store.sourcesForEntity(person.id).some((s) => s.type === "google:contacts")).toBe(true);
    // …but the connector's private contact fact never reaches page prose.
    const visible = store.visibleObservations(person.id).map((o) => o.text);
    expect(visible.some((t) => t.includes("compiler effort"))).toBe(true);
    expect(visible.some((t) => t.toLowerCase().includes("email"))).toBe(false);

    cleanup();
  });

  it("a name-only contact (no facts at all) earns no page", async () => {
    const { store, pipeline, wiki, cleanup } = setup();
    // A contact with just a display name: no email/phone/org, so the mapper
    // produces a person entity with zero observations and zero relationships.
    const nameOnly: ContactItem = {
      externalId: "people/ref2",
      displayName: "Antoine Kocausta",
      nicknames: [],
      emails: [],
      phones: [],
      deepLink: "https://contacts.google.com/person/ref2",
    };
    await pipeline.ingestExtraction({
      type: "google:contacts",
      title: nameOnly.displayName,
      content: "contact",
      path: nameOnly.deepLink,
      extraction: mapContact(nameOnly),
    });

    const person = store.findEntityByName("Antoine Kocausta")!;
    // Factless entity → does not warrant a page (the bug: knowledge-less contacts
    // used to slip past the reference-only check and get an empty page).
    expect(store.activeObservations(person.id)).toHaveLength(0);
    expect(store.entityWarrantsWikiPage(person.id)).toBe(false);
    expect(store.wikiPageEntityIds().has(person.id)).toBe(false);
    await wiki.regenerateStale();
    expect(store.getEntity(person.id)!.wiki_stale).toBe(0);
    expect(wiki.readPage(store.getEntity(person.id)!)).toBeNull();

    cleanup();
  });

  it("a place richly described by a content connector (calendar) earns a page, source on-device", async () => {
    const { store, pipeline, cleanup } = setup();
    // No contact, no document — the only mentions of this place are calendar facts.
    // A calendar source is a content connector (private, on-device); with enough
    // substance (the richness clause) it warrants a page in the local wiki. The
    // Casablanca case — but a thin one-line mention would NOT (see the next test).
    await pipeline.ingestExtraction({
      type: "google:calendar",
      title: "Flight AT 721 to Casablanca",
      content: "Flight AT 721 to Casablanca",
      path: "https://calendar.google.com/event/abc",
      extraction: {
        entities: [{ name: "Casablanca", type: "place", aliases: [], summary: "A city." }],
        relationships: [],
        // Three normal facts from this content connector clear the richness bar.
        observations: [
          {
            entity: "Casablanca",
            claim: "Traveled to Casablanca on flight AT 721.",
            kind: "fact",
            sourceQuote: "Flight AT 721 to Casablanca",
            validFrom: null,
            validUntil: null,
            confidence: 0.8,
            sensitivity: "normal",
          },
          {
            entity: "Casablanca",
            claim: "Casablanca is the destination of flight AT 721.",
            kind: "fact",
            sourceQuote: "Flight AT 721 to Casablanca",
            validFrom: null,
            validUntil: null,
            confidence: 0.8,
            sensitivity: "normal",
          },
          {
            entity: "Casablanca",
            claim: "The Casablanca trip is booked on Royal Air Maroc.",
            kind: "fact",
            sourceQuote: "Flight AT 721 to Casablanca",
            validFrom: null,
            validUntil: null,
            confidence: 0.8,
            sensitivity: "normal",
          },
        ],
      },
    });

    const place = store.findEntityByName("Casablanca")!;
    // Content-connector backing → page-worthy, so it surfaces in the index + graph.
    expect(store.entityWarrantsWikiPage(place.id)).toBe(true);
    expect(store.wikiPageEntityIds().has(place.id)).toBe(true);
    // The calendar source stays on-device — wiki-eligible but never synced/exported.
    const calendar = store.sourcesForEntity(place.id).find((s) => s.type === "google:calendar")!;
    const v = store.sourceVisibility(calendar.id);
    expect(v.wikiEligible).toBe(true);
    expect(v.syncable).toBe(false);
    expect(v.exportable).toBe(false);

    cleanup();
  });

  it("a thin one-off mention stays a searchable source; a 2nd source graduates it (gate B)", async () => {
    const { store, pipeline, wiki, cleanup } = setup();
    // One calendar event names a brand exactly once: a single source, a single fact,
    // no relationships. This is the overcrowding case — it must NOT mint a page.
    const onceFromCalendar = {
      type: "google:calendar",
      title: "Demo of Acme Widget",
      content: "Demo of Acme Widget",
      path: "https://calendar.google.com/event/w1",
      extraction: {
        entities: [
          { name: "Acme Widget", type: "concept" as const, aliases: [], summary: "A product." },
        ],
        relationships: [],
        observations: [
          {
            entity: "Acme Widget",
            claim: "Saw a demo of Acme Widget.",
            kind: "fact",
            sourceQuote: "Demo of Acme Widget",
            validFrom: null,
            validUntil: null,
            confidence: 0.8,
            sensitivity: "normal" as const,
          },
        ],
      },
    };
    await pipeline.ingestExtraction(onceFromCalendar);

    const widget = store.findEntityByName("Acme Widget")!;
    // Below the relevance bar (1 source, 1 fact, 0 rels) → no page, just a source.
    expect(store.entityWarrantsWikiPage(widget.id)).toBe(false);
    expect(store.wikiPageEntityIds().has(widget.id)).toBe(false);
    await wiki.regenerateStale();
    expect(wiki.readPage(store.getEntity(widget.id)!)).toBeNull();
    // …but it stays fully searchable as a source-linked entity.
    expect(store.sourcesForEntity(widget.id).length).toBeGreaterThan(0);

    // A SECOND source names it → recurrence clears the bar → it graduates to a page.
    await pipeline.ingestExtraction({
      type: "google:gmail",
      title: "Acme Widget pricing",
      content: "Acme Widget pricing",
      path: "https://mail.google.com/mail/u/0/#all/w2",
      extraction: {
        entities: [{ name: "Acme Widget", type: "concept", aliases: [], summary: "A product." }],
        relationships: [],
        observations: [
          {
            entity: "Acme Widget",
            claim: "Received Acme Widget pricing.",
            kind: "fact",
            sourceQuote: "Acme Widget pricing",
            validFrom: null,
            validUntil: null,
            confidence: 0.8,
            sensitivity: "normal",
          },
        ],
      },
    });
    expect(store.entityWarrantsWikiPage(widget.id)).toBe(true);
    expect(store.wikiPageEntityIds().has(widget.id)).toBe(true);

    cleanup();
  });
});

describe("indexed sources (Sources tab)", () => {
  it("lists connector items as linked entities with related siblings", async () => {
    const db = openDatabase(":memory:");
    const store = new KnowledgeStore(db);
    const embedder = new HashEmbedder();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-src-"));
    const llm = new StubLlmClient({});
    const wiki = new WikiWriter(store, llm, tmpDir);
    const pipeline = new IngestionPipeline({
      store,
      llm,
      embedder,
      wiki,
      scheduleWikiRefresh: () => {},
    });

    const contact: ContactItem = {
      externalId: "people/c1",
      displayName: "Charles Babbage",
      nicknames: [],
      emails: ["charles@example.com"],
      phones: [],
      organisation: "Analytical Engine Co",
      deepLink: "https://contacts.google.com/person/c1",
    };
    await pipeline.ingestExtraction({
      type: "google:contacts",
      title: contact.displayName,
      content: "contact",
      path: contact.deepLink,
      extraction: mapContact(contact),
    });

    const message: GmailMessageItem = {
      externalId: "msg1",
      threadId: "t1",
      subject: "Re: the engine",
      date: "2026-01-02T10:00:00Z",
      from: { name: "Charles Babbage", email: "charles@example.com" },
      to: [{ name: "Ada Lovelace", email: "ada@example.com" }],
      snippet: "the plans are ready",
      deepLink: "https://mail.google.com/mail/u/0/#inbox/msg1",
    };
    await pipeline.ingestExtraction({
      type: "google:gmail",
      title: message.subject,
      content: "email",
      path: message.deepLink,
      extraction: mapGmailMessage(message, self),
    });

    // Both items surface as first-class indexed sources, newest first.
    const indexed = store.listIndexedSources();
    expect(indexed.map((s) => s.kind).sort()).toEqual(["contacts", "gmail"]);

    const email = indexed.find((s) => s.kind === "gmail")!;
    expect(email.provider).toBe("google");
    expect(email.link).toBe(message.deepLink);
    expect(email.status).toBe("active");
    // The email is linked to its correspondent entity.
    expect(email.linkedEntities.some((e) => e.name === "Charles Babbage")).toBe(true);

    // Detail: the email and the contact connect through the shared person.
    const detail = store.getIndexedSource(email.id)!;
    expect(detail.relatedSources.some((r) => r.kind === "contacts")).toBe(true);
    expect(detail.relatedSources.find((r) => r.kind === "contacts")!.via).toContain(
      "Charles Babbage",
    );

    // A non-connector / unknown source is not an indexed source.
    expect(store.getIndexedSource(999_999)).toBeUndefined();

    // The wiki-maintainer reads an entity's indexed sources (with content) as files.
    const person = store.findEntityByName("Charles Babbage")!;
    const backing = store.indexedSourcesForEntity(person.id);
    expect(backing.map((s) => s.type).sort()).toEqual(["google:contacts", "google:gmail"]);
    expect(backing.every((s) => (s.content ?? "").length > 0)).toBe(true);

    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("connector index vs wiki mode", () => {
  function makePipeline() {
    const db = openDatabase(":memory:");
    const store = new KnowledgeStore(db);
    const embedder = new HashEmbedder();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-mode-"));
    const llm = new StubLlmClient({});
    const wiki = new WikiWriter(store, llm, tmpDir);
    let refreshes = 0;
    const pipeline = new IngestionPipeline({
      store,
      llm,
      embedder,
      wiki,
      scheduleWikiRefresh: () => {
        refreshes++;
      },
    });
    const cleanup = () => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    };
    return { store, pipeline, refreshes: () => refreshes, cleanup };
  }

  const contact: ContactItem = {
    externalId: "people/m1",
    displayName: "Grace Hopper",
    nicknames: [],
    emails: ["grace@example.com"],
    phones: [],
    organisation: "US Navy",
    deepLink: "https://contacts.google.com/person/m1",
  };

  it("index mode merges entities + indexes but does not author the wiki", async () => {
    const { store, pipeline, refreshes, cleanup } = makePipeline();
    const out = await pipeline.materialize({
      type: "google:contacts",
      title: contact.displayName,
      path: contact.deepLink,
      rawContent: JSON.stringify(contact),
      normalizedContent: "Contact: Grace Hopper\nEmail: grace@example.com",
      extraction: mapContact(contact),
      skipWikiRefresh: true,
    });
    expect(out.status).toBe("done");
    // Entity merged + the item is a browsable indexed source...
    expect(store.findEntityByName("Grace Hopper")).toBeTruthy();
    expect(store.listIndexedSources().some((s) => s.id === out.sourceId)).toBe(true);
    // ...but the sync did not spin up a wiki regeneration.
    expect(refreshes()).toBe(0);
    cleanup();
  });

  it("wiki mode triggers wiki regeneration", async () => {
    const { pipeline, refreshes, cleanup } = makePipeline();
    await pipeline.materialize({
      type: "google:contacts",
      title: contact.displayName,
      path: contact.deepLink,
      rawContent: JSON.stringify(contact),
      normalizedContent: "Contact: Grace Hopper\nEmail: grace@example.com",
      extraction: mapContact(contact),
    });
    expect(refreshes()).toBeGreaterThan(0);
    cleanup();
  });
});

describe("connector manifest hygiene — scales without drift", () => {
  // The catalog + all views derive from these manifests, so incomplete or colliding
  // metadata is the class of bug behind the old "tasks chip had no icon" drift. This
  // guard fails the moment a registered connector declares an incomplete/duplicate kind.
  it("every registered connector + kind declares complete, unique catalog metadata", () => {
    const seenSourceTypes = new Set<string>();
    for (const connector of connectorRegistry.list()) {
      const m = connector.manifest;
      expect(m.id, "connector id").toBeTruthy();
      expect(m.displayName, `${m.id} displayName`).toBeTruthy();
      expect(m.logo, `${m.id} logo id`).toBeTruthy();
      expect(m.kinds.length, `${m.id} has at least one kind`).toBeGreaterThan(0);
      // OAuth connectors must expose an OAuth surface; basic ones must declare fields.
      if (m.auth.kind === "oauth2") expect(connector.oauth, `${m.id} oauth surface`).toBeDefined();
      else expect(m.auth.fields.length, `${m.id} basic auth fields`).toBeGreaterThan(0);
      for (const k of m.kinds) {
        expect(k.displayName, `${m.id}.${k.kind} displayName`).toBeTruthy();
        // A logo id always resolves (the kind's, falling back to the connector's).
        expect(k.logo ?? m.logo, `${m.id}.${k.kind} logo id`).toBeTruthy();
        // sourceType is "<provider>:<kind>" and globally unique — one chip/visibility key.
        expect(k.sourceType, `${m.id}.${k.kind} sourceType shape`).toMatch(
          /^[a-z0-9-]+:[a-z0-9-]+$/,
        );
        expect(seenSourceTypes.has(k.sourceType), `duplicate sourceType ${k.sourceType}`).toBe(
          false,
        );
        seenSourceTypes.add(k.sourceType);
      }
    }
  });

  it("private-by-default kinds inherit off-sync visibility from the registry", () => {
    // Proves register() injected each built-in connector's privacy defaults — a new
    // connector's data stays off portable artifacts with no extra wiring. Private is
    // now decoupled from the wiki: private content feeds the LOCAL wiki, and only
    // directory/identity kinds (contacts) are additionally kept off it.
    for (const connector of connectorRegistry.list()) {
      for (const k of connector.manifest.kinds) {
        if (k.private === false) continue;
        const v = defaultVisibilityForType(k.sourceType);
        // Off portable artifacts, but still usable locally (searchable + answerable).
        expect(v.syncable, `${k.sourceType} syncable`).toBe(false);
        expect(v.exportable, `${k.sourceType} exportable`).toBe(false);
        expect(v.searchable && v.answerable, `${k.sourceType} searchable+answerable`).toBe(true);
        // Content connectors feed the local wiki; directory/identity kinds do not.
        expect(v.wikiEligible, `${k.sourceType} wikiEligible`).toBe(k.directory !== true);
      }
    }
  });
});

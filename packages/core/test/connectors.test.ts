import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type MeosDatabase } from "../src/db/database.js";
import { HashEmbedder } from "../src/embedding/embedder.js";
import { IngestionPipeline } from "../src/ingest/pipeline.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { StubLlmClient } from "../src/llm/stub.js";
import { WikiWriter } from "../src/wiki/writer.js";
import { mapCalendarEvent } from "../src/connectors/map/calendar.js";
import { mapContact } from "../src/connectors/map/contacts.js";
import { mapGmailMessage } from "../src/connectors/map/gmail.js";
import type {
  CalendarEventItem,
  ContactItem,
  GmailMessageItem,
  SelfIdentity,
} from "../src/connectors/types.js";

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

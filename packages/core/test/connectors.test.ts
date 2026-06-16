import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrations, openDatabase } from "../src/db/database.js";
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

describe("migration 23 (connector materialization)", () => {
  it("migrates a v22-shape DB cleanly, preserving connector ledger rows", () => {
    expect(migrations.length).toBe(24);

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
      db.exec(`ALTER TABLE connector_items DROP COLUMN source_revision_id;`);
      db.exec(`DROP INDEX IF EXISTS idx_ingest_jobs_claim;`);
      db.exec(`ALTER TABLE ingest_jobs DROP COLUMN priority;`);
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

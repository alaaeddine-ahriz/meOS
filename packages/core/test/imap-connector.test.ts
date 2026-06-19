import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FetchMessageObject } from "imapflow";
import { openDatabase } from "../src/db/database.js";
import { HashEmbedder } from "../src/embedding/embedder.js";
import { IngestionPipeline } from "../src/ingest/pipeline.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { StubLlmClient } from "../src/llm/stub.js";
import { WikiWriter } from "../src/wiki/writer.js";
import { ConnectorRegistry } from "../src/connectors/registry.js";
import { syncConnector } from "../src/connectors/sync.js";
import { ImapConnector, type ImapClient } from "../src/connectors/imap/connector.js";
import { mapEmailMessage } from "../src/connectors/map/email.js";
import type { SyncContext } from "../src/connectors/framework.js";
import type { SelfIdentity } from "../src/connectors/types.js";

const self: SelfIdentity = { name: "Ada Lovelace", email: "ada@example.com" };

/**
 * A scripted in-memory IMAP client implementing the connector's {@link ImapClient}
 * seam — no socket, no server. It serves a fixed mailbox + message set, records
 * connect/logout calls, and ranges every UID it's asked for (the connector filters
 * to UID > lastUid itself), proving the normalize + cursor + resync logic offline.
 */
class FakeImapClient implements ImapClient {
  connected = false;
  loggedOut = false;
  constructor(
    private readonly mailbox: { uidValidity: bigint; uidNext: number; exists: number },
    private readonly messages: FetchMessageObject[],
  ) {}

  async connect(): Promise<void> {
    this.connected = true;
  }
  async logout(): Promise<void> {
    this.loggedOut = true;
  }
  async mailboxOpen() {
    return this.mailbox;
  }
  async fetchAll(): Promise<FetchMessageObject[]> {
    // The connector asks for a `from:*` range; hand back the whole script and let it
    // filter by UID. Mirrors imapflow returning every message in the requested range.
    return this.messages;
  }
}

/** Build a fetch-shaped message with an envelope (metadata only — no source/body). */
const msg = (
  uid: number,
  subject: string,
  from: { name?: string; address: string },
  to: Array<{ name?: string; address: string }>,
  date: string,
): FetchMessageObject =>
  ({
    seq: uid,
    uid,
    envelope: { subject, from: [from], to, date: new Date(date) },
    internalDate: new Date(date),
    size: 1024,
  }) as unknown as FetchMessageObject;

const authConfig = {
  host: "imap.example.com",
  port: "993",
  username: "ada@example.com",
  password: "app-password",
};
const ctx = (): SyncContext => ({ accessToken: "", authConfig });

describe("email mapper (IMAP/Gmail-shared)", () => {
  it("maps an email to a private exchange fact and a knows edge to you", () => {
    const extraction = mapEmailMessage(
      {
        subject: "Re: punched cards",
        date: "2026-06-01T09:00:00Z",
        from: { email: "charles@example.com", name: "Charles Babbage" },
        to: [{ email: "ada@example.com" }],
      },
      self,
    );

    const exchange = extraction.observations.find((o) => o.entity === "Charles Babbage")!;
    expect(exchange.kind).toBe("event");
    expect(exchange.sensitivity).toBe("private");
    expect(exchange.validFrom).toBe("2026-06-01");
    // You are never a correspondent of your own message.
    expect(extraction.observations.every((o) => o.entity !== "Ada Lovelace")).toBe(true);
    expect(extraction.relationships).toContainEqual({
      from: "Ada Lovelace",
      to: "Charles Babbage",
      label: "knows",
    });
  });

  it("falls back to a name derived from the address when no display name is set", () => {
    const extraction = mapEmailMessage(
      {
        subject: "Hello",
        from: { email: "charles.babbage@example.com" },
        to: [{ email: "ada@example.com" }],
      },
      self,
    );
    expect(extraction.entities.some((e) => e.name === "Charles Babbage")).toBe(true);
  });
});

describe("IMAP connector — fetchDelta", () => {
  it("rejects an unknown kind", async () => {
    const connector = new ImapConnector(
      () => new FakeImapClient({ uidValidity: 1n, uidNext: 1, exists: 0 }, []),
    );
    await expect(connector.fetchDelta(ctx(), "calendar", null)).rejects.toThrow(/does not support/);
  });

  it("normalizes a message to a metadata-only NormalizedItem and connects/logs out", async () => {
    const client = new FakeImapClient({ uidValidity: 42n, uidNext: 11, exists: 1 }, [
      msg(
        10,
        "Engine plans",
        { name: "Charles Babbage", address: "charles@example.com" },
        [{ address: "ada@example.com" }],
        "2026-06-01T09:00:00Z",
      ),
    ]);
    const connector = new ImapConnector(() => client);

    const delta = await connector.fetchDelta(ctx(), "messages", null);

    expect(client.connected).toBe(true);
    expect(client.loggedOut).toBe(true);
    expect(delta.items).toHaveLength(1);
    const item = delta.items[0]!;
    // External id is "<uidValidity>-<uid>"; title is the subject; path is synthetic.
    expect(item.externalId).toBe("42-10");
    expect(item.title).toBe("Engine plans");
    expect(item.path).toBe("imap://imap.example.com/INBOX/10");
    // Label-led normalized text — subject/from/to/date, never a body.
    expect(item.normalizedContent).toContain("Email: Engine plans");
    expect(item.normalizedContent).toContain("From: Charles Babbage");
    expect(item.normalizedContent).not.toMatch(/Body:/);
    // The mapper ran: a person entity + a knows edge anchored to the IMAP user
    // (whose name is derived from their address, "ada@example.com" → "Ada").
    expect(item.extraction.relationships).toContainEqual({
      from: "Ada",
      to: "Charles Babbage",
      label: "knows",
    });
  });

  it("advances the cursor to the highest seen UID and reports no deletions", async () => {
    const client = new FakeImapClient({ uidValidity: 42n, uidNext: 13, exists: 2 }, [
      msg(
        11,
        "First",
        { address: "a@example.com" },
        [{ address: "ada@example.com" }],
        "2026-06-01T09:00:00Z",
      ),
      msg(
        12,
        "Second",
        { address: "b@example.com" },
        [{ address: "ada@example.com" }],
        "2026-06-02T09:00:00Z",
      ),
    ]);
    const connector = new ImapConnector(() => client);

    const delta = await connector.fetchDelta(ctx(), "messages", null);
    expect(delta.deletions).toEqual([]);
    expect(delta.nextCursor).toBeTruthy();
    expect(JSON.parse(delta.nextCursor as string)).toEqual({ uidValidity: 42, lastUid: 12 });
  });

  it("only pulls UIDs above the saved high-water mark on an incremental run", async () => {
    // The fake returns UIDs 11 and 12; a saved cursor at lastUid=11 means only 12 is new.
    const client = new FakeImapClient({ uidValidity: 42n, uidNext: 13, exists: 2 }, [
      msg(
        11,
        "Old",
        { address: "a@example.com" },
        [{ address: "ada@example.com" }],
        "2026-06-01T09:00:00Z",
      ),
      msg(
        12,
        "New",
        { address: "b@example.com" },
        [{ address: "ada@example.com" }],
        "2026-06-02T09:00:00Z",
      ),
    ]);
    const connector = new ImapConnector(() => client);

    const cursor = JSON.stringify({ uidValidity: 42, lastUid: 11 });
    const delta = await connector.fetchDelta(ctx(), "messages", cursor);
    expect(delta.items.map((i) => i.title)).toEqual(["New"]);
    expect(JSON.parse(delta.nextCursor as string)).toEqual({ uidValidity: 42, lastUid: 12 });
  });

  it("requests a full resync when the mailbox UIDVALIDITY changes", async () => {
    // The mailbox now reports uidValidity 99; the saved cursor was scoped to 42, so
    // every saved UID is stale — the connector asks the orchestrator to re-pull.
    const client = new FakeImapClient({ uidValidity: 99n, uidNext: 13, exists: 2 }, [
      msg(
        12,
        "Whatever",
        { address: "b@example.com" },
        [{ address: "ada@example.com" }],
        "2026-06-02T09:00:00Z",
      ),
    ]);
    const connector = new ImapConnector(() => client);

    const cursor = JSON.stringify({ uidValidity: 42, lastUid: 11 });
    const delta = await connector.fetchDelta(ctx(), "messages", cursor);
    expect(delta.fullResync).toBe(true);
    expect(delta.items).toEqual([]);
    expect(client.loggedOut).toBe(true);
  });

  it("always logs out even when the fetch throws mid-sync", async () => {
    class ThrowingClient extends FakeImapClient {
      async fetchAll(): Promise<FetchMessageObject[]> {
        throw new Error("IMAP read failed");
      }
    }
    const client = new ThrowingClient({ uidValidity: 1n, uidNext: 1, exists: 0 }, []);
    const connector = new ImapConnector(() => client);
    await expect(connector.fetchDelta(ctx(), "messages", null)).rejects.toThrow("IMAP read failed");
    expect(client.loggedOut).toBe(true);
  });

  it("throws when credentials are missing", async () => {
    const connector = new ImapConnector(
      () => new FakeImapClient({ uidValidity: 1n, uidNext: 1, exists: 0 }, []),
    );
    await expect(
      connector.fetchDelta({ accessToken: "", authConfig: { host: "x" } }, "messages", null),
    ).rejects.toThrow(/credentials/);
  });
});

describe("IMAP connector — testConnection", () => {
  it("returns ok after a successful connect + logout", async () => {
    const client = new FakeImapClient({ uidValidity: 1n, uidNext: 1, exists: 0 }, []);
    const connector = new ImapConnector(() => client);
    const result = await connector.testConnection(authConfig);
    expect(result).toEqual({ ok: true });
    expect(client.connected).toBe(true);
    expect(client.loggedOut).toBe(true);
  });

  it("returns an error when the connection fails", async () => {
    class FailingClient extends FakeImapClient {
      async connect(): Promise<void> {
        throw new Error("auth rejected");
      }
    }
    const connector = new ImapConnector(
      () => new FailingClient({ uidValidity: 1n, uidNext: 1, exists: 0 }, []),
    );
    const result = await connector.testConnection(authConfig);
    expect(result).toEqual({ ok: false, error: "auth rejected" });
  });

  it("rejects incomplete credentials without connecting", async () => {
    const connector = new ImapConnector(
      () => new FakeImapClient({ uidValidity: 1n, uidNext: 1, exists: 0 }, []),
    );
    const result = await connector.testConnection({ host: "imap.example.com" });
    expect(result.ok).toBe(false);
  });
});

describe("basic-auth sync seam — syncConnector parses auth_config into ctx.authConfig", () => {
  function setupPipeline() {
    const db = openDatabase(":memory:");
    const store = new KnowledgeStore(db);
    const embedder = new HashEmbedder();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "meos-imap-"));
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

  it("materializes an IMAP message end-to-end via the basic-auth (no-token) path", async () => {
    const { store, pipeline, cleanup } = setupPipeline();
    try {
      const seen: SyncContext[] = [];
      const client = new FakeImapClient({ uidValidity: 7n, uidNext: 6, exists: 1 }, [
        msg(
          5,
          "Punched cards",
          { name: "Charles Babbage", address: "charles@example.com" },
          [{ address: "ada@example.com" }],
          "2026-06-01T09:00:00Z",
        ),
      ]);
      // Wrap fetchDelta to capture the SyncContext the orchestrator builds.
      const connector = new ImapConnector(() => client);
      const orig = connector.fetchDelta.bind(connector);
      connector.fetchDelta = async (ctx, kind, cursor) => {
        seen.push(ctx);
        return orig(ctx, kind, cursor);
      };
      const registry = new ConnectorRegistry([connector]);

      // Persist credentials the way the route does: a JSON auth_config, no token.
      store.upsertConnectorAccount({
        provider: "imap",
        authConfig: JSON.stringify(authConfig),
      });
      const account = store.getConnectorAccount("imap")!;
      // The account reads as connected purely off auth_config (no token columns).
      expect(account.access_token).toBeNull();
      expect(account.auth_config).toBeTruthy();

      const result = await syncConnector(
        { store, pipeline },
        account,
        "messages",
        registry.require("imap"),
      );

      // The orchestrator handed the parsed credentials through, not a token.
      expect(seen[0]!.accessToken).toBe("");
      expect(seen[0]!.authConfig).toMatchObject({
        host: "imap.example.com",
        username: "ada@example.com",
      });

      expect(result.ingested).toBe(1);
      const ledger = store.getConnectorItem(account.id, "messages", "7-5")!;
      const source = store.getSource(ledger.source_id!)!;
      expect(source.type).toBe("imap:messages");
      // The cursor persisted for the next incremental run.
      expect(JSON.parse(store.getSyncState(account.id, "messages")!.sync_token!)).toEqual({
        uidValidity: 7,
        lastUid: 5,
      });
      // The mapper's correspondent reached the graph.
      expect(store.findEntityByName("Charles Babbage")).toBeTruthy();
    } finally {
      cleanup();
    }
  });
});

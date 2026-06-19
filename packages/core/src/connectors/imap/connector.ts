/**
 * IMAP behind the connector framework — meOS's first BASIC-AUTH connector. Unlike
 * Google (OAuth + REST), IMAP authenticates with a host/username/password the user
 * pastes in Settings, carried into the sync via {@link SyncContext.authConfig}
 * instead of an access token. It indexes email METADATA only (subject/from/to/
 * date), never the body — mirroring Gmail's privacy posture.
 *
 * v1 is INBOX-only and append-only: the cursor is the highest UID seen, scoped by
 * the mailbox's UIDVALIDITY. A UIDVALIDITY change (the mailbox was recreated) means
 * every saved UID is meaningless, so we ask the orchestrator for a full resync.
 */

import { ImapFlow, type ImapFlowOptions, type FetchMessageObject } from "imapflow";
import type {
  Connector,
  ConnectorManifest,
  NormalizedDelta,
  NormalizedItem,
  SyncContext,
} from "../framework.js";
import { mapEmailMessage, type EmailAddress } from "../map/email.js";
import { nameFromEmail } from "../map/helpers.js";
import type { SelfIdentity } from "../types.js";

/** The IMAP connector's static description: id, the one kind, and the basic-auth form. */
export const IMAP_MANIFEST: ConnectorManifest = {
  id: "imap",
  displayName: "Email (IMAP)",
  logo: "email",
  summary: "Index email metadata from any IMAP mailbox.",
  auth: {
    kind: "basic",
    fields: [
      {
        key: "host",
        label: "IMAP host",
        type: "text",
        required: true,
        placeholder: "imap.example.com",
      },
      { key: "port", label: "Port", type: "number", placeholder: "993" },
      { key: "username", label: "Email address", type: "text", required: true },
      { key: "password", label: "Password / app password", type: "password", required: true },
    ],
  },
  kinds: [
    {
      kind: "messages",
      displayName: "Email",
      sourceType: "imap:messages",
      contentMode: "metadata",
      defaultIntervalMinutes: 15,
      logo: "email",
      noun: { one: "email", many: "emails" },
      blurb: "Email metadata (subject, sender, date) from your IMAP mailbox.",
      private: true,
    },
  ],
};

/** The mailbox v1 syncs. UIDs are only unique within a mailbox, so the cursor is too. */
const INBOX = "INBOX";

/**
 * On the first sync we seed only the most recent window rather than the whole
 * mailbox — a fresh connect to a large inbox shouldn't pull tens of thousands of
 * messages. Mirrors Gmail's "recent" default.
 */
const RECENT_WINDOW = 100;

/** A page caps how many messages one fetch normalizes, so a big delta drains in steps. */
const PAGE_SIZE = 200;

/**
 * The IMAP cursor, persisted as JSON between runs. `uidValidity` scopes the UIDs:
 * if the mailbox reports a different value next time, every saved UID is stale and
 * we full-resync. `lastUid` is the highest UID already indexed.
 */
interface ImapCursor {
  uidValidity: number;
  lastUid: number;
}

/** The minimal IMAP client surface the connector uses — the seam tests stub. */
export interface ImapClient {
  connect(): Promise<void>;
  logout(): Promise<void>;
  mailboxOpen(path: string): Promise<{ uidValidity: bigint; uidNext: number; exists: number }>;
  fetchAll(
    range: string,
    query: { uid?: boolean; envelope?: boolean; internalDate?: boolean; size?: boolean },
    options?: { uid?: boolean },
  ): Promise<FetchMessageObject[]>;
}

/** Build a real imapflow client from the basic-auth credentials (host/port/user/pass). */
export function createImapClient(authConfig: Record<string, string>): ImapClient {
  const options: ImapFlowOptions = {
    host: authConfig.host ?? "",
    port: authConfig.port ? Number(authConfig.port) : 993,
    secure: true,
    auth: { user: authConfig.username ?? "", pass: authConfig.password ?? "" },
    // The connector logs through the orchestrator; imapflow's own logger is noise.
    logger: false,
    // Fail fast on a dead/wrong host instead of imapflow's 90s default, so a bad
    // credentials test (or a flaky server) doesn't hang the route or a sync.
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
  };
  // ImapFlow structurally satisfies the ImapClient subset the connector uses.
  return new ImapFlow(options);
}

/** A factory so tests can inject a fake client; defaults to a real imapflow connection. */
export type ImapClientFactory = (authConfig: Record<string, string>) => ImapClient;

const parseCursor = (cursor: string | null): ImapCursor | null => {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(cursor) as ImapCursor;
    if (typeof parsed.uidValidity === "number" && typeof parsed.lastUid === "number") return parsed;
  } catch {
    // Fall through — a malformed cursor is treated as "never synced".
  }
  return null;
};

/** First address in an envelope header (sender/recipient), normalized. */
const addr = (a?: { name?: string; address?: string }): EmailAddress => ({
  name: a?.name,
  email: a?.address ?? "",
});

/** Every address in an envelope list (e.g. all To: recipients), dropping blanks. */
const addrs = (list?: Array<{ name?: string; address?: string }>): EmailAddress[] =>
  (list ?? []).map(addr).filter((a) => a.email);

/**
 * A human-readable rendering of an IMAP message — the NORMALIZED, label-led text
 * that gets chunked, embedded, indexed, and extracted. Subject/From/To/Date plus a
 * synthetic snippet line; the body is never fetched, so it never leaks into search.
 */
function renderMessage(meta: {
  subject: string;
  from: EmailAddress;
  to: EmailAddress[];
  date: string | null;
}): string {
  const lines = [`Email: ${meta.subject}`];
  if (meta.date) lines.push(`Date: ${meta.date}`);
  lines.push(`From: ${meta.from.name || meta.from.email || "(unknown)"}`);
  if (meta.to.length) lines.push(`To: ${meta.to.map((t) => t.name || t.email).join(", ")}`);
  return lines.join("\n");
}

/** Turn one fetched message into a NormalizedItem (metadata only) for the given mailbox. */
function normalizeMessage(
  msg: FetchMessageObject,
  uidValidity: number,
  host: string,
  self: SelfIdentity,
): NormalizedItem {
  const envelope = msg.envelope ?? {};
  const subject = envelope.subject?.trim() || "(no subject)";
  const from = addr(envelope.from?.[0]);
  const to = addrs(envelope.to);
  const date = envelope.date ? new Date(envelope.date).toISOString() : null;
  return {
    externalId: `${uidValidity}-${msg.uid}`,
    title: subject,
    path: `imap://${host}/${INBOX}/${msg.uid}`,
    // The raw envelope, kept verbatim so a reprocess needs no re-fetch. The body is
    // deliberately absent — metadata-only indexing.
    rawContent: JSON.stringify(
      { uid: msg.uid, uidValidity, envelope, internalDate: msg.internalDate, size: msg.size },
      null,
      2,
    ),
    normalizedContent: renderMessage({ subject, from, to, date: date ? date.slice(0, 10) : null }),
    extraction: mapEmailMessage({ subject, date: date ?? undefined, from, to }, self),
  };
}

export class ImapConnector implements Connector {
  readonly manifest = IMAP_MANIFEST;

  /** Overridable so tests inject a fake client; production builds a real imapflow one. */
  constructor(private readonly clientFactory: ImapClientFactory = createImapClient) {}

  /**
   * Connect, fetch a delta from INBOX, normalize each message to metadata, and
   * always close the connection. On the first sync (no cursor) we seed only the
   * recent window; otherwise we pull UIDs above the saved high-water mark. A
   * UIDVALIDITY change asks the orchestrator to clear the cursor and re-pull.
   */
  async fetchDelta(
    ctx: SyncContext,
    kind: string,
    cursor: string | null,
  ): Promise<NormalizedDelta> {
    if (kind !== "messages") throw new Error(`IMAP connector does not support kind: ${kind}`);
    const auth = ctx.authConfig;
    if (!auth?.host || !auth?.username || !auth?.password) {
      throw new Error("IMAP connector is missing host/username/password credentials.");
    }
    // The account owner is the IMAP user — their own address anchors "knows" edges.
    // IMAP gives us no display name, so we derive one from the address so the owner
    // folds into the graph as a named person rather than a bare email.
    const self: SelfIdentity = { name: nameFromEmail(auth.username), email: auth.username };
    const host = auth.host;

    const client = this.clientFactory(auth);
    await client.connect();
    try {
      const mailbox = await client.mailboxOpen(INBOX);
      const uidValidity = Number(mailbox.uidValidity);
      const saved = parseCursor(cursor);

      // The mailbox was recreated upstream — every saved UID is meaningless. Tell the
      // orchestrator to clear the cursor and call us again with cursor=null.
      if (saved && saved.uidValidity !== uidValidity) {
        return { items: [], deletions: [], fullResync: true };
      }

      // The UID lower bound (exclusive): the recent-window seed on a first sync, or
      // just above the high-water mark on an incremental run.
      const fromUid = saved ? saved.lastUid + 1 : Math.max(1, mailbox.uidNext - RECENT_WINDOW);
      // `*` always returns the last message even when none are newer, so we filter to
      // strictly-greater UIDs below. Page so a large backlog drains in bounded steps.
      const range = `${fromUid}:*`;
      const fetched = await client.fetchAll(
        range,
        { uid: true, envelope: true, internalDate: true, size: true },
        { uid: true },
      );
      const fresh = fetched.filter((m) => m.uid >= fromUid).sort((a, b) => a.uid - b.uid);
      const page = fresh.slice(0, PAGE_SIZE);
      const hasMore = fresh.length > PAGE_SIZE;

      const items = page.map((m) => normalizeMessage(m, uidValidity, host, self));
      // Advance the high-water mark to the last UID in this page, or hold the saved
      // cursor when nothing new arrived (a bare `*` match we filtered out).
      const highestUid = page.at(-1)?.uid ?? saved?.lastUid ?? fromUid - 1;
      const nextCursor: ImapCursor = { uidValidity, lastUid: highestUid };

      return {
        items,
        // v1 indexes append-only; surfacing IMAP expunges is a follow-up.
        deletions: [],
        nextCursor: JSON.stringify(nextCursor),
        hasMore,
      };
    } finally {
      // Always release the socket, even on a fetch error mid-sync.
      try {
        await client.logout();
      } catch {
        // Best-effort close — the orchestrator already owns the sync outcome.
      }
    }
  }

  /**
   * Best-effort credential check for the connect form: connect + log out, returning
   * a clear ok/error. The credentials route calls this before marking IMAP connected.
   */
  async testConnection(
    authConfig: Record<string, string>,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!authConfig.host || !authConfig.username || !authConfig.password) {
      return { ok: false, error: "Host, email address, and password are required." };
    }
    const client = this.clientFactory(authConfig);
    try {
      await client.connect();
      await client.logout();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

/** The shared IMAP connector instance (stateless — safe to reuse). */
export const imapConnector = new ImapConnector();

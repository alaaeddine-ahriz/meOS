/**
 * Source-level visibility (privacy) model.
 *
 * Every source carries six surface permissions that decide where its derived
 * content may appear. They are the source-level counterpart to an observation's
 * `sensitivity` tier: sensitivity scopes a single claim, visibility scopes a
 * whole document/connector across the surfaces that expose source-derived info.
 *
 *   searchable       — eligible as a retrieval candidate at all (chat context)
 *   answerable       — may back a chat answer's citations
 *   wiki_eligible    — its observations may feed a generated wiki page
 *   syncable         — its derived content may be git-synced to a remote
 *   exportable       — its derived content may appear in exports/digests
 *   activity_visible — it may surface in the Activity / recent-sources feed
 *
 * Defaults are applied at source creation by type (see DEFAULTS below). They can
 * later be overridden per source, but the per-type defaults encode the privacy
 * stance: connector data (Google calendar/gmail/tasks, IMAP) is private by default
 * — searchable, answerable, and wiki-eligible for the *local* wiki, but never
 * pushed to a remote or an export; directory/identity connectors (contacts) and
 * profile context additionally stay out of the wiki; everything else (local files,
 * uploads, vault notes, conversations, sessions) is fully permissive.
 */
export interface SourceVisibility {
  searchable: boolean;
  answerable: boolean;
  wikiEligible: boolean;
  syncable: boolean;
  exportable: boolean;
  activityVisible: boolean;
}

const ALL_TRUE: SourceVisibility = {
  searchable: true,
  answerable: true,
  wikiEligible: true,
  syncable: true,
  exportable: true,
  activityVisible: true,
};

/**
 * Built-in connector source types that stay off portable, remote-pushed artifacts.
 * This is a BOOTSTRAP seed only: every connector additionally injects its own
 * private source types via {@link registerPrivateSourceTypes} when the registry
 * registers it (see `connectors/registry.ts`), so a NEW connector gets the right
 * privacy defaults from its manifest — no edit to this file.
 */
export const CONNECTOR_SOURCE_TYPES = [
  "google:contacts",
  "google:calendar",
  "google:gmail",
  "google:tasks",
] as const;

/** The live set of private-by-default source types: the seed + connector-registered. */
const privateSourceTypes = new Set<string>(CONNECTOR_SOURCE_TYPES);

/**
 * Register source types that should be private by default. Called by the connector
 * registry as connectors register, so the visibility defaults track the registry
 * instead of a hardcoded list that drifts as connectors are added.
 */
export function registerPrivateSourceTypes(types: Iterable<string>): void {
  for (const t of types) privateSourceTypes.add(t);
}

/** Whether a source `type` is private by default (connector data, profile context). */
export function isConnectorSourceType(type: string): boolean {
  return privateSourceTypes.has(type);
}

/**
 * Built-in directory/identity source types: connector kinds that only record that
 * an entity *exists* (an address book), as opposed to content that *names* entities
 * in context (a calendar event, an email, a task, a note). Directory sources never
 * warrant a standalone wiki page on their own — a contact known to nothing else
 * stays searchable but pageless until some content source mentions it, at which
 * point it earns a page (and the directory link surfaces as a service chip).
 *
 * Like {@link CONNECTOR_SOURCE_TYPES} this is a BOOTSTRAP seed: connectors inject
 * their own directory kinds via {@link registerDirectorySourceTypes} at registry
 * time (a kind opts in with `directory: true` in its manifest), so a new directory
 * connector gets the right wiki defaults from its manifest — no edit to this file.
 */
export const DIRECTORY_SOURCE_TYPES = ["google:contacts"] as const;

/** The live set of directory/identity source types: the seed + connector-registered. */
const directorySourceTypes = new Set<string>(DIRECTORY_SOURCE_TYPES);

/**
 * Register source types that are directory/identity-only (an address book): their
 * facts keep an entity searchable but never, by themselves, warrant a wiki page.
 * Called by the connector registry as connectors register, so the wiki default
 * tracks the registry instead of a hardcoded list.
 */
export function registerDirectorySourceTypes(types: Iterable<string>): void {
  for (const t of types) directorySourceTypes.add(t);
}

/** Whether a source `type` is directory/identity-only (contacts-like). */
export function isDirectorySourceType(type: string): boolean {
  return directorySourceTypes.has(type);
}

/** The profile-context source type (kept in sync with the server's profile route). */
export const PROFILE_SOURCE_TYPE = "profile_context";

/**
 * The meeting-note source type (#26). A meeting note is a first-class, trusted
 * source the user captures by hand: searchable, answerable, and wiki-eligible,
 * and — like local files and pasted notes — fully permissive for sync/export.
 */
export const MEETING_SOURCE_TYPE = "meeting";

/**
 * The visibility a newly created source of `type` should get. Coherent defaults
 * per source type (DOCUMENTED here and mirrored in migration 18's backfill so
 * existing rows match new ones):
 *
 *   type                                  search answer wiki sync export activity
 *   file / watch / upload / image / text    ✓      ✓     ✓    ✓     ✓      ✓
 *   conversation / session / vault          ✓      ✓     ✓    ✓     ✓      ✓
 *   meeting                                 ✓      ✓     ✓    ✓     ✓      ✓
 *   google:calendar|gmail|tasks, imap       ✓      ✓     ✓    ✗     ✗      ✓
 *   google:contacts (directory)             ✓      ✓     ✗    ✗     ✗      ✓
 *   profile_context                         ✓      ✓     ✗    ✗     ✗      ✓
 */
export function defaultVisibilityForType(type: string): SourceVisibility {
  if (privateSourceTypes.has(type)) {
    // Connector data stays on-device — never pushed to a remote or an export
    // (sync/export off). It DOES feed the *local* wiki, though: a calendar event,
    // an email, or a task that names an entity is content about that entity, so it
    // earns a page (any source that names it). The exception is directory/identity
    // kinds (contacts): an address-book entry only records that a person exists, so
    // it stays searchable but pageless until some content source mentions them.
    return {
      ...ALL_TRUE,
      wikiEligible: !directorySourceTypes.has(type),
      syncable: false,
      exportable: false,
    };
  }
  if (type === PROFILE_SOURCE_TYPE) {
    // Profile docs: feed retrieval, but not the wiki and not sync/export.
    return { ...ALL_TRUE, wikiEligible: false, syncable: false, exportable: false };
  }
  // Local files, uploads, vault notes, pasted text, conversations, sessions, and
  // meeting notes (#26 — trusted sources): fully permissive, exactly as before
  // the visibility model existed.
  return { ...ALL_TRUE };
}

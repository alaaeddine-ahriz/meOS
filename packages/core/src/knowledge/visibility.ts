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
 * stance: connector data (Google contacts/calendar/gmail) is private by default
 * — searchable and answerable, but never pushed to a remote or an export; profile
 * context is searchable/answerable but kept out of the wiki and out of sync/export;
 * everything else (local files, uploads, vault notes, conversations, sessions) is
 * fully permissive.
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

/** Connector source types whose data stays off portable, remote-pushed artifacts. */
export const CONNECTOR_SOURCE_TYPES = [
  "google:contacts",
  "google:calendar",
  "google:gmail",
] as const;

/** The profile-context source type (kept in sync with the server's profile route). */
export const PROFILE_SOURCE_TYPE = "profile_context";

/**
 * The visibility a newly created source of `type` should get. Coherent defaults
 * per source type (DOCUMENTED here and mirrored in migration 18's backfill so
 * existing rows match new ones):
 *
 *   type                                  search answer wiki sync export activity
 *   file / watch / upload / image / text    ✓      ✓     ✓    ✓     ✓      ✓
 *   conversation / session / vault          ✓      ✓     ✓    ✓     ✓      ✓
 *   google:contacts|calendar|gmail          ✓      ✓     ✓    ✗     ✗      ✓
 *   profile_context                         ✓      ✓     ✗    ✗     ✗      ✓
 */
export function defaultVisibilityForType(type: string): SourceVisibility {
  if ((CONNECTOR_SOURCE_TYPES as readonly string[]).includes(type)) {
    // Connector data: searchable + answerable, but private — no sync/export.
    return { ...ALL_TRUE, syncable: false, exportable: false };
  }
  if (type === PROFILE_SOURCE_TYPE) {
    // Profile docs: feed retrieval, but not the wiki and not sync/export.
    return { ...ALL_TRUE, wikiEligible: false, syncable: false, exportable: false };
  }
  // Local files, uploads, vault notes, pasted text, conversations, sessions:
  // fully permissive, exactly as before the visibility model existed.
  return { ...ALL_TRUE };
}

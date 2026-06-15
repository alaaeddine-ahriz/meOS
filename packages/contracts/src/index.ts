/**
 * @meos/contracts — the shared, runtime-agnostic API contract for meOS.
 *
 * Zod schemas + their inferred TypeScript types for every public HTTP endpoint
 * the server exposes. The server (`@meos/server`) imports the schemas to
 * validate requests and shape responses; the web client (`@meos/web`) imports
 * the inferred TYPES (via `z.infer`) so the two cannot silently drift on shape.
 *
 * This package depends only on `zod`, keeping the dependency graph acyclic:
 * `web → @meos/contracts` (types) and `server → @meos/contracts` (schemas).
 */
export * from "./error.js";

// Shared primitives.
export * from "./schemas/common.js";

// Route-grouped schemas, re-exported under a namespace per module so callers can
// write `wiki.WikiPageResponse`, and the most commonly shared types are also
// re-exported directly below for ergonomic `z.infer` consumption in the client.
export * as ingest from "./schemas/ingest.js";
export * as wiki from "./schemas/wiki.js";
export * as vault from "./schemas/vault.js";
export * as chat from "./schemas/chat.js";
export * as activity from "./schemas/activity.js";
export * as digest from "./schemas/digest.js";
export * as outputs from "./schemas/outputs.js";
export * as profile from "./schemas/profile.js";
export * as settings from "./schemas/settings.js";
export * as connectors from "./schemas/connectors.js";
export * as git from "./schemas/git.js";

// --- Directly re-exported inferred TYPES, for the web client signatures. ---
export type {
  EntitySummary,
  SourceRef,
  GraphNode,
  GraphLink,
} from "./schemas/common.js";
export type { InboxItem, SourceDiff, DiffFile } from "./schemas/ingest.js";
export type { WikiPage, WikiGraph, DuplicateProposal } from "./schemas/wiki.js";
export type { NoteMeta, NoteContents } from "./schemas/vault.js";
export type { Conversation, Message, ChatEvent, LlmErrorKind } from "./schemas/chat.js";
export type { WikiRun, WikiRunEvent, WikiRunEventKind, ActivityEvent } from "./schemas/activity.js";
export type {
  ResolutionAction,
  Contradiction,
  ContradictionProposal,
  AuditEntry,
} from "./schemas/digest.js";
export type { OutputMode } from "./schemas/outputs.js";
export type {
  ProfileSectionView,
  ProfileData,
  ProfileProposal,
  ProfileVersion,
} from "./schemas/profile.js";
export type {
  LlmProvider,
  CloudProvider,
  LlmSettings,
  ModelListing,
  WatchedFolder,
} from "./schemas/settings.js";
export type {
  ConnectorKind,
  ConnectorKindStatus,
  ConnectorStatus,
} from "./schemas/connectors.js";
export type { GitStatus, GitCommit, GitCommitDetail } from "./schemas/git.js";

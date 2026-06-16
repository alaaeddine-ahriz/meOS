export { CONNECTOR_KINDS } from "./types.js";
export type {
  CalendarEventItem,
  CalendarListEntry,
  CalendarState,
  ConnectorKind,
  ConnectorKindConfig,
  ContactItem,
  CoverageWindow,
  DeltaResult,
  EventAttendee,
  GmailBackfillState,
  GmailContentMode,
  GmailMessageItem,
  OAuthTokens,
  Provider,
  SelfIdentity,
} from "./types.js";
// The connector framework (#5): interface, manifest, normalized item, registry.
export type {
  AuthManifest,
  Connector,
  ConnectorManifest,
  ContentMode,
  KindManifest,
  NormalizedDelta,
  NormalizedItem,
  OAuthProvider,
  SyncContext,
} from "./framework.js";
export { kindManifest } from "./framework.js";
export { ConnectorRegistry, connectorRegistry } from "./registry.js";
export { GoogleConnector, GOOGLE_MANIFEST, googleConnector } from "./google/connector.js";
export {
  buildAuthUrl,
  createPkcePair,
  exchangeCode,
  GOOGLE_SCOPES,
  refreshAccessToken,
  revokeToken,
} from "./google/oauth.js";
export { fetchContactsDelta, fetchSelf } from "./google/people.js";
export { fetchCalendarDelta, fetchCalendarList } from "./google/calendar.js";
export { fetchGmailDelta, searchThreadsText } from "./google/gmail.js";
export { mapContact } from "./map/contacts.js";
export { mapCalendarEvent } from "./map/calendar.js";
export { mapGmailMessage } from "./map/gmail.js";
export { ensureAccessToken, syncConnector } from "./sync.js";
export type { SyncDeps, SyncResult } from "./sync.js";

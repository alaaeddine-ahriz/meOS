import type { Extraction } from "../../extract/schema.js";
import type { GmailMessageItem, SelfIdentity } from "../types.js";
import { mapEmailMessage } from "./email.js";

/**
 * Map a Gmail message to an extraction: a person entity per correspondent, a
 * dated `event` observation recording the exchange (metadata only — subject +
 * date, never the body), and a `knows` edge between you and them. The exchange
 * fact is `private` so it stays out of the git-synced wiki. A Gmail message is
 * already an `EmailMessageMeta`, so this defers to the shared email mapper.
 */
export function mapGmailMessage(item: GmailMessageItem, self: SelfIdentity): Extraction {
  return mapEmailMessage(item, self);
}

/**
 * The connector registry (#5): the single place the orchestrator and server look
 * up a {@link Connector} by provider id. Google is registered out of the box; a
 * new provider becomes available system-wide by adding one `register()` call (or
 * passing it into a fresh {@link ConnectorRegistry}) — `sync.ts`,
 * `connector-manager.ts`, and the routes are all driven through this lookup, so
 * none of them name a specific provider.
 */

import {
  registerDirectorySourceTypes,
  registerPrivateSourceTypes,
} from "../knowledge/visibility.js";
import type { Connector, KindManifest } from "./framework.js";
import { googleConnector } from "./google/connector.js";
import { imapConnector } from "./imap/connector.js";

export class ConnectorRegistry {
  private readonly byId = new Map<string, Connector>();

  constructor(connectors: Connector[] = []) {
    for (const c of connectors) this.register(c);
  }

  /** Register (or replace) a connector under its manifest id. */
  register(connector: Connector): void {
    this.byId.set(connector.manifest.id, connector);
    // Privacy + wiki defaults track the registry, straight from the manifest — no
    // edit to knowledge/visibility.ts. A kind is private (off-sync/export) unless
    // it opts out, and a kind is directory-only (off-wiki) when it opts in with
    // `directory: true` (an address book vs. content that names entities).
    registerPrivateSourceTypes(
      connector.manifest.kinds.filter((k) => k.private !== false).map((k) => k.sourceType),
    );
    registerDirectorySourceTypes(
      connector.manifest.kinds.filter((k) => k.directory === true).map((k) => k.sourceType),
    );
  }

  /** The connector for `provider`, or undefined if none is registered. */
  get(provider: string): Connector | undefined {
    return this.byId.get(provider);
  }

  /** The connector for `provider`, throwing if it isn't registered. */
  require(provider: string): Connector {
    const connector = this.get(provider);
    if (!connector) throw new Error(`No connector registered for provider: ${provider}`);
    return connector;
  }

  /** Every registered connector, for status/discovery surfaces. */
  list(): Connector[] {
    return [...this.byId.values()];
  }

  /** Every registered provider id, e.g. `["google"]`. */
  providerIds(): string[] {
    return [...this.byId.keys()];
  }

  /** Every kind manifest across all connectors, paired with its provider id. */
  allKinds(): Array<{ provider: string; kind: KindManifest }> {
    return this.list().flatMap((c) =>
      c.manifest.kinds.map((kind) => ({ provider: c.manifest.id, kind })),
    );
  }

  /** Every source type any registered connector emits, e.g. `"google:gmail"`. */
  sourceTypes(): string[] {
    return this.list().flatMap((c) => c.manifest.kinds.map((k) => k.sourceType));
  }

  /**
   * The source types whose data is private by default (kept off the wiki and off
   * portable artifacts). A kind is private unless its manifest sets `private: false`
   * — so `knowledge/visibility.ts` derives its defaults from the registry instead of
   * a hardcoded list that drifts as connectors are added.
   */
  privateSourceTypes(): string[] {
    return this.list().flatMap((c) =>
      c.manifest.kinds.filter((k) => k.private !== false).map((k) => k.sourceType),
    );
  }
}

/**
 * The default registry, pre-loaded with the built-in connectors. The server uses
 * this; tests build their own {@link ConnectorRegistry} to slot in a fake.
 */
export const connectorRegistry = new ConnectorRegistry([googleConnector, imapConnector]);

/**
 * The connector registry (#5): the single place the orchestrator and server look
 * up a {@link Connector} by provider id. Google is registered out of the box; a
 * new provider becomes available system-wide by adding one `register()` call (or
 * passing it into a fresh {@link ConnectorRegistry}) — `sync.ts`,
 * `connector-manager.ts`, and the routes are all driven through this lookup, so
 * none of them name a specific provider.
 */

import type { Connector } from "./framework.js";
import { googleConnector } from "./google/connector.js";

export class ConnectorRegistry {
  private readonly byId = new Map<string, Connector>();

  constructor(connectors: Connector[] = []) {
    for (const c of connectors) this.register(c);
  }

  /** Register (or replace) a connector under its manifest id. */
  register(connector: Connector): void {
    this.byId.set(connector.manifest.id, connector);
  }

  /** The connector for `provider`, or undefined if none is registered. */
  get(provider: string): Connector | undefined {
    return this.byId.get(provider);
  }

  /** The connector for `provider`, throwing if it isn't registered. */
  require(provider: string): Connector {
    const connector = this.byId.get(provider);
    if (!connector) throw new Error(`No connector registered for provider: ${provider}`);
    return connector;
  }

  /** Every registered connector, for status/discovery surfaces. */
  list(): Connector[] {
    return [...this.byId.values()];
  }
}

/**
 * The default registry, pre-loaded with the built-in connectors. The server uses
 * this; tests build their own {@link ConnectorRegistry} to slot in a fake.
 */
export const connectorRegistry = new ConnectorRegistry([googleConnector]);

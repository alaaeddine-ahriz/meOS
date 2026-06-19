import { useEffect, useMemo, useState } from "react";
import { brandLogo, type LogoComponent } from "@/components/brand-logos";
import { api, type CatalogConnector, type CatalogKind } from "../api.js";

/**
 * The server-driven connector catalog (`GET /api/connectors/catalog`) — the
 * single source of truth for which connectors exist, their kinds, display names,
 * logos, and capabilities. The web app renders every connector view from this
 * instead of hardcoding Google-specific maps, so a newly-registered connector
 * appears with no UI change.
 *
 * The catalog is stable for the life of the app (it changes only when the set of
 * registered connectors does), so it's fetched once and cached at module level;
 * every consumer shares the same promise.
 */

/** One resolved kind: its catalog metadata plus the connector that owns it. */
export interface ResolvedKind {
  connector: CatalogConnector;
  kind: CatalogKind;
  /** The kind's global index in catalog order — a stable sort key for chips/cards. */
  order: number;
}

/** A source-type's display brand: a label, a logo component, and a sort order. */
export interface SourceTypeBrand {
  label: string;
  Logo: LogoComponent;
  order: number;
}

let catalogPromise: Promise<CatalogConnector[]> | null = null;

/** Fetch (once) the catalog's connectors, caching the in-flight/resolved promise. */
function loadCatalog(): Promise<CatalogConnector[]> {
  catalogPromise ??= api
    .getConnectorCatalog()
    .then((c) => c.connectors)
    // A failed fetch resolves to an empty catalog so views degrade to their
    // graceful fallbacks instead of throwing; clear the cache so a later mount
    // can retry.
    .catch(() => {
      catalogPromise = null;
      return [] as CatalogConnector[];
    });
  return catalogPromise;
}

/** The shape returned by {@link useConnectorCatalog}. */
export interface ConnectorCatalogApi {
  /** Every connector in catalog order. Empty until the fetch resolves. */
  connectors: CatalogConnector[];
  /** Whether the initial catalog fetch has resolved. */
  loaded: boolean;
  /** The connector with this provider id, if any. */
  connector: (providerId: string) => CatalogConnector | undefined;
  /** The kind (and its owning connector) whose `sourceType` matches, if any. */
  kindOf: (sourceType: string) => ResolvedKind | undefined;
  /**
   * The display brand for a source type (e.g. "google:gmail"): a full label
   * (the kind's display name, or "<Connector> <Kind>" where that reads more
   * naturally), a logo component, and a global sort order. Unknown types fall
   * back to the raw type, the generic logo, and a large order.
   */
  brandForSourceType: (sourceType: string) => SourceTypeBrand;
}

/**
 * Load the connector catalog and return lookup helpers. Replaces the old
 * hardcoded SERVICE_BRANDS / SERVICE_ORDER / KIND_META / KIND_ORDER /
 * CONNECTOR_ICONS maps that drifted from the connector registry.
 */
export function useConnectorCatalog(): ConnectorCatalogApi {
  const [connectors, setConnectors] = useState<CatalogConnector[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    loadCatalog().then((list) => {
      if (!active) return;
      setConnectors(list);
      setLoaded(true);
    });
    return () => {
      active = false;
    };
  }, []);

  return useMemo<ConnectorCatalogApi>(() => {
    // Index every kind by its source type, remembering global catalog order so a
    // chip/card sorts stably across connectors.
    const bySourceType = new Map<string, ResolvedKind>();
    let order = 0;
    for (const connector of connectors) {
      for (const kind of connector.kinds) {
        bySourceType.set(kind.sourceType, { connector, kind, order });
        order += 1;
      }
    }

    const connector = (providerId: string) => connectors.find((c) => c.id === providerId);

    const kindOf = (sourceType: string) => bySourceType.get(sourceType);

    const brandForSourceType = (sourceType: string): SourceTypeBrand => {
      const resolved = bySourceType.get(sourceType);
      if (!resolved) {
        return { label: sourceType, Logo: brandLogo(undefined), order: Number.MAX_SAFE_INTEGER };
      }
      const { connector: owner, kind } = resolved;
      // Prefer the kind's own display name; when it would read as a bare noun
      // (e.g. "Calendar"), prefix the connector so chips read "Google Calendar".
      const label = kind.displayName.includes(owner.displayName)
        ? kind.displayName
        : `${owner.displayName} ${kind.displayName}`;
      return { label, Logo: brandLogo(kind.logo), order: resolved.order };
    };

    return { connectors, loaded, connector, kindOf, brandForSourceType };
  }, [connectors, loaded]);
}

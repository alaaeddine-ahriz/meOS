#!/usr/bin/env node
/**
 * Scaffold a new connector: `pnpm connector:new <id>`.
 *
 * Creates packages/core/src/connectors/<id>/connector.ts from a skeleton, registers
 * it in registry.ts, and (when the marker is present) stubs a LOGO_REGISTRY entry in
 * the web brand-logos. After that, a new connector is: fill in the manifest +
 * fetchDelta (+ optional agentTools), and drop in your brand SVG. It then appears in
 * every view automatically. AST-free, idempotent-guarded text edits.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const id = (process.argv[2] ?? "").trim();

if (!/^[a-z][a-z0-9-]*$/.test(id)) {
  console.error("Usage: pnpm connector:new <id>   (lowercase, e.g. notion, my-imap)");
  process.exit(1);
}

const pascal = id
  .split("-")
  .map((s) => s[0].toUpperCase() + s.slice(1))
  .join("");
const camel = pascal[0].toLowerCase() + pascal.slice(1);
const title = id
  .split("-")
  .map((s) => s[0].toUpperCase() + s.slice(1))
  .join(" ");
const className = `${pascal}Connector`;
const instance = `${camel}Connector`;
const manifestConst = `${id.replace(/-/g, "_").toUpperCase()}_MANIFEST`;

const connectorDir = join(root, "packages/core/src/connectors", id);
const connectorFile = join(connectorDir, "connector.ts");
if (existsSync(connectorFile)) {
  console.error(`✗ ${connectorFile} already exists — pick another id or edit it directly.`);
  process.exit(1);
}

const connectorSource = `/**
 * The ${title} connector. Fill in the manifest, fetchDelta, and (optionally)
 * agentTools — everything else (UI, catalog, privacy defaults, schedule) is derived
 * from the manifest. See ../README.md and ../google/connector.ts for a reference.
 */

import type { Extraction } from "../../extract/schema.js";
import type { OAuthTokens } from "../types.js";
import type {
  Connector,
  ConnectorManifest,
  NormalizedDelta,
  NormalizedItem,
  OAuthProvider,
  SyncContext,
} from "../framework.js";

export const ${manifestConst}: ConnectorManifest = {
  id: "${id}",
  displayName: "${title}",
  logo: "${id}", // add a "${id}" entry to LOGO_REGISTRY in web/src/components/brand-logos.tsx
  summary: "Index your ${title} data.",
  // OAuth2 today. For a credential-based service declare instead:
  //   auth: { kind: "basic", fields: [{ key: "host", label: "Host", type: "text", required: true }, ...] }
  // and remove the \`oauth\` member below.
  auth: { kind: "oauth2", scopes: ["read"] },
  kinds: [
    {
      kind: "items",
      displayName: "Items",
      sourceType: "${id}:items",
      contentMode: "document",
      defaultIntervalMinutes: 30,
      noun: { one: "item", many: "items" },
      blurb: "Your ${title} items.",
      // private defaults to true (off wiki + off sync/export). capabilities light up
      // settings controls: { coverageWindow, labelFilters, subResources, writeable }.
    },
  ],
};

const oauth: OAuthProvider = {
  scopes: ["read"],
  buildAuthUrl: () => {
    throw new Error("TODO: build the provider's consent URL");
  },
  exchangeCode: async (): Promise<OAuthTokens> => {
    throw new Error("TODO: exchange the auth code for tokens");
  },
  refreshAccessToken: async (): Promise<OAuthTokens> => {
    throw new Error("TODO: mint a fresh access token");
  },
  revokeToken: async () => {
    /* best-effort; must not throw */
  },
};

function normalizeRecord(record: { id: string; title: string; body: string }): NormalizedItem {
  const extraction: Extraction = { entities: [], relationships: [], observations: [] };
  return {
    externalId: record.id,
    title: record.title,
    path: \`https://${id}.example.com/\${record.id}\`,
    rawContent: JSON.stringify(record, null, 2),
    normalizedContent: \`\${record.title}\\n\${record.body}\`,
    extraction,
  };
}

export class ${className} implements Connector {
  readonly manifest = ${manifestConst};
  readonly oauth = oauth;

  // Optional: add agentTools(ctx) + promptHint for chat-agent tools — see
  // template.connector.ts / google/connector.ts for a worked example.

  async fetchDelta(
    _ctx: SyncContext,
    _kind: string,
    _cursor: string | null,
  ): Promise<NormalizedDelta> {
    const changed: Array<{ id: string; title: string; body: string }> = [];
    return { items: changed.map(normalizeRecord), deletions: [], nextCursor: null };
  }
}

/** The shared ${title} connector instance (stateless — safe to reuse). */
export const ${instance} = new ${className}();
`;

mkdirSync(connectorDir, { recursive: true });
writeFileSync(connectorFile, connectorSource);
console.log(`✓ created packages/core/src/connectors/${id}/connector.ts`);

// --- Register it in the default registry ---
const registryPath = join(root, "packages/core/src/connectors/registry.ts");
let registry = readFileSync(registryPath, "utf8");
if (!registry.includes(`./${id}/connector.js`)) {
  registry = registry.replace(
    'import { googleConnector } from "./google/connector.js";',
    `import { googleConnector } from "./google/connector.js";\nimport { ${instance} } from "./${id}/connector.js";`,
  );
  registry = registry.replace(
    /new ConnectorRegistry\(\[([^\]]*)\]\)/,
    (_m, inner) => `new ConnectorRegistry([${inner.trim().replace(/,\s*$/, "")}, ${instance}])`,
  );
  writeFileSync(registryPath, registry);
  console.log(`✓ registered ${instance} in connectors/registry.ts`);
} else {
  console.log(`• ${instance} already imported in registry.ts — skipped`);
}

// --- Stub a LOGO_REGISTRY entry (best-effort; the SVG is yours to replace) ---
const brandPath = join(root, "packages/web/src/components/brand-logos.tsx");
if (existsSync(brandPath)) {
  let brand = readFileSync(brandPath, "utf8");
  const marker = "export const LOGO_REGISTRY";
  if (brand.includes(marker) && !brand.includes(`"${id}":`) && !brand.includes(`${id}:`)) {
    // Insert a placeholder logo component + a registry entry after the opening brace.
    const compName = `${pascal}Logo`;
    const placeholder = `\n/** ${title} — placeholder logo; replace with the real brand SVG. */\nexport function ${compName}({ className }: { className?: string }) {\n  return (\n    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">\n      <rect x="3" y="3" width="18" height="18" rx="4" />\n    </svg>\n  );\n}\n`;
    brand = brand.replace(marker, `${placeholder}\n${marker}`);
    brand = brand.replace(/(export const LOGO_REGISTRY[^{]*\{)/, `$1\n  "${id}": ${compName},`);
    writeFileSync(brandPath, brand);
    console.log(`✓ stubbed "${id}" in web LOGO_REGISTRY (replace the SVG in ${compName})`);
  } else {
    console.log(`• LOGO_REGISTRY: add a "${id}" entry by hand in brand-logos.tsx`);
  }
}

console.log(`
Next:
  1. Implement fetchDelta + the OAuth (or basic) auth in connectors/${id}/connector.ts
  2. Replace the placeholder ${pascal}Logo SVG in brand-logos.tsx
  3. (optional) add agentTools(ctx) + promptHint for chat-agent tools
  4. pnpm --filter @meos/core build && pnpm --filter @meos/web typecheck
The connector now appears in Settings, Health, Sources, chips, and the agent.`);

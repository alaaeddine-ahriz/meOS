import { connectorRegistry, type ConnectorRegistry } from "./registry.js";

/**
 * Auto-identify which connectors a scheduled task's natural-language instruction
 * refers to (roadmap #7, the "workflow" Tasks UI). The user just describes what
 * the agent should do — "check my Gmail and Calendar…" — and the platform links
 * the connectors it will read from, so the agent's data sources are explicit and
 * editable rather than implied. This is deterministic phrase matching against the
 * connector registry (no model call, no cost, instant as the user types); the
 * registry stays the single source of truth, so a new connector becomes detectable
 * the moment it ships its manifest + an alias entry below.
 */

/** One connector/kind a task's instruction was found to reference. */
export interface DetectedConnectorLink {
  /** Provider id, matching a registered connector (e.g. "google"). */
  provider: string;
  /** Kind id within that connector (e.g. "gmail"). */
  kind: string;
  /** The distinct phrases in the text that triggered the match, for highlighting. */
  matches: string[];
}

/**
 * Curated, conservative trigger phrases per kind (keyed by `sourceType`). These
 * supplement — and override — the kind's display name and nouns, which are matched
 * automatically. Generic single words that collide with ordinary task language
 * (e.g. a bare "task") are deliberately excluded so "summarise this task" doesn't
 * link Google Tasks; a kind with no entry here falls back to its display name +
 * nouns alone, so new connectors are still detectable from their manifest.
 */
const KIND_ALIASES: Record<string, readonly string[]> = {
  "google:gmail": ["gmail", "email", "emails", "e-mail", "e-mails", "inbox", "mailbox", "mail"],
  "google:calendar": [
    "calendar",
    "calendars",
    "event",
    "events",
    "meeting",
    "meetings",
    "schedule",
    "agenda",
  ],
  "google:contacts": ["contact", "contacts", "address book", "people"],
  "google:tasks": ["google tasks", "to-do", "to-dos", "todo", "todos", "task list", "task lists"],
  "imap:messages": ["imap", "email", "emails", "e-mail", "inbox", "mailbox", "mail"],
};

/** Words too generic to ever trigger a link on their own (noise filter). */
const STOPWORDS = new Set(["task", "tasks"]);

/** Escape a phrase for safe interpolation into a RegExp source. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The full set of trigger phrases for a kind: display name + nouns + curated aliases. */
function phrasesForKind(
  sourceType: string,
  displayName: string,
  noun: { one: string; many: string } | undefined,
): string[] {
  const fromManifest = [displayName, noun?.one, noun?.many].filter(
    (p): p is string => typeof p === "string" && p.trim().length > 0,
  );
  const aliases = KIND_ALIASES[sourceType] ?? [];
  const all = [...fromManifest, ...aliases].map((p) => p.trim().toLowerCase());
  // Dedupe and drop pure stopwords so a generic noun can't link a kind alone.
  return [...new Set(all)].filter((p) => !STOPWORDS.has(p));
}

/**
 * Detect the connectors referenced in `text`, in registry order. Matching is
 * case-insensitive and whole-word (so "mail" never fires inside "email", and
 * "Tasks" the heading never links Google Tasks). Returns one entry per matched
 * kind with the literal phrases that triggered it.
 */
export function detectConnectorLinks(
  text: string,
  registry: ConnectorRegistry = connectorRegistry,
): DetectedConnectorLink[] {
  const haystack = text ?? "";
  if (!haystack.trim()) return [];
  const links: DetectedConnectorLink[] = [];
  for (const { provider, kind } of registry.allKinds()) {
    const phrases = phrasesForKind(kind.sourceType, kind.displayName, kind.noun);
    if (phrases.length === 0) continue;
    const seen = new Map<string, string>(); // lowercased → original-cased sample
    for (const phrase of phrases) {
      const re = new RegExp(`\\b${escapeRegExp(phrase)}\\b`, "gi");
      for (const m of haystack.matchAll(re)) {
        const sample = m[0];
        const key = sample.toLowerCase();
        if (!seen.has(key)) seen.set(key, sample);
      }
    }
    if (seen.size > 0) {
      links.push({ provider, kind: kind.kind, matches: [...seen.values()] });
    }
  }
  return links;
}

/** Display info for a connector link, resolved from the registry. */
export interface ConnectorLinkLabel {
  provider: string;
  kind: string;
  /** Kind display name, e.g. "Gmail". */
  label: string;
  /** Owning connector's display name, e.g. "Google". */
  connector: string;
}

/**
 * Resolve `{ provider, kind }` links to their human labels (kind display names),
 * dropping any that no longer match a registered connector. Used to name a task's
 * data sources in its run preamble and anywhere the registry, not the catalog, is
 * the nearest source of truth.
 */
export function connectorLinkLabels(
  links: readonly { provider: string; kind: string }[],
  registry: ConnectorRegistry = connectorRegistry,
): ConnectorLinkLabel[] {
  const out: ConnectorLinkLabel[] = [];
  for (const link of links) {
    const connector = registry.get(link.provider);
    const kind = connector?.manifest.kinds.find((k) => k.kind === link.kind);
    if (!connector || !kind) continue;
    out.push({
      provider: link.provider,
      kind: link.kind,
      label: kind.displayName,
      connector: connector.manifest.displayName,
    });
  }
  return out;
}

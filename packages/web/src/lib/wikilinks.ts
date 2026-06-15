import type { EntitySummary } from "../api.js";

/**
 * Rewrites [[Entity Name]] wiki links into markdown links to internal routes
 * using the entity index; unresolved links degrade to plain text.
 */
export function resolveWikiLinks(text: string, entities: EntitySummary[]): string {
  const slugByName = new Map(entities.map((e) => [e.name.toLowerCase(), e.slug]));
  return text.replace(/\[\[([^\]]+)\]\]/g, (_match, name: string) => {
    const slug = slugByName.get(name.trim().toLowerCase());
    return slug ? `[${name}](/wiki/${slug})` : name;
  });
}

/** "/wiki/orion" -> "orion" — the inverse of the links resolveWikiLinks emits. */
export function wikiSlugFromHref(href: string): string {
  return href.replace(/^\/wiki\//, "");
}

/** Plain-text rendering of [[wiki-link]] markup, for one-line summaries. */
export function stripWikiMarkup(text: string): string {
  return text.replace(/\[\[([^\]]+)\]\]/g, "$1");
}

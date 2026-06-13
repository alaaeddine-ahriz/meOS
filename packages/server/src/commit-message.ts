import type { KnowledgeStore, WikiChange } from "@meos/core";

const pages = (n: number): string => `${n} page${n === 1 ? "" : "s"}`;

/**
 * Build a comprehensive commit message for a wiki regeneration pass: a subject
 * naming the document(s) and a count of pages created/updated, and a body
 * listing the entities and source documents involved.
 *
 * `label` overrides the document-derived subject (used by the nightly
 * consolidation, whose changes carry no source attribution).
 */
export function buildCommitMessage(
  changes: WikiChange[],
  store: KnowledgeStore,
  label?: string,
): { subject: string; message: string } {
  const created = changes.filter((c) => c.kind === "created");
  const updated = changes.filter((c) => c.kind === "updated");

  const parts: string[] = [];
  if (created.length) parts.push(`${pages(created.length)} created`);
  if (updated.length) parts.push(`${updated.length} updated`);
  // A consolidation pass may change no pages yet still write the daily digest.
  const summary = parts.join(", ") || (label ? "digest updated" : "no changes");

  const sourceIds = [...new Set(changes.flatMap((c) => c.sourceIds))];
  const sourceTitles = sourceIds
    .map((id) => store.getSourceTitle(id))
    .filter((title): title is string => Boolean(title));

  let subject: string;
  if (label) {
    subject = `${label} — ${summary}`;
  } else if (sourceTitles.length === 1) {
    subject = `Ingest "${sourceTitles[0]}" — ${summary}`;
  } else if (sourceTitles.length > 1) {
    subject = `Processed ${sourceTitles.length} documents — ${summary}`;
  } else {
    subject = `Update wiki — ${summary}`;
  }

  const lines: string[] = [subject, ""];
  const list = (heading: string, items: WikiChange[]) => {
    if (!items.length) return;
    lines.push(`${heading}:`);
    for (const c of items) lines.push(`- ${c.name} (${c.type})`);
    lines.push("");
  };
  list("Created", created);
  list("Updated", updated);
  if (sourceTitles.length) {
    lines.push("Sources:");
    for (const title of sourceTitles) lines.push(`- ${title}`);
  }

  return { subject, message: lines.join("\n").trimEnd() };
}

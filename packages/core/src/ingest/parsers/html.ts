import type { Block, BlockType } from "../parse.js";
import { BlockBuilder } from "./builder.js";

/**
 * Parse HTML (.html/.htm) into structured blocks, recovering the heading
 * hierarchy (h1..h6 → headingPath). We walk the DOM and emit one block per
 * block-level element (heading/paragraph/list/table/code/blockquote), skipping
 * script/style/nav chrome. Inline whitespace is collapsed so spans stay stable.
 * Deterministic: a pure function of the markup, document-order traversal.
 */
export async function parseHtml(html: string): Promise<{ text: string; blocks: Block[] }> {
  const { parse } = await import("node-html-parser");
  const root = parse(html, {
    comment: false,
    blockTextElements: { script: false, style: false, pre: true, code: true },
  });

  const builder = new BlockBuilder();
  const headingStack: Array<{ level: number; title: string }> = [];

  // Container tags we descend into rather than emit; their block-level children
  // become the actual blocks.
  const CONTAINERS = new Set([
    "HTML",
    "BODY",
    "DIV",
    "SECTION",
    "ARTICLE",
    "MAIN",
    "HEADER",
    "FOOTER",
    "ASIDE",
    "FIGURE",
    "FORM",
    "SPAN",
  ]);
  const SKIP = new Set(["SCRIPT", "STYLE", "NAV", "NOSCRIPT", "SVG", "HEAD", "TEMPLATE"]);

  const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
  // For list/table blocks we build with intentional "\n" separators between
  // items/rows; collapse each line's inline whitespace but keep the newlines.
  const collapseLines = (s: string) =>
    s
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n");

  interface ElementLike {
    nodeType: number;
    tagName?: string;
    text: string;
    childNodes: ElementLike[];
  }

  const emit = (type: BlockType, text: string, extra?: Record<string, unknown>) => {
    const clean =
      type === "list" || type === "table" || type === "code" ? collapseLines(text) : collapse(text);
    if (!clean) return;
    const headingPath = headingStack.map((h) => h.title);
    if (type === "heading") {
      const level = (extra?.level as number) ?? 1;
      while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= level) {
        headingStack.pop();
      }
      builder.push({ type, text: clean, headingPath, meta: { level } });
      headingStack.push({ level, title: clean });
      return;
    }
    builder.push({ type, text: clean, headingPath, ...(extra ? { meta: extra } : {}) });
  };

  const walk = (node: ElementLike) => {
    if (node.nodeType !== 1 || !node.tagName) return;
    const tag = node.tagName.toUpperCase();
    if (SKIP.has(tag)) return;

    if (/^H[1-6]$/.test(tag)) {
      emit("heading", node.text, { level: Number(tag[1]) });
      return;
    }
    switch (tag) {
      case "P":
      case "BLOCKQUOTE":
        emit("paragraph", node.text);
        return;
      case "UL":
      case "OL": {
        // Render list items on their own lines so structure survives.
        const items = (node.childNodes ?? [])
          .filter((c) => c.nodeType === 1 && c.tagName?.toUpperCase() === "LI")
          .map((li) => collapse(li.text))
          .filter(Boolean);
        emit("list", items.join("\n"));
        return;
      }
      case "TABLE": {
        const rows = (node.childNodes ?? [])
          .flatMap((c) => flattenRows(c))
          .map((r) => collapse(r))
          .filter(Boolean);
        emit("table", rows.join("\n"));
        return;
      }
      case "PRE":
      case "CODE":
        emit("code", node.text);
        return;
      default:
        if (CONTAINERS.has(tag)) {
          for (const child of node.childNodes ?? []) walk(child);
        } else {
          // Unknown block: keep its text rather than drop content.
          emit("paragraph", node.text);
        }
    }
  };

  const flattenRows = (node: ElementLike): string[] => {
    if (node.nodeType !== 1 || !node.tagName) return [];
    const tag = node.tagName.toUpperCase();
    if (tag === "TR") {
      const cells = (node.childNodes ?? [])
        .filter((c) => c.nodeType === 1 && /^T[HD]$/.test(c.tagName?.toUpperCase() ?? ""))
        .map((c) => collapse(c.text));
      return [cells.join(" | ")];
    }
    return (node.childNodes ?? []).flatMap((c) => flattenRows(c));
  };

  const body = (root.querySelector("body") ?? root) as unknown as ElementLike;
  for (const child of body.childNodes ?? []) walk(child);

  return builder.result();
}

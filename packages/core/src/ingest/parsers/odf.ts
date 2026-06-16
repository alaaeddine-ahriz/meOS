import type { Block, BlockType } from "../parse.js";
import { BlockBuilder } from "./builder.js";
import {
  childrenOf,
  collectText,
  makeXmlParser,
  readZipEntry,
  tagOf,
  type XmlNode,
} from "./xml.js";

/**
 * Parse an ODF text document (.odt) — a ZIP whose `content.xml` holds the body.
 * We walk `office:text`, mapping `text:h` → heading (with `text:outline-level`),
 * `text:p` → paragraph, `text:list` → list. Heading hierarchy is recovered from
 * the outline level. Deterministic: a pure function of the document-order XML.
 */
export async function parseOdt(buffer: Buffer): Promise<{ text: string; blocks: Block[] }> {
  const content = await readZipEntry(buffer, "content.xml");
  if (!content) return { text: "", blocks: [] };

  const parser = await makeXmlParser();
  const tree = parser.parse(content) as XmlNode[];

  const builder = new BlockBuilder();
  const headingStack: Array<{ level: number; title: string }> = [];

  const collapse = (s: string) =>
    s
      .replace(/[^\S\n]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim();

  const emitHeading = (text: string, level: number) => {
    const clean = collapse(text);
    if (!clean) return;
    while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= level) {
      headingStack.pop();
    }
    builder.push({
      type: "heading",
      text: clean,
      headingPath: headingStack.map((h) => h.title),
      meta: { level },
    });
    headingStack.push({ level, title: clean });
  };

  const emit = (type: BlockType, text: string) => {
    const clean = collapse(text);
    if (!clean) return;
    builder.push({ type, text: clean, headingPath: headingStack.map((h) => h.title) });
  };

  const walk = (node: XmlNode) => {
    const tag = tagOf(node);
    if (!tag || tag === "#text") return;
    const local = tag.includes(":") ? tag.split(":")[1]! : tag;

    switch (local) {
      case "h": {
        const levelAttr = node[":@"]?.["@_text:outline-level"];
        const level = Math.min(6, Math.max(1, Number(levelAttr) || 1));
        emitHeading(collectText(node), level);
        return;
      }
      case "p":
        emit("paragraph", collectText(node));
        return;
      case "list":
        emit("list", collectListItems(node));
        return;
      case "table":
      case "table-row":
      case "table-cell":
        // Tables: flatten cell text per row.
        if (local === "table") {
          emit("table", collectTableText(node));
          return;
        }
        return;
      default:
        for (const child of childrenOf(node, tag)) walk(child);
    }
  };

  const collectListItems = (node: XmlNode): string => {
    const items: string[] = [];
    const tag = tagOf(node)!;
    for (const child of childrenOf(node, tag)) {
      const childTag = tagOf(child);
      const childLocal = childTag?.includes(":") ? childTag.split(":")[1] : childTag;
      if (childLocal === "list-item") {
        items.push(collapse(collectText(child)));
      }
    }
    return items.filter(Boolean).join("\n");
  };

  const collectTableText = (node: XmlNode): string => {
    const rows: string[] = [];
    const visit = (n: XmlNode) => {
      const tag = tagOf(n);
      if (!tag || tag === "#text") return;
      const local = tag.includes(":") ? tag.split(":")[1]! : tag;
      if (local === "table-row") {
        const cells: string[] = [];
        const collectCells = (rn: XmlNode) => {
          const rtag = tagOf(rn);
          if (!rtag || rtag === "#text") return;
          const rlocal = rtag.includes(":") ? rtag.split(":")[1]! : rtag;
          if (rlocal === "table-cell") {
            cells.push(collapse(collectText(rn)));
          } else {
            for (const c of childrenOf(rn, rtag)) collectCells(c);
          }
        };
        for (const c of childrenOf(n, tag)) collectCells(c);
        rows.push(cells.join(" | "));
      } else {
        for (const c of childrenOf(n, tag)) visit(c);
      }
    };
    visit(node);
    return rows.filter(Boolean).join("\n");
  };

  // Descend to office:body → office:text, then walk its children as blocks.
  const findAndWalkBody = (nodes: XmlNode[]) => {
    for (const node of nodes) {
      const tag = tagOf(node);
      if (!tag || tag === "#text") continue;
      const local = tag.includes(":") ? tag.split(":")[1]! : tag;
      if (local === "text" || local === "presentation" || local === "spreadsheet") {
        for (const child of childrenOf(node, tag)) walk(child);
      } else {
        findAndWalkBody(childrenOf(node, tag));
      }
    }
  };

  findAndWalkBody(tree);
  return builder.result();
}

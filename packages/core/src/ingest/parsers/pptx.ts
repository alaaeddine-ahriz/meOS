import type { Block } from "../parse.js";
import { BlockBuilder } from "./builder.js";
import {
  childrenOf,
  collectText,
  listZipEntries,
  makeXmlParser,
  tagOf,
  type XmlNode,
} from "./xml.js";

/**
 * Parse a PowerPoint deck (.pptx) — a ZIP of per-slide XML at
 * `ppt/slides/slideN.xml`. For each slide (in numeric order) we emit a heading
 * block (the slide title, or "Slide N") and a paragraph block per text
 * paragraph. `meta.slide` carries the 1-based slide number. Deterministic:
 * slides are sorted by their numeric index and runs are read in document order.
 */
export async function parsePptx(buffer: Buffer): Promise<{ text: string; blocks: Block[] }> {
  const slideEntries = await listZipEntries(buffer, (name) =>
    /^ppt\/slides\/slide\d+\.xml$/.test(name),
  );
  // Sort by the numeric slide index, not lexicographically (slide10 < slide2).
  slideEntries.sort((a, b) => slideNumber(a.name) - slideNumber(b.name));

  const parser = await makeXmlParser();
  const builder = new BlockBuilder();
  const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

  for (let s = 0; s < slideEntries.length; s++) {
    const slideNo = s + 1;
    const xml = await slideEntries[s]!.text();
    const tree = parser.parse(xml) as XmlNode[];

    // Each paragraph (a:p) becomes one text line.
    const paragraphs: string[] = [];
    const collectParagraphs = (node: XmlNode) => {
      const tag = tagOf(node);
      if (!tag || tag === "#text") return;
      const local = tag.includes(":") ? tag.split(":")[1]! : tag;
      if (local === "p") {
        const text = collapse(collectText(node));
        if (text) paragraphs.push(text);
        return;
      }
      for (const child of childrenOf(node, tag)) collectParagraphs(child);
    };
    for (const node of tree) collectParagraphs(node);

    // The first paragraph is the slide title; the rest are body text.
    const [firstPara, ...body] = paragraphs;
    const title = firstPara ?? `Slide ${slideNo}`;
    builder.push({
      type: "heading",
      text: title,
      headingPath: [],
      meta: { level: 1, slide: slideNo },
    });

    for (const para of body) {
      builder.push({
        type: "paragraph",
        text: para,
        headingPath: [title],
        meta: { slide: slideNo },
      });
    }
  }

  return builder.result();
}

function slideNumber(name: string): number {
  const m = /slide(\d+)\.xml$/.exec(name);
  return m ? Number(m[1]) : 0;
}

import type { Block } from "../parse.js";
import { blocksFromText } from "../parse.js";
import { BlockBuilder } from "./builder.js";

interface NotebookCell {
  cell_type?: string;
  source?: string | string[];
}

/**
 * Parse a Jupyter notebook (.ipynb, a JSON document) into blocks: markdown
 * cells become paragraph/heading blocks (via {@link blocksFromText} so their
 * own markdown headings are recovered) and code cells become code blocks with
 * `meta.cell` = index. Falls back to treating the file as text if it is not a
 * valid notebook. Deterministic: cells are emitted in array order.
 */
export function parseNotebook(raw: string): { text: string; blocks: Block[] } {
  let cells: NotebookCell[] = [];
  try {
    const doc: { cells?: NotebookCell[] } = JSON.parse(raw);
    if (Array.isArray(doc.cells)) cells = doc.cells;
  } catch {
    // not valid JSON; falls through to the text fallback below
  }
  if (cells.length === 0) {
    const text = raw.trim();
    return { text, blocks: blocksFromText(text) };
  }

  const builder = new BlockBuilder();
  cells.forEach((cell, i) => {
    const source = Array.isArray(cell.source) ? cell.source.join("") : (cell.source ?? "");
    const text = source.trim();
    if (!text) return;
    if (cell.cell_type === "code") {
      builder.push({ type: "code", text, headingPath: [], meta: { cell: i } });
    } else {
      // Markdown cell: recover its internal heading/paragraph/list structure,
      // re-homing each sub-block's text into the combined buffer.
      for (const sub of blocksFromText(text)) {
        builder.push({
          type: sub.type,
          text: sub.text,
          headingPath: sub.headingPath ?? [],
          meta: { ...sub.meta, cell: i },
        });
      }
    }
  });

  return builder.result();
}

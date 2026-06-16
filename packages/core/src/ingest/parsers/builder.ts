import type { Block } from "../parse.js";

/**
 * A tiny accumulator that builds a {@link ParsedDocument}'s `text` + `blocks`
 * together so char spans are always exact: every block's text is appended to a
 * "\n\n"-joined buffer, and the block records the offset it landed at. Used by
 * the binary/structured parsers (spreadsheet, pptx, html, rtf, odt, notebook)
 * to share one correct span-tracking implementation.
 */
export class BlockBuilder {
  private readonly blocks: Block[] = [];
  private readonly parts: string[] = [];
  private cursor = 0;

  /** Append a block; its id/charStart/charEnd are derived from position. */
  push(block: Omit<Block, "id" | "charStart" | "charEnd">): void {
    this.parts.push(block.text);
    this.blocks.push({
      id: `b${this.blocks.length}`,
      charStart: this.cursor,
      charEnd: this.cursor + block.text.length,
      ...block,
    });
    this.cursor += block.text.length + 2; // for the "\n\n" join
  }

  result(): { text: string; blocks: Block[] } {
    return { text: this.parts.join("\n\n"), blocks: this.blocks };
  }
}

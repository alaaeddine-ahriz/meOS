import type { Block } from "../parse.js";
import { blocksFromText } from "../parse.js";

/**
 * Convert RTF to plain text with a small, dependency-free, deterministic
 * stripper, then reuse {@link blocksFromText} for block structure. RTF is a
 * control-word format ("{\rtf1 ... \par ...}"): we drop control words, honor the
 * handful that map to whitespace/characters (\par, \line, \tab, \uN unicode,
 * \'hh hex), skip binary/picture groups, and emit the literal text. This is not
 * a full RTF reader, but it recovers the readable prose deterministically, which
 * is what ingestion needs.
 */
export function rtfToText(rtf: string): string {
  let out = "";
  let i = 0;
  const n = rtf.length;
  let depth = 0;
  // Groups we want to skip entirely (binary blobs, fonts, metadata).
  const skipGroupAt: number[] = [];
  let skipDepth = -1;

  const skipControls = new Set([
    "fonttbl",
    "colortbl",
    "stylesheet",
    "info",
    "pict",
    "object",
    "themedata",
    "colorschememapping",
    "datastore",
    "operator",
    "latentstyles",
  ]);

  while (i < n) {
    const ch = rtf[i]!;
    if (ch === "{") {
      depth++;
      skipGroupAt.push(skipDepth);
      i++;
      continue;
    }
    if (ch === "}") {
      if (skipDepth === depth) skipDepth = -1;
      depth--;
      skipGroupAt.pop();
      i++;
      continue;
    }
    if (ch === "\\") {
      const next = rtf[i + 1]!;
      // Escaped literal char: \\ \{ \}
      if (next === "\\" || next === "{" || next === "}") {
        if (skipDepth === -1) out += next;
        i += 2;
        continue;
      }
      // Hex escape \'hh
      if (next === "'") {
        const hex = rtf.slice(i + 2, i + 4);
        if (skipDepth === -1 && /^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
        }
        i += 4;
        continue;
      }
      // Control word: \word, optional numeric param, optional trailing space.
      const m = /^\\([a-zA-Z]+)(-?\d+)?\s?/.exec(rtf.slice(i));
      if (m) {
        const word = m[1]!;
        const param = m[2];
        if (skipDepth === -1) {
          if (skipControls.has(word)) {
            skipDepth = depth;
          } else if (word === "par" || word === "line" || word === "pard") {
            out += "\n";
          } else if (word === "tab") {
            out += "\t";
          } else if (word === "u" && param) {
            const code = parseInt(param, 10);
            if (code >= 0) out += String.fromCharCode(code);
            // \uN is followed by a fallback char we should drop.
            i += m[0].length;
            if (rtf[i] === "?") i++;
            continue;
          }
        }
        i += m[0].length;
        continue;
      }
      // Stray backslash.
      i++;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    if (skipDepth === -1) out += ch;
    i++;
  }

  // Collapse runs of blank lines into paragraph breaks; trim trailing space.
  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n/g, "\n")
    .trim();
}

export function parseRtf(rtf: string): { text: string; blocks: Block[] } {
  const text = rtfToText(rtf);
  return { text, blocks: blocksFromText(text) };
}

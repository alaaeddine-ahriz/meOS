import type { Block } from "../parse.js";
import { BlockBuilder } from "./builder.js";

/**
 * Parse a spreadsheet (.xlsx/.xls/.ods) into blocks: one heading block per
 * sheet (its name), then one table block for the column header and one block
 * per data row. Sheet name + row index land in `meta` so citations can point
 * at "Sheet 'Budget', row 12". The normalized `text` is the concatenation of
 * the block texts joined with "\n\n", so every block's char span slices back
 * out of `text` exactly. Deterministic: SheetJS iterates sheets and rows in
 * document order and we never depend on object-key ordering.
 */
export async function parseSpreadsheet(buffer: Buffer): Promise<{ text: string; blocks: Block[] }> {
  const XLSX = await import("xlsx");
  // cellDates keeps dates readable + stable; raw:false (per-sheet below) renders
  // formatted strings so output does not depend on the host locale's number
  // formatting of the raw values.
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });

  const builder = new BlockBuilder();
  // Coerce each cell to a string; defval:"" already filled short rows, but
  // guard null/undefined defensively (matches the original per-row mapping).
  const toStrings = (cells: string[]) => cells.map((c) => String(c ?? ""));

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    // header:1 → array-of-arrays in document order; defval:"" keeps columns
    // aligned across short rows; raw:false renders formatted text deterministically.
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, {
      header: 1,
      blankrows: false,
      defval: "",
      raw: false,
    });

    builder.push({
      type: "heading",
      text: sheetName,
      headingPath: [],
      meta: { level: 1, sheet: sheetName },
    });

    if (rows.length === 0) continue;

    const header = toStrings(rows[0] ?? []);
    const dataRows = rows.slice(1);

    builder.push({
      type: "table",
      text: `Table with columns: ${header.join(", ")}`,
      headingPath: [sheetName],
      meta: { sheet: sheetName, columns: header, rowCount: dataRows.length },
    });

    dataRows.forEach((cells, i) => {
      const cellStrs = toStrings(cells ?? []);
      // One pass builds both the human-readable row text and the structured record.
      const record: Record<string, string> = {};
      const rowText = header
        .map((col, c) => {
          const value = cellStrs[c] ?? "";
          record[col] = value;
          return `${col}: ${value}`;
        })
        .join("; ");
      builder.push({
        type: "table",
        text: rowText,
        headingPath: [sheetName],
        meta: { sheet: sheetName, columns: header, row: i, record },
      });
    });
  }

  return builder.result();
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Block, ParsedDocument } from "../src/ingest/parse.js";
import { parseDocument, SUPPORTED_EXTENSIONS } from "../src/ingest/parse.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "ingest");
const read = (name: string) => fs.readFileSync(path.join(fixtures, name));

/**
 * Every non-heading block's text must slice back out of the normalized text at
 * its recorded span. Heading blocks are exempt because the parsers strip
 * decoration (e.g. "# ", sheet/slide framing) from heading text.
 */
function assertSpans(doc: ParsedDocument): void {
  for (const b of doc.blocks ?? []) {
    if (b.type === "heading") continue;
    expect(doc.text.slice(b.charStart, b.charEnd)).toBe(b.text);
  }
}

/** ids are dense and document-ordered. */
function assertStableIds(blocks: Block[]): void {
  expect(blocks.map((b) => b.id)).toEqual(blocks.map((_, i) => `b${i}`));
}

describe("SUPPORTED_EXTENSIONS registry", () => {
  it("lists the new formats so watchers do not skip them", () => {
    for (const ext of [
      ".xlsx",
      ".xls",
      ".ods",
      ".pptx",
      ".eml",
      ".mbox",
      ".html",
      ".htm",
      ".rtf",
      ".odt",
      ".ipynb",
      ".sql",
      ".yaml",
    ]) {
      expect(SUPPORTED_EXTENSIONS.has(ext)).toBe(true);
    }
  });

  it("still returns null for genuinely unsupported types", async () => {
    expect(await parseDocument("a.xyz", Buffer.from("x"))).toBeNull();
  });
});

describe("spreadsheets (.xlsx / .ods)", () => {
  for (const file of ["sample.xlsx", "sample.ods"]) {
    it(`${file}: one heading per sheet, header + row table blocks with sheet/row meta`, async () => {
      const doc = (await parseDocument(file, read(file)))!;
      expect(doc).not.toBeNull();

      const headings = doc.blocks!.filter((b) => b.type === "heading");
      expect(headings.map((h) => h.text)).toEqual(["People", "Budget"]);
      expect(headings[0]!.meta).toMatchObject({ sheet: "People" });

      // First data row of People carries record + row index + sheet name.
      const adaRow = doc.blocks!.find(
        (b) =>
          typeof b.meta?.record === "object" &&
          (b.meta.record as Record<string, string>).name === "Ada",
      )!;
      expect(adaRow.meta).toMatchObject({ sheet: "People", row: 0 });
      expect(adaRow.meta!.record).toMatchObject({ name: "Ada", role: "Engineer" });

      assertSpans(doc);
      assertStableIds(doc.blocks!);
    });

    it(`${file}: is deterministic`, async () => {
      const a = await parseDocument(file, read(file));
      const b = await parseDocument(file, read(file));
      expect(a).toEqual(b);
    });
  }
});

describe("presentations (.pptx)", () => {
  it("emits a heading per slide and paragraph blocks with slide numbers", async () => {
    const doc = (await parseDocument("sample.pptx", read("sample.pptx")))!;
    const headings = doc.blocks!.filter((b) => b.type === "heading");
    expect(headings.map((h) => h.text)).toEqual(["Welcome", "Roadmap"]);
    expect(headings[0]!.meta).toMatchObject({ slide: 1 });
    expect(headings[1]!.meta).toMatchObject({ slide: 2 });

    const slide1Body = doc.blocks!.filter((b) => b.type === "paragraph" && b.meta?.slide === 1);
    expect(slide1Body.map((b) => b.text)).toEqual(["First bullet", "Second bullet"]);

    assertSpans(doc);
    assertStableIds(doc.blocks!);
  });

  it("is deterministic", async () => {
    expect(await parseDocument("sample.pptx", read("sample.pptx"))).toEqual(
      await parseDocument("sample.pptx", read("sample.pptx")),
    );
  });
});

describe("email (.eml / .mbox)", () => {
  it("eml: metadata heading + body paragraph blocks with email meta", async () => {
    const doc = (await parseDocument("sample.eml", read("sample.eml")))!;
    const heading = doc.blocks!.find((b) => b.type === "heading")!;
    expect(heading.text).toContain("Subject: Analytical Engine notes");
    expect(heading.text).toContain("From: ");
    expect(heading.meta).toMatchObject({
      email: {
        subject: "Analytical Engine notes",
        date: "2024-01-01T10:00:00.000Z",
      },
    });

    const paras = doc.blocks!.filter((b) => b.type === "paragraph");
    expect(paras.map((p) => p.text)).toEqual([
      "First paragraph about the Analytical Engine.",
      "Second paragraph with more detail.",
    ]);
    assertSpans(doc);
    assertStableIds(doc.blocks!);
  });

  it("mbox: splits into two messages with message indices", async () => {
    const doc = (await parseDocument("sample.mbox", read("sample.mbox")))!;
    const headings = doc.blocks!.filter((b) => b.type === "heading");
    expect(headings).toHaveLength(2);
    expect(headings[0]!.text).toContain("Subject: First message");
    expect(headings[1]!.text).toContain("Subject: Second message");
    expect(headings[0]!.meta).toMatchObject({ message: 0 });
    expect(headings[1]!.meta).toMatchObject({ message: 1 });
    assertSpans(doc);
  });

  it("is deterministic", async () => {
    expect(await parseDocument("sample.eml", read("sample.eml"))).toEqual(
      await parseDocument("sample.eml", read("sample.eml")),
    );
  });
});

describe("html (.html)", () => {
  it("recovers heading hierarchy, lists, tables; skips script/style/nav", async () => {
    const doc = (await parseDocument("sample.html", read("sample.html")))!;
    const types = doc.blocks!.map((b) => b.type);
    expect(types).toContain("heading");
    expect(types).toContain("list");
    expect(types).toContain("table");

    // Script/style/nav content is not present.
    expect(doc.text).not.toContain("ignore me");
    expect(doc.text).not.toContain("color: red");
    expect(doc.text).not.toContain("Home About Contact");

    // Subsection paragraph sits under [Main Heading, Subsection].
    const body = doc.blocks!.find((b) => b.text === "Body of the subsection.")!;
    expect(body.headingPath).toEqual(["Main Heading", "Subsection"]);

    const list = doc.blocks!.find((b) => b.type === "list")!;
    expect(list.text).toBe("first item\nsecond item");

    assertSpans(doc);
    assertStableIds(doc.blocks!);
  });

  it("is deterministic", async () => {
    expect(await parseDocument("sample.html", read("sample.html"))).toEqual(
      await parseDocument("sample.html", read("sample.html")),
    );
  });
});

describe("rtf (.rtf)", () => {
  it("strips control words to readable paragraphs", async () => {
    const doc = (await parseDocument("sample.rtf", read("sample.rtf")))!;
    expect(doc.text).toContain("First paragraph of the RTF document.");
    expect(doc.text).toContain("Second paragraph with a tab");
    expect(doc.text).not.toContain("\\rtf1");
    expect(doc.text).not.toContain("fonttbl");
    expect(doc.text).not.toContain("Times New Roman");
    assertSpans(doc);
  });

  it("is deterministic", async () => {
    expect(await parseDocument("sample.rtf", read("sample.rtf"))).toEqual(
      await parseDocument("sample.rtf", read("sample.rtf")),
    );
  });
});

describe("odt (.odt)", () => {
  it("recovers heading hierarchy from outline levels", async () => {
    const doc = (await parseDocument("sample.odt", read("sample.odt")))!;
    const headings = doc.blocks!.filter((b) => b.type === "heading");
    expect(headings.map((h) => h.text)).toEqual(["Project Plan", "Goals"]);
    expect(headings[1]!.meta).toMatchObject({ level: 2 });

    const goalsBody = doc.blocks!.find((b) => b.text === "Deliver the parsers.")!;
    expect(goalsBody.headingPath).toEqual(["Project Plan", "Goals"]);
    assertSpans(doc);
    assertStableIds(doc.blocks!);
  });

  it("is deterministic", async () => {
    expect(await parseDocument("sample.odt", read("sample.odt"))).toEqual(
      await parseDocument("sample.odt", read("sample.odt")),
    );
  });
});

describe("notebooks (.ipynb)", () => {
  it("maps markdown cells to text blocks and code cells to code blocks", async () => {
    const doc = (await parseDocument("sample.ipynb", read("sample.ipynb")))!;
    const code = doc.blocks!.filter((b) => b.type === "code");
    expect(code).toHaveLength(1);
    expect(code[0]!.text).toContain("import math");
    expect(code[0]!.meta).toMatchObject({ cell: 1 });

    const headings = doc.blocks!.filter((b) => b.type === "heading");
    expect(headings.map((h) => h.text)).toEqual(["Notebook Title", "Analysis"]);
    assertSpans(doc);
    assertStableIds(doc.blocks!);
  });

  it("is deterministic", async () => {
    expect(await parseDocument("sample.ipynb", read("sample.ipynb"))).toEqual(
      await parseDocument("sample.ipynb", read("sample.ipynb")),
    );
  });
});

describe("config/code text formats", () => {
  it("routes .sql and .yaml through the text/code path", async () => {
    const sql = (await parseDocument("schema.sql", Buffer.from("SELECT 1;\n\nSELECT 2;")))!;
    expect(sql.text).toContain("SELECT 1;");
    expect(sql.blocks!.length).toBeGreaterThan(0);

    const yaml = (await parseDocument("config.yaml", Buffer.from("key: value\nlist:\n  - a")))!;
    expect(yaml.text).toContain("key: value");
  });
});

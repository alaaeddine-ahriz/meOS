// Regenerates the binary ingest fixtures (xlsx, ods, pptx, odt) used by
// parse.test.ts. Deterministic; run with `node generate.mjs` from this dir.
// Kept in-tree so the fixtures are reproducible and reviewable.
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import XLSX from "xlsx";
import JSZip from "jszip";

const here = path.dirname(fileURLToPath(import.meta.url));
const write = (name, buf) => fs.writeFileSync(path.join(here, name), buf);

// --- Spreadsheets: same data as xlsx and ods ------------------------------
function spreadsheet(bookType) {
  const wb = XLSX.utils.book_new();
  const people = XLSX.utils.aoa_to_sheet([
    ["name", "role"],
    ["Ada", "Engineer"],
    ["Grace", "Admiral"],
  ]);
  XLSX.utils.book_append_sheet(wb, people, "People");
  const budget = XLSX.utils.aoa_to_sheet([
    ["item", "cost"],
    ["server", "100"],
  ]);
  XLSX.utils.book_append_sheet(wb, budget, "Budget");
  return XLSX.write(wb, { type: "buffer", bookType });
}
write("sample.xlsx", spreadsheet("xlsx"));
write("sample.ods", spreadsheet("ods"));

// --- PPTX: minimal 2-slide deck ------------------------------------------
function slideXml(title, body) {
  const para = (t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree>
<p:sp><p:txBody>${para(title)}${body.map(para).join("")}</p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`;
}
async function pptx() {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
</Types>`,
  );
  zip.file("ppt/slides/slide1.xml", slideXml("Welcome", ["First bullet", "Second bullet"]));
  zip.file("ppt/slides/slide2.xml", slideXml("Roadmap", ["Ship parsers"]));
  return zip.generateAsync({ type: "nodebuffer" });
}
write("sample.pptx", await pptx());

// --- ODT: minimal text document ------------------------------------------
async function odt() {
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
<office:body><office:text>
<text:h text:outline-level="1">Project Plan</text:h>
<text:p>Intro paragraph about the project.</text:p>
<text:h text:outline-level="2">Goals</text:h>
<text:p>Deliver the parsers.</text:p>
</office:text></office:body></office:document-content>`;
  const zip = new JSZip();
  zip.file("mimetype", "application/vnd.oasis.opendocument.text");
  zip.file("content.xml", content);
  return zip.generateAsync({ type: "nodebuffer" });
}
write("sample.odt", await odt());

console.log("fixtures regenerated");

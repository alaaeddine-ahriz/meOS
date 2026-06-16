/**
 * Shared helpers for the zip+XML office formats (ODT/ODS/ODP, PPTX). These are
 * all ZIP archives of XML parts; we read the relevant part(s) with JSZip and
 * walk the `preserveOrder` tree fast-xml-parser produces. Keeping the traversal
 * here means ODT/PPTX share one tested, deterministic implementation.
 */

/** A node in fast-xml-parser's preserveOrder output. */
export type XmlNode = Record<string, unknown> & { ":@"?: Record<string, unknown> };

export async function makeXmlParser() {
  const { XMLParser } = await import("fast-xml-parser");
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    preserveOrder: true,
    textNodeName: "#text",
    trimValues: false,
  });
}

/** The tag name of a preserveOrder node (the single non-":@" key). */
export function tagOf(node: XmlNode): string | undefined {
  for (const key of Object.keys(node)) {
    if (key !== ":@" && key !== "#text") return key;
  }
  if ("#text" in node) return "#text";
  return undefined;
}

/** Children array of a preserveOrder node for a given tag. */
export function childrenOf(node: XmlNode, tag: string): XmlNode[] {
  const v = node[tag];
  return Array.isArray(v) ? (v as XmlNode[]) : [];
}

/**
 * Concatenate all descendant text (#text nodes) under a preserveOrder node,
 * in document order. Used to collapse a heading/paragraph element's inline
 * runs into a single string.
 */
export function collectText(node: XmlNode): string {
  let out = "";
  const tag = tagOf(node);
  if (tag === "#text") {
    const t = node["#text"];
    if (typeof t === "string") return t;
    if (typeof t === "number" || typeof t === "boolean") return String(t);
    return "";
  }
  if (tag) {
    for (const child of childrenOf(node, tag)) out += collectText(child);
  }
  return out;
}

/** Read one entry from a zip buffer as a UTF-8 string, or undefined if absent. */
export async function readZipEntry(buffer: Buffer, name: string): Promise<string | undefined> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file(name);
  return file ? file.async("string") : undefined;
}

/** List the entry names in a zip whose path matches a predicate. */
export async function listZipEntries(
  buffer: Buffer,
  match: (name: string) => boolean,
): Promise<Array<{ name: string; text: () => Promise<string> }>> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buffer);
  const out: Array<{ name: string; text: () => Promise<string> }> = [];
  zip.forEach((relativePath, file) => {
    if (!file.dir && match(relativePath)) {
      out.push({ name: relativePath, text: () => file.async("string") });
    }
  });
  return out;
}

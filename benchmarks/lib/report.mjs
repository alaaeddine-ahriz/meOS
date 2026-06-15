import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const RESULTS_DIR = path.join(here, "..", "results");

/** High-resolution wall time in milliseconds for a synchronous or async fn. */
export async function time(fn) {
  const start = process.hrtime.bigint();
  const value = await fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { value, ms };
}

/** Load a committed JSON fixture by filename (relative to fixtures/). */
export function loadFixture(name) {
  const file = path.join(here, "..", "fixtures", name);
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

/**
 * Flatten a nested results object into CSV rows of (suite, metric, value).
 * Only finite numbers are emitted; nested objects are walked with a dotted key.
 */
function toRows(suite, obj, prefix = "") {
  const rows = [];
  for (const [key, value] of Object.entries(obj)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "number" && Number.isFinite(value)) {
      rows.push({ suite, metric: name, value });
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      rows.push(...toRows(suite, value, name));
    }
  }
  return rows;
}

/** Escape a CSV cell (quote when it contains a comma, quote, or newline). */
function csvCell(value) {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Write the full results object to results/<name>.json and a flattened
 * results/<name>.csv. Returns the absolute paths written. The output dir is
 * gitignored, so this is a local artifact only.
 */
export function writeResults(name, results) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const jsonPath = path.join(RESULTS_DIR, `${name}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2) + "\n");

  const rows = Object.entries(results.suites ?? {}).flatMap(([suite, metrics]) =>
    toRows(suite, metrics),
  );
  const csv = [
    "suite,metric,value",
    ...rows.map((r) => [r.suite, r.metric, r.value].map(csvCell).join(",")),
  ].join("\n");
  const csvPath = path.join(RESULTS_DIR, `${name}.csv`);
  fs.writeFileSync(csvPath, csv + "\n");

  return { jsonPath, csvPath };
}

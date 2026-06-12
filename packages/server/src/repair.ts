import fs from "node:fs";
import path from "node:path";
import type { KnowledgeStore } from "@meos/core";

/**
 * Early watch ingests recorded only the file's basename, so reveal-in-Finder
 * has nothing to point at. On startup, look for each such basename under the
 * watched folders and store the absolute path when exactly one file matches;
 * ambiguous or vanished files are left alone (the UI treats them as inert).
 */
export function repairSourcePaths(store: KnowledgeStore): void {
  const broken = store.sourcesWithRelativePaths();
  if (broken.length === 0) return;

  const byBasename = new Map<string, string[]>();
  for (const folder of store.listWatchedFolders()) {
    collectFiles(folder.path, byBasename);
  }

  let repaired = 0;
  for (const source of broken) {
    const matches = byBasename.get(path.basename(source.path));
    if (matches?.length === 1) {
      store.updateSourcePath(source.id, matches[0]!);
      repaired++;
    }
  }
  if (repaired > 0) {
    console.log(`repair: restored absolute paths for ${repaired}/${broken.length} source(s)`);
  }
}

function collectFiles(dir: string, byBasename: Map<string, string[]>): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // folder unreadable or gone
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(fullPath, byBasename);
    } else if (entry.isFile()) {
      const list = byBasename.get(entry.name) ?? [];
      list.push(fullPath);
      byBasename.set(entry.name, list);
    }
  }
}

/**
 * File-change tracking for a coding-agent run. Snapshot the agent's workspace
 * before the run and again after, then diff the two snapshots into a list of
 * created / edited / removed files. Agent-neutral on purpose: it watches the
 * filesystem rather than parsing each CLI's edit tools, so it reports the same way
 * for Claude/Codex/Cursor/Gemini/Copilot. (LobeHub special-cases this per CLI in
 * `codexFileChangeTracker`; the snapshot approach needs no per-agent wiring.)
 */

import fs from "node:fs";
import path from "node:path";

/** One file the run touched, relative to the workspace root. */
export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted";
}

/** A file's identity for cheap change detection — size + mtime, no hashing. */
interface Entry {
  size: number;
  mtimeMs: number;
}

/** A workspace snapshot: relative path → {@link Entry}. `null` when skipped. */
export type DirSnapshot = Map<string, Entry> | null;

// Directories never worth diffing: VCS metadata, dependency trees, build caches.
// They are large, churn for reasons unrelated to the run, and would drown the
// signal (the file the agent actually wrote).
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".cache",
  ".next",
  "dist",
  "build",
  ".turbo",
  ".venv",
  "__pycache__",
]);

// Walking a huge tree before AND after every run isn't worth it — past this many
// files we give up and report no changes rather than stall the turn. The default
// workspace is an empty scratch dir, so this only trips when the user points the
// agent at a large existing project.
const MAX_ENTRIES = 20_000;

// Don't render an unbounded wall of paths; a run that rewrites hundreds of files
// is summarised by the first N (the UI notes the remainder).
const MAX_CHANGES = 200;

/**
 * Walk `root` into a snapshot of every regular file's size + mtime, keyed by path
 * relative to `root`. Returns `null` if the tree exceeds {@link MAX_ENTRIES} (too
 * big to diff cheaply) or `root` can't be read — callers then skip change
 * tracking for the run rather than failing it. Symlinks are not followed and
 * unreadable entries are skipped, so a permission error never aborts the walk.
 */
export function snapshotDir(root: string): DirSnapshot {
  const snapshot = new Map<string, Entry>();
  const walk = (dir: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return true; // unreadable dir — skip, don't fail the whole snapshot
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (!walk(full)) return false;
      } else if (entry.isFile()) {
        let stat: fs.Stats;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        snapshot.set(path.relative(root, full), { size: stat.size, mtimeMs: stat.mtimeMs });
        if (snapshot.size > MAX_ENTRIES) return false;
      }
    }
    return true;
  };
  if (!fs.existsSync(root)) return new Map();
  return walk(root) ? snapshot : null;
}

/**
 * Diff two {@link snapshotDir} snapshots into the files added, modified, or
 * deleted between them. A file counts as modified when its size or mtime changed
 * (no content hashing — good enough to flag a touch). Returns `[]` when either
 * snapshot was skipped (`null`), so tracking degrades to "nothing reported"
 * rather than a wrong diff. Sorted by path and capped at {@link MAX_CHANGES}.
 */
export function diffSnapshots(before: DirSnapshot, after: DirSnapshot): FileChange[] {
  if (!before || !after) return [];
  const changes: FileChange[] = [];
  for (const [rel, now] of after) {
    const prev = before.get(rel);
    if (!prev) changes.push({ path: rel, status: "added" });
    else if (prev.size !== now.size || prev.mtimeMs !== now.mtimeMs) {
      changes.push({ path: rel, status: "modified" });
    }
  }
  for (const rel of before.keys()) {
    if (!after.has(rel)) changes.push({ path: rel, status: "deleted" });
  }
  changes.sort((a, b) => a.path.localeCompare(b.path));
  return changes.slice(0, MAX_CHANGES);
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diffSnapshots, snapshotDir } from "../src/coding-agent/fileChanges.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "meos-filechanges-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const write = (rel: string, content: string) => {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
};

describe("snapshotDir / diffSnapshots", () => {
  it("reports added, modified, and deleted files relative to the root", () => {
    write("keep.txt", "unchanged");
    write("edit.txt", "before");
    write("gone.txt", "doomed");
    const before = snapshotDir(root);

    write("new.txt", "fresh");
    write("edit.txt", "after — a different length"); // size changes → modified
    fs.rmSync(path.join(root, "gone.txt"));
    const after = snapshotDir(root);

    expect(diffSnapshots(before, after)).toEqual([
      { path: "edit.txt", status: "modified" },
      { path: "gone.txt", status: "deleted" },
      { path: "new.txt", status: "added" },
    ]);
  });

  it("finds changes in nested directories but ignores .git / node_modules churn", () => {
    write("src/a.ts", "one");
    const before = snapshotDir(root);

    write("src/nested/b.ts", "two");
    write(".git/HEAD", "ref: refs/heads/main"); // skipped dir
    write("node_modules/dep/index.js", "module"); // skipped dir
    const after = snapshotDir(root);

    expect(diffSnapshots(before, after)).toEqual([
      { path: path.join("src", "nested", "b.ts"), status: "added" },
    ]);
  });

  it("treats a never-created workspace as empty (no crash)", () => {
    const before = snapshotDir(path.join(root, "does-not-exist"));
    write("only.txt", "x");
    const after = snapshotDir(root);
    expect(diffSnapshots(before, after)).toEqual([{ path: "only.txt", status: "added" }]);
  });

  it("returns no changes when a snapshot was skipped (null)", () => {
    const before = snapshotDir(root);
    expect(diffSnapshots(before, null)).toEqual([]);
    expect(diffSnapshots(null, before)).toEqual([]);
  });
});

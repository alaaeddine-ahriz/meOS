import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Unit separator used to delimit fields inside a single `git log`/`show` record. */
const FIELD = "\x1f";

/** Identity flags so commits aren't attributed to the user's global git config. */
const COMMIT_IDENTITY = ["-c", "user.name=MeOS", "-c", "user.email=meos@localhost"];

export interface GitStatus {
  /** Whether the data directory is a git repository yet. */
  initialized: boolean;
  branch: string | null;
  /** Configured "origin" remote URL, with any embedded credentials redacted. */
  remote: string | null;
  /** Tracked-but-uncommitted changes waiting to be synced. */
  dirty: number;
  /** Commits ahead of / behind the upstream branch (null when no upstream). */
  ahead: number | null;
  behind: number | null;
  lastCommit: string | null;
}

export interface GitCommit {
  hash: string;
  subject: string;
  body: string;
  relativeDate: string;
  files: number;
}

export interface GitCommitDetail {
  hash: string;
  subject: string;
  body: string;
  /** Unified diff (`git show` patch), possibly scoped to a subset of paths. */
  patch: string;
}

/**
 * Versions the human-readable knowledge — the generated wiki pages and daily
 * digests — as a git repository rooted at the data directory. The SQLite store
 * is deliberately left untracked (binary, high-churn, merge-hostile); it is
 * rebuilt from watched files, whereas the markdown is the portable artifact
 * worth syncing to a remote like GitHub.
 *
 * Shells out to the system `git` so credentials flow through the user's normal
 * setup (SSH agent, credential helper, or a token embedded in the remote URL).
 */
export class GitSync {
  constructor(private readonly dataDir: string) {}

  private get gitDir(): string {
    return path.join(this.dataDir, ".git");
  }

  isInitialized(): boolean {
    return fs.existsSync(this.gitDir);
  }

  /** Run a git subcommand in the data dir; throws with stderr on failure. */
  private async run(args: string[]): Promise<string> {
    try {
      const { stdout } = await exec("git", args, {
        cwd: this.dataDir,
        maxBuffer: 16 * 1024 * 1024,
        // Don't flash a console window on Windows for every git call.
        windowsHide: true,
      });
      return stdout.trim();
    } catch (error) {
      const err = error as { stderr?: string; message?: string };
      throw new Error((err.stderr || err.message || String(error)).trim());
    }
  }

  /** Like run(), but swallows failures and returns null — for optional probes. */
  private async tryRun(args: string[]): Promise<string | null> {
    try {
      return await this.run(args);
    } catch {
      return null;
    }
  }

  /** Hide a password/token embedded in an https remote URL before display. */
  private static redact(url: string): string {
    return url.replace(/(https?:\/\/)([^@/]+)@/, "$1•••@");
  }

  async status(): Promise<GitStatus> {
    if (!this.isInitialized()) {
      return {
        initialized: false,
        branch: null,
        remote: null,
        dirty: 0,
        ahead: null,
        behind: null,
        lastCommit: null,
      };
    }
    const branch = await this.tryRun(["rev-parse", "--abbrev-ref", "HEAD"]);
    const remoteRaw = await this.tryRun(["remote", "get-url", "origin"]);
    const porcelain = (await this.tryRun(["status", "--porcelain"])) ?? "";
    const dirty = porcelain ? porcelain.split("\n").filter(Boolean).length : 0;
    const lastCommit = await this.tryRun(["log", "-1", "--format=%h · %s · %cr"]);

    let ahead: number | null = null;
    let behind: number | null = null;
    const counts = await this.tryRun(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
    if (counts) {
      const [b, a] = counts.split(/\s+/).map((n) => Number(n));
      behind = Number.isFinite(b!) ? b! : null;
      ahead = Number.isFinite(a!) ? a! : null;
    }

    return {
      initialized: true,
      branch: branch || null,
      remote: remoteRaw ? GitSync.redact(remoteRaw) : null,
      dirty,
      ahead,
      behind,
      lastCommit: lastCommit || null,
    };
  }

  /** Initialize the repo (idempotent): write .gitignore, make the first commit. */
  async init(): Promise<GitStatus> {
    if (!this.isInitialized()) {
      await this.run(["init", "-b", "main"]);
    }
    const ignorePath = path.join(this.dataDir, ".gitignore");
    if (!fs.existsSync(ignorePath)) {
      // The database and its write-ahead log are derived state, never synced.
      fs.writeFileSync(
        ignorePath,
        ["meos.db", "meos.db-wal", "meos.db-shm", "*.log", ".DS_Store", ""].join("\n"),
      );
    }
    await this.commit("Initialize MeOS knowledge base");
    return this.status();
  }

  /**
   * Throw away the entire version history and start over with a fresh repo and
   * a single initial commit. The working tree is left untouched — the caller
   * deletes any regenerated artifacts first, so the new commit captures whatever
   * remains. A configured "origin" remote is preserved (the local history is
   * fresh, so the next push to an existing remote may need a force).
   */
  async reset(): Promise<GitStatus> {
    let remote: string | null = null;
    if (this.isInitialized()) {
      remote = await this.tryRun(["remote", "get-url", "origin"]);
      fs.rmSync(this.gitDir, { recursive: true, force: true });
    }
    await this.init();
    if (remote) await this.setRemote(remote);
    return this.status();
  }

  /** Point "origin" at a remote URL (adds or replaces it). */
  async setRemote(url: string): Promise<void> {
    if (!this.isInitialized()) await this.init();
    const existing = await this.tryRun(["remote", "get-url", "origin"]);
    await this.run(
      existing ? ["remote", "set-url", "origin", url] : ["remote", "add", "origin", url],
    );
  }

  /** Stage everything tracked and commit. Returns false when there was nothing to commit. */
  async commit(message?: string): Promise<boolean> {
    if (!this.isInitialized()) await this.init();
    await this.run(["add", "-A"]);
    const staged = await this.tryRun(["diff", "--cached", "--name-only"]);
    if (!staged) return false;
    const msg = message ?? `Sync ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
    await this.run([...COMMIT_IDENTITY, "commit", "-m", msg]);
    return true;
  }

  /** Short hash of the current HEAD commit, or null when there are no commits. */
  async headHash(): Promise<string | null> {
    return this.tryRun(["rev-parse", "--short", "HEAD"]);
  }

  /**
   * Recent commits touching the tracked markdown, newest first. Each carries its
   * subject, body, relative date, and the number of files it changed — enough to
   * render the history "tree" without a second round-trip per row.
   */
  async log(limit = 50): Promise<GitCommit[]> {
    if (!this.isInitialized()) return [];
    // A unit-separator-delimited record per commit, records split on NUL.
    const format = ["%h", "%s", "%b", "%cr"].join(FIELD);
    const raw = await this.tryRun(["log", `--max-count=${limit}`, `--format=${format}%x00`]);
    if (!raw) return [];
    const commits: GitCommit[] = [];
    for (const record of raw.split("\0")) {
      const trimmed = record.replace(/^\s+/, "");
      if (!trimmed) continue;
      const [hash, subject, body, relativeDate] = trimmed.split(FIELD);
      const stat = await this.tryRun(["show", "--name-only", "--format=", hash!]);
      const files = stat ? stat.split("\n").filter(Boolean).length : 0;
      commits.push({
        hash: hash!,
        subject: subject ?? "",
        body: (body ?? "").trim(),
        relativeDate: relativeDate ?? "",
        files,
      });
    }
    return commits;
  }

  /** A commit's message and unified diff, optionally scoped to specific paths. */
  async show(hash: string, paths?: string[]): Promise<GitCommitDetail> {
    const meta = await this.run(["show", "--no-patch", `--format=%h${FIELD}%s${FIELD}%b`, hash]);
    const [shortHash, subject, body] = meta.split(FIELD);
    const args = ["show", "--patch", "--format=", hash];
    if (paths && paths.length > 0) args.push("--", ...paths);
    const patch = await this.run(args);
    return {
      hash: shortHash ?? hash,
      subject: subject ?? "",
      body: (body ?? "").trim(),
      patch,
    };
  }

  /**
   * Commit only the given paths (relative to the data dir), leaving any other
   * working-tree changes untouched. Used for per-pass wiki commits so each
   * commit contains exactly what its message describes. Returns false when none
   * of the paths had changes. The trailing pathspec on `commit` ensures no
   * unrelated staged change is swept in.
   */
  async commitPaths(paths: string[], message: string): Promise<boolean> {
    if (!this.isInitialized()) await this.init();
    if (paths.length === 0) return false;
    await this.run(["add", "--", ...paths]);
    const changed = await this.tryRun(["status", "--porcelain", "--", ...paths]);
    if (!changed) return false;
    await this.run([...COMMIT_IDENTITY, "commit", "-m", message, "--", ...paths]);
    return true;
  }

  async push(): Promise<void> {
    const branch = (await this.tryRun(["rev-parse", "--abbrev-ref", "HEAD"])) || "main";
    await this.run(["push", "-u", "origin", branch]);
  }

  async pull(): Promise<void> {
    await this.run(["pull", "--rebase", "--autostash"]);
  }

  /**
   * One-button sync: commit local changes, integrate the remote, then push.
   * Pull/push are skipped when no remote is configured (local-only versioning).
   */
  async sync(message?: string): Promise<GitStatus> {
    await this.commit(message);
    const hasRemote = Boolean(await this.tryRun(["remote", "get-url", "origin"]));
    if (hasRemote) {
      const hasUpstream = Boolean(await this.tryRun(["rev-parse", "--abbrev-ref", "@{upstream}"]));
      if (hasUpstream) await this.pull();
      await this.push();
    }
    return this.status();
  }
}

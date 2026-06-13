import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

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
      const { stdout } = await exec("git", args, { cwd: this.dataDir, maxBuffer: 16 * 1024 * 1024 });
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
      return { initialized: false, branch: null, remote: null, dirty: 0, ahead: null, behind: null, lastCommit: null };
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
      fs.writeFileSync(ignorePath, ["meos.db", "meos.db-wal", "meos.db-shm", "*.log", ".DS_Store", ""].join("\n"));
    }
    await this.commit("Initialize MeOS knowledge base");
    return this.status();
  }

  /** Point "origin" at a remote URL (adds or replaces it). */
  async setRemote(url: string): Promise<void> {
    if (!this.isInitialized()) await this.init();
    const existing = await this.tryRun(["remote", "get-url", "origin"]);
    await this.run(existing ? ["remote", "set-url", "origin", url] : ["remote", "add", "origin", url]);
  }

  /** Stage everything tracked and commit. Returns false when there was nothing to commit. */
  async commit(message?: string): Promise<boolean> {
    if (!this.isInitialized()) await this.init();
    await this.run(["add", "-A"]);
    const staged = await this.tryRun(["diff", "--cached", "--name-only"]);
    if (!staged) return false;
    const msg = message ?? `Sync ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
    await this.run(["-c", "user.name=MeOS", "-c", "user.email=meos@localhost", "commit", "-m", msg]);
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

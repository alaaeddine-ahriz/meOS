import fs from "node:fs";
import path from "node:path";

/** Lightweight metadata for a note in the user's vault. */
export interface NoteMeta {
  /** POSIX-style path relative to the vault root, e.g. "Ideas/second-brain.md". */
  path: string;
  /** Display title: the first level-1 heading, else the filename without extension. */
  title: string;
  /** Last modified time, ISO-8601. */
  updatedAt: string;
}

/** A note's full contents plus the notes that link back to it. */
export interface NoteContents extends NoteMeta {
  markdown: string;
  backlinks: NoteMeta[];
}

const NOTE_EXT = ".md";

/**
 * The user's hand-written note vault — an Obsidian-style folder of markdown
 * files under `<dataDir>/vault`. Unlike the wiki (compiled by the system from
 * sources), the vault is authored entirely by the user: free-form notes that
 * cross-link each other and the wiki via `[[wiki-links]]`.
 *
 * Every path the caller supplies is resolved against the vault root and checked
 * to be inside it, so a crafted `../` can never read or write outside the vault.
 */
export class Vault {
  constructor(private readonly root: string) {}

  /** Resolve a caller-supplied relative path, refusing anything outside the root. */
  private resolve(relPath: string): string {
    const normalized = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, "");
    const full = path.resolve(this.root, normalized);
    const rel = path.relative(this.root, full);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Path escapes the vault: ${relPath}`);
    }
    if (path.extname(full) !== NOTE_EXT) {
      throw new Error(`Notes must be markdown files: ${relPath}`);
    }
    return full;
  }

  /** Vault-relative POSIX path for a resolved absolute file. */
  private relativePath(full: string): string {
    return path.relative(this.root, full).split(path.sep).join("/");
  }

  /** First `# heading`, else the filename, as the note's display title. */
  private titleOf(full: string, markdown: string): string {
    const heading = markdown.match(/^#\s+(.+?)\s*$/m);
    if (heading) return heading[1]!.trim();
    return path.basename(full, NOTE_EXT);
  }

  /** Build the lightweight metadata for a resolved note from its current contents. */
  private metaOf(full: string, markdown: string): NoteMeta {
    return {
      path: this.relativePath(full),
      title: this.titleOf(full, markdown),
      updatedAt: fs.statSync(full).mtime.toISOString(),
    };
  }

  /** All markdown files in the vault, recursively, newest-edited first. */
  list(): NoteMeta[] {
    const notes: NoteMeta[] = [];
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith(NOTE_EXT)) {
          notes.push(this.metaOf(full, fs.readFileSync(full, "utf8")));
        }
      }
    };
    walk(this.root);
    return notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Read one note plus its backlinks; throws if it doesn't exist. */
  read(relPath: string): NoteContents {
    const full = this.resolve(relPath);
    const markdown = fs.readFileSync(full, "utf8");
    return {
      ...this.metaOf(full, markdown),
      markdown,
      backlinks: this.backlinks(full, markdown),
    };
  }

  /** Create or overwrite a note, making parent folders as needed. */
  write(relPath: string, markdown: string): NoteMeta {
    const full = this.resolve(relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, markdown, "utf8");
    return this.metaOf(full, markdown);
  }

  /** Create an empty (titled) note only if nothing is there yet. */
  create(relPath: string): NoteMeta {
    const full = this.resolve(relPath);
    if (fs.existsSync(full)) return this.read(relPath);
    const title = path.basename(full, NOTE_EXT);
    return this.write(relPath, `# ${title}\n\n`);
  }

  /** Delete a note; pruning any now-empty parent folders up to the root. */
  remove(relPath: string): void {
    const full = this.resolve(relPath);
    if (!fs.existsSync(full)) return;
    fs.rmSync(full);
    let dir = path.dirname(full);
    while (dir !== this.root && dir.startsWith(this.root)) {
      if (fs.readdirSync(dir).length > 0) break;
      fs.rmdirSync(dir);
      dir = path.dirname(dir);
    }
  }

  /** Move/rename a note, refusing to clobber an existing target. */
  rename(fromRel: string, toRel: string): NoteMeta {
    const from = this.resolve(fromRel);
    const to = this.resolve(toRel);
    if (!fs.existsSync(from)) throw new Error(`No such note: ${fromRel}`);
    if (fs.existsSync(to)) throw new Error(`A note already exists at ${toRel}`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    return this.read(this.relativePath(to));
  }

  /** Notes whose body contains a `[[link]]` resolving to this note's title or basename. */
  private backlinks(targetFull: string, targetMarkdown: string): NoteMeta[] {
    const targetTitle = this.titleOf(targetFull, targetMarkdown).toLowerCase();
    const targetBase = path.basename(targetFull, NOTE_EXT).toLowerCase();
    const out: NoteMeta[] = [];
    for (const note of this.list()) {
      const full = path.resolve(this.root, note.path);
      if (full === targetFull) continue;
      const md = fs.readFileSync(full, "utf8");
      const linksHere = [...md.matchAll(/\[\[([^\]]+)\]\]/g)].some((m) => {
        const link = m[1]!.trim().toLowerCase();
        return link === targetTitle || link === targetBase;
      });
      if (linksHere) out.push(note);
    }
    return out;
  }
}

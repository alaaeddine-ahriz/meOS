import fs from "node:fs";
import path from "node:path";

/**
 * The user profile — MeOS's *lens*. Where SCHEMA.md says how to read any
 * document, the profile says whose world is being read: who the user is, what
 * they do, the projects and goals that matter, and what to prioritise or
 * ignore. Every LLM stage (extraction, wiki writing, chat, digest,
 * crystallization) injects it so the knowledge base centres on the user's
 * actual world instead of drifting into a generic encyclopedia.
 *
 * It lives as plain Markdown under `data/profile/`, one file per section, so the
 * user can edit it by hand or through the Profile panel in Settings. Multi-file
 * keeps each editor focused and lets history/versioning work per section.
 */

export const PROFILE_DIR = "profile";

/** Where prior versions of each section are snapshotted before a write. */
export const PROFILE_HISTORY_DIR = ".history";

export type ProfileSectionId = "about-me" | "work-context" | "key-projects" | "focus-rules";

export interface ProfileSectionDef {
  id: ProfileSectionId;
  /** File on disk under data/profile/. */
  file: string;
  /** Heading used both in the UI and in the composed lens. */
  title: string;
  /** One-line helper shown under the editor. */
  description: string;
  /** Empty-state prompt shown in the editor (never written to disk). */
  placeholder: string;
}

export const PROFILE_SECTIONS: readonly ProfileSectionDef[] = [
  {
    id: "about-me",
    file: "about-me.md",
    title: "About Me",
    description: "Who you are, your role, your expertise, how you like to work.",
    placeholder:
      "I'm a … working on … My background is … I care about …",
  },
  {
    id: "work-context",
    file: "work-context.md",
    title: "Work / Mission Context",
    description: "Your current work, mission, the organisations and people around it, and your goals.",
    placeholder:
      "I'm currently … My mission is … The key people and organisations are … My goals this quarter are …",
  },
  {
    id: "key-projects",
    file: "key-projects.md",
    title: "Key Projects",
    description: "The projects that matter most right now — the things MeOS should track closely.",
    placeholder: "- ProjectName — what it is, its status, why it matters\n- …",
  },
  {
    id: "focus-rules",
    file: "focus-rules.md",
    title: "Focus Rules",
    description: "What MeOS should prioritise, and what it should ignore.",
    placeholder:
      "Prioritise: facts about my projects, decisions, people I work with, …\nIgnore: generic concepts mentioned in passing, boilerplate, …",
  },
] as const;

export const PROFILE_SECTION_IDS = PROFILE_SECTIONS.map((s) => s.id) as readonly ProfileSectionId[];

/** A full profile: the prose of every section (empty string when unset). */
export type Profile = Record<ProfileSectionId, string>;

const SECTION_BY_ID = new Map(PROFILE_SECTIONS.map((s) => [s.id, s]));

/** Resolve a section id to its definition, or undefined for an unknown id. */
export function profileSection(id: string): ProfileSectionDef | undefined {
  return SECTION_BY_ID.get(id as ProfileSectionId);
}

function profileFilePath(dataDir: string, section: ProfileSectionDef): string {
  return path.join(dataDir, PROFILE_DIR, section.file);
}

/** Read one section's prose, or "" when the file is missing/empty. */
export function loadProfileSection(dataDir: string, id: ProfileSectionId): string {
  const section = SECTION_BY_ID.get(id);
  if (!section) return "";
  try {
    return fs.readFileSync(profileFilePath(dataDir, section), "utf-8").trim();
  } catch {
    return "";
  }
}

/** Read every section into a Profile object. */
export function loadProfile(dataDir: string): Profile {
  const profile = {} as Profile;
  for (const section of PROFILE_SECTIONS) {
    profile[section.id] = loadProfileSection(dataDir, section.id);
  }
  return profile;
}

/**
 * Persist one section, snapshotting the prior content to the history dir first
 * (so the user can restore an earlier version). Returns the version id of the
 * snapshot that was taken, or null when there was nothing worth snapshotting.
 */
export function saveProfileSection(dataDir: string, id: ProfileSectionId, content: string): string | null {
  const section = SECTION_BY_ID.get(id);
  if (!section) throw new Error(`Unknown profile section: ${id}`);

  const file = profileFilePath(dataDir, section);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // Snapshot the version we're about to overwrite, but only when it carried
  // real content (don't litter history with empty seeds or no-op saves).
  const previous = (() => {
    try {
      return fs.readFileSync(file, "utf-8");
    } catch {
      return "";
    }
  })();

  let snapshot: string | null = null;
  if (previous.trim() && previous.trim() !== content.trim()) {
    snapshot = snapshotVersion(dataDir, id, previous);
  }

  fs.writeFileSync(file, `${content.trim()}\n`);
  return snapshot;
}

function historyDir(dataDir: string, id: ProfileSectionId): string {
  return path.join(dataDir, PROFILE_DIR, PROFILE_HISTORY_DIR, id);
}

/** Write a timestamped snapshot of a section's content. Returns its version id. */
function snapshotVersion(dataDir: string, id: ProfileSectionId, content: string): string {
  const dir = historyDir(dataDir, id);
  fs.mkdirSync(dir, { recursive: true });
  const version = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(dir, `${version}.md`), content);
  return version;
}

export interface ProfileVersion {
  version: string;
  /** ISO timestamp parsed back from the version id. */
  savedAt: string;
}

/** Past versions of a section, newest first. */
export function listProfileHistory(dataDir: string, id: ProfileSectionId): ProfileVersion[] {
  const dir = historyDir(dataDir, id);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  return files
    .map((f) => f.replace(/\.md$/, ""))
    .sort((a, b) => b.localeCompare(a))
    .map((version) => ({
      version,
      // The id is an ISO string with ':' and '.' replaced by '-' — restore the
      // two we know to get a parseable timestamp back (best-effort).
      savedAt: version.replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, ":$1:$2.$3Z"),
    }));
}

/** Read a specific historical version's content, or null when absent. */
export function readProfileVersion(dataDir: string, id: ProfileSectionId, version: string): string | null {
  // Guard against path traversal in the version id (it comes from the client).
  if (!/^[\w.-]+$/.test(version)) return null;
  try {
    return fs.readFileSync(path.join(historyDir(dataDir, id), `${version}.md`), "utf-8");
  } catch {
    return null;
  }
}

/**
 * Compose the non-empty sections into a single lens string. Returns "" when the
 * user has written nothing yet, so injection becomes a no-op for a fresh setup.
 */
export function composeProfileContext(profile: Profile): string {
  const blocks: string[] = [];
  for (const section of PROFILE_SECTIONS) {
    const content = profile[section.id]?.trim();
    if (content) blocks.push(`# ${section.title}\n${content}`);
  }
  return blocks.join("\n\n");
}

/** Load + compose in one step — the form every LLM stage wants. */
export function loadProfileContext(dataDir: string): string {
  return composeProfileContext(loadProfile(dataDir));
}

/**
 * Append the profile lens to a system prompt. A no-op when the profile is
 * empty, so stages stay unchanged until the user fills it in. The delimiter and
 * the relevance instruction live here so every stage injects identically — the
 * same contract `withSchema` has for SCHEMA.md.
 */
export function withProfile(systemPrompt: string, profileContext: string): string {
  if (!profileContext.trim()) return systemPrompt;
  return `${systemPrompt}

--- USER PROFILE (LENS) ---
The following is the user's own account of who they are and what matters to them. Use it as the lens for relevance:
- Prioritise facts connected to the user's projects, work, goals, relationships, and decisions.
- Frame shared concepts in terms of the user's world rather than as generic encyclopedia entries.
- Do not treat generic concepts mentioned only in passing as worth their own page.
- Honour the user's focus rules about what to prioritise and what to ignore.

${profileContext}`;
}

/**
 * Seed an empty profile scaffold if the user has none yet: the section files
 * (created empty, so they show up for editing and history works) and a
 * `.gitignore` that keeps the profile private by default — these documents hold
 * sensitive professional context and must not reach a git-synced remote unless
 * the user explicitly opts in.
 */
export function ensureProfileDocs(dataDir: string): void {
  const dir = path.join(dataDir, PROFILE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  for (const section of PROFILE_SECTIONS) {
    const file = path.join(dir, section.file);
    if (!fs.existsSync(file)) fs.writeFileSync(file, "");
  }
  ensureProfilePrivacy(dataDir, false);
}

/**
 * Govern whether the profile dir is exported to git. Default (sync=false) writes
 * a `.gitignore` of `*` inside `data/profile/`, so nothing in it — including the
 * history — is ever tracked. Enabling export tracks the current section files
 * but still keeps the snapshot history local.
 */
export function ensureProfilePrivacy(dataDir: string, sync: boolean): void {
  const dir = path.join(dataDir, PROFILE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const ignore = sync ? `${PROFILE_HISTORY_DIR}/\n` : "*\n";
  fs.writeFileSync(path.join(dir, ".gitignore"), ignore);
}

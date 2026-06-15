import { profile as profileSchema } from "@meos/contracts";
import type { FastifyInstance } from "fastify";
import {
  composeProfileContext,
  draftProfileFromContext,
  draftProfileFromKnowledge,
  editProfileWithInstruction,
  ensureProfilePrivacy,
  imageMediaType,
  listProfileHistory,
  loadProfile,
  parseDocument,
  PROFILE_SECTIONS,
  profileSection,
  readImage,
  readProfileVersion,
  saveProfileSection,
  type Profile,
  type ProfileSectionId,
} from "@meos/core";
import type { AppContext } from "../context.js";
import { httpError, parseOrThrow } from "../errors.js";

/** The source type uploaded profile documents are stored under — a lens input, never a raw graph source. */
const PROFILE_SOURCE_TYPE = "profile_context";
const GIT_SYNC_KEY = "profile.gitSync";

/** Section metadata + current content, the shape the Profile UI renders. */
function profileView(ctx: AppContext) {
  const profile = loadProfile(ctx.config.dataDir);
  return {
    sections: PROFILE_SECTIONS.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      placeholder: s.placeholder,
      content: profile[s.id] ?? "",
    })),
    gitSync: ctx.store.getSetting<boolean>(GIT_SYNC_KEY) ?? false,
  };
}

/** Concatenate the stored profile_context documents — the corpus the assistant drafts from. */
function uploadedContext(ctx: AppContext): { documents: Array<{ title: string; text: string }>; combined: string } {
  const sources = ctx.store
    .recentSources("0000-00-00")
    .filter((s) => s.type === PROFILE_SOURCE_TYPE);
  const documents = sources
    .map((s) => ({ title: s.title, text: ctx.store.getSourceContent(s.id) ?? "" }))
    .filter((d) => d.text.trim());
  return { documents, combined: documents.map((d) => `### ${d.title}\n${d.text}`).join("\n\n") };
}

function logProfileEdit(ctx: AppContext, action: string, detail: Record<string, unknown>): void {
  ctx.store.logAudit("profile_edit", JSON.stringify({ action, ...detail }));
}

/** Rank that puts the entities most telling of the user's world first. */
const TYPE_ORDER: Record<string, number> = {
  project: 0,
  organisation: 1,
  person: 2,
  decision: 3,
  concept: 4,
  place: 5,
};
const KNOWLEDGE_CHAR_BUDGET = 14000;

/**
 * Compile a capped summary of what MeOS has already learned — the wiki prose,
 * the highest-signal entities first — for drafting an initial profile. Falls
 * back to entity summaries when no pages have been written yet.
 */
function wikiKnowledge(ctx: AppContext): string {
  const pages = ctx.store
    .allWikiPageVectors()
    .sort((a, b) => (TYPE_ORDER[a.entity_type] ?? 9) - (TYPE_ORDER[b.entity_type] ?? 9));

  const blocks: string[] = [];
  let budget = KNOWLEDGE_CHAR_BUDGET;
  for (const page of pages) {
    const body = page.body.trim();
    if (!body) continue;
    const block = `### ${page.entity_name} (${page.entity_type})\n${body.slice(0, 1500)}`;
    if (block.length > budget) break;
    blocks.push(block);
    budget -= block.length;
  }

  if (blocks.length > 0) return blocks.join("\n\n");

  // No compiled pages yet — fall back to entity names + summaries.
  const entities = ctx.store
    .listEntities()
    .sort((a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9));
  for (const entity of entities) {
    const block = `- ${entity.name} (${entity.type})${entity.summary ? ` — ${entity.summary}` : ""}`;
    if (block.length > budget) break;
    blocks.push(block);
    budget -= block.length;
  }
  return blocks.join("\n");
}

export function registerProfileRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/profile", async () => profileView(ctx));

  // Save one section. The store snapshots the prior version before overwriting.
  app.put<{ Params: { id: string }; Body: { content?: string } }>("/api/profile/:id", async (request) => {
    const params = parseOrThrow(profileSchema.ProfileIdParam, request.params, "params");
    const section = profileSection(params.id);
    if (!section) throw httpError.notFound("No such profile section");
    const { content } = parseOrThrow(profileSchema.SaveProfileSectionBody, request.body, "body");
    saveProfileSection(ctx.config.dataDir, section.id, content ?? "");
    logProfileEdit(ctx, "edit_section", { section: section.id });
    return profileView(ctx);
  });

  // Apply a reviewed proposal (or hand edit): persist every changed section in
  // one shot, after the user has accepted the diff.
  app.post<{ Body: { profile?: Partial<Profile> } }>("/api/profile/apply", async (request) => {
    const { profile: proposed } = parseOrThrow(profileSchema.ApplyProfileBody, request.body, "body");
    const current = loadProfile(ctx.config.dataDir);
    const applied: string[] = [];
    for (const section of PROFILE_SECTIONS) {
      const next = proposed[section.id];
      if (typeof next !== "string") continue;
      if (next.trim() === (current[section.id] ?? "").trim()) continue;
      saveProfileSection(ctx.config.dataDir, section.id, next);
      applied.push(section.id);
    }
    if (applied.length > 0) logProfileEdit(ctx, "apply_proposal", { sections: applied });
    return { ...profileView(ctx), applied };
  });

  // Upload context documents: parse each, store as a private profile_context
  // source (never run through extraction), then propose a profile update for
  // the user to review. Nothing is applied automatically.
  app.post("/api/profile/upload", async (request, reply) => {
    const stored: Array<{ title: string; text: string }> = [];
    for await (const part of request.files()) {
      const buffer = await part.toBuffer();
      const filename = part.filename;
      const mediaType = imageMediaType(filename);
      let parsed: { title: string; text: string } | null;
      if (mediaType) {
        const text = await readImage(ctx.llm, filename, { mediaType, data: buffer.toString("base64") });
        parsed = { title: filename.replace(/\.[^.]+$/, ""), text };
      } else {
        parsed = await parseDocument(filename, buffer);
      }
      if (!parsed || !parsed.text.trim()) continue;
      ctx.store.createSource({ type: PROFILE_SOURCE_TYPE, title: parsed.title, content: parsed.text });
      stored.push(parsed);
    }
    if (stored.length === 0) {
      throw httpError.badRequest("No readable documents in request");
    }
    logProfileEdit(ctx, "upload_documents", { titles: stored.map((d) => d.title) });

    try {
      const proposal = await draftProfileFromContext({
        llm: ctx.llm,
        currentProfile: loadProfile(ctx.config.dataDir),
        documents: stored,
      });
      return reply.code(200).send({ proposal, documents: stored.map((d) => d.title) });
    } catch (error) {
      throw httpError.upstream(error instanceof Error ? error.message : String(error));
    }
  });

  // Bootstrap an initial profile from the wiki MeOS has already compiled — a
  // first draft the user reviews and edits, rather than starting from blank.
  app.post("/api/profile/draft-from-wiki", async () => {
    const knowledge = wikiKnowledge(ctx);
    if (!knowledge.trim()) {
      throw httpError.badRequest(
        "Nothing in the knowledge base yet — add some watched folders first, then generate a profile from them.",
      );
    }
    try {
      const proposal = await draftProfileFromKnowledge({
        llm: ctx.llm,
        currentProfile: loadProfile(ctx.config.dataDir),
        knowledge,
      });
      logProfileEdit(ctx, "draft_from_wiki", {});
      return { proposal };
    } catch (error) {
      throw httpError.upstream(error instanceof Error ? error.message : String(error));
    }
  });

  // Re-draft a proposal from all uploaded context documents (without a new upload).
  app.post("/api/profile/draft", async () => {
    const { documents } = uploadedContext(ctx);
    if (documents.length === 0) {
      throw httpError.badRequest("No uploaded context documents to draft from");
    }
    try {
      const proposal = await draftProfileFromContext({
        llm: ctx.llm,
        currentProfile: loadProfile(ctx.config.dataDir),
        documents,
      });
      return { proposal };
    } catch (error) {
      throw httpError.upstream(error instanceof Error ? error.message : String(error));
    }
  });

  // Natural-language edit: returns a proposed profile to review, never applied directly.
  app.post<{ Body: { instruction?: string; useUploaded?: boolean } }>(
    "/api/profile/edit",
    async (request) => {
      const { instruction, useUploaded } = parseOrThrow(profileSchema.EditProfileBody, request.body, "body");
      const trimmed = instruction.trim();
      if (!trimmed) throw httpError.validation("Field 'instruction' is required");
      try {
        const proposal = await editProfileWithInstruction({
          llm: ctx.llm,
          currentProfile: loadProfile(ctx.config.dataDir),
          instruction: trimmed,
          uploadedContext: useUploaded ? uploadedContext(ctx).combined || undefined : undefined,
        });
        return { proposal };
      } catch (error) {
        throw httpError.upstream(error instanceof Error ? error.message : String(error));
      }
    },
  );

  // Version history for a section.
  app.get<{ Params: { id: string } }>("/api/profile/:id/history", async (request) => {
    const { id } = parseOrThrow(profileSchema.ProfileIdParam, request.params, "params");
    const section = profileSection(id);
    if (!section) throw httpError.notFound("No such profile section");
    return { versions: listProfileHistory(ctx.config.dataDir, section.id) };
  });

  app.get<{ Params: { id: string; version: string } }>(
    "/api/profile/:id/history/:version",
    async (request) => {
      const { id, version } = parseOrThrow(profileSchema.ProfileIdVersionParam, request.params, "params");
      const section = profileSection(id);
      if (!section) throw httpError.notFound("No such profile section");
      const content = readProfileVersion(ctx.config.dataDir, section.id, version);
      if (content === null) throw httpError.notFound("No such version");
      return { content };
    },
  );

  // Restore a prior version (snapshotting the current one first, via save).
  app.post<{ Params: { id: string }; Body: { version?: string } }>(
    "/api/profile/:id/restore",
    async (request) => {
      const params = parseOrThrow(profileSchema.ProfileIdParam, request.params, "params");
      const section = profileSection(params.id);
      if (!section) throw httpError.notFound("No such profile section");
      const { version } = parseOrThrow(profileSchema.RestoreProfileBody, request.body, "body");
      const content = readProfileVersion(ctx.config.dataDir, section.id, version);
      if (content === null) throw httpError.notFound("No such version");
      saveProfileSection(ctx.config.dataDir, section.id, content);
      logProfileEdit(ctx, "restore_version", { section: section.id, version });
      return profileView(ctx);
    },
  );

  // The profile-edit audit trail (governance).
  app.get("/api/profile/audit", async () => ({
    entries: ctx.store.recentAudit(100).filter((e) => e.op === "profile_edit"),
  }));

  // Privacy toggle: whether the profile dir is exported to git. Off by default.
  app.put<{ Body: { sync?: boolean } }>("/api/profile/privacy", async (request, reply) => {
    const { sync } = parseOrThrow(profileSchema.ProfilePrivacyBody, request.body, "body");
    ensureProfilePrivacy(ctx.config.dataDir, sync);
    ctx.store.setSetting(GIT_SYNC_KEY, sync);
    logProfileEdit(ctx, "set_git_sync", { sync });
    return reply.send({ gitSync: sync });
  });
}

/** Compose the current profile lens — used by stages that re-read it each run. */
export function currentProfileContext(ctx: AppContext): string {
  return composeProfileContext(loadProfile(ctx.config.dataDir));
}

export type { ProfileSectionId };

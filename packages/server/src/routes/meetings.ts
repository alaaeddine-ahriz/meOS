import { meetings } from "@meos/contracts";
import { MEETING_SOURCE_TYPE, processMeetingNote } from "@meos/core";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { httpError, parseOrThrow } from "../errors.js";

/** Action items map onto the existing "task" observation kind. */
const ACTION_KIND = "task";

/**
 * Meeting notes (#26): create, edit, reprocess, and review a meeting note as a
 * trusted, auto-linked, citable source. A meeting is a `type:"meeting"` source
 * whose markdown body rides the full ingestion pipeline (parse → chunk → embed →
 * extract → merge), so it is searchable, answerable, wiki-eligible, and citable
 * like a local file. Reprocess opens a new revision (#16) and re-runs extraction.
 */
export function registerMeetingRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Assemble the detail payload (note + extracted structure + suggested links). */
  const detail = (sourceId: number): meetings.MeetingDetail => {
    const note = ctx.store.getMeetingNote(sourceId);
    const source = ctx.store.getSource(sourceId);
    if (!note || !source || ctx.store.getSourceType(sourceId) !== MEETING_SOURCE_TYPE) {
      throw httpError.notFound("No such meeting note");
    }
    const observations = ctx.store.observationsForSource(sourceId).map((o) => ({
      id: o.id,
      kind: o.kind,
      text: o.text,
      entity: o.entity_name,
      quote: o.source_quote,
    }));
    const links = ctx.store.meetingLinkSuggestions(sourceId).map((l) => ({
      id: l.id,
      entityId: l.entity_id,
      entityName: l.entity_name,
      entityType: l.entity_type,
      entitySlug: l.entity_slug,
      rationale: l.rationale,
      method: l.method,
      status: l.status,
    }));
    return {
      sourceId,
      title: source.title,
      date: note.meeting_date,
      attendees: note.attendees,
      content: ctx.store.getSourceContent(sourceId) ?? "",
      decisions: observations.filter((o) => o.kind === "decision"),
      actionItems: observations.filter((o) => o.kind === ACTION_KIND),
      risks: observations.filter((o) => o.kind === "risk"),
      openQuestions: observations.filter((o) => o.kind === "open_question"),
      links,
    };
  };

  // List every meeting note (newest meeting first).
  app.get("/api/meetings", async () => ({
    meetings: ctx.store.listMeetingNotes().map((m) => ({
      sourceId: m.source_id,
      title: m.title,
      date: m.meeting_date,
      attendees: m.attendees,
    })),
  }));

  // Create a meeting note: ingest it as a trusted source, extract its structure,
  // and persist auto-suggested links. Returns the full detail view.
  app.post("/api/meetings", async (request, reply) => {
    const body = parseOrThrow(meetings.CreateMeetingBody, request.body, "body");
    const { sourceId } = await processMeetingNote(
      { store: ctx.store, pipeline: ctx.pipeline },
      {
        title: body.title,
        date: body.date ?? null,
        attendees: body.attendees,
        content: body.content,
      },
    );
    return reply.code(201).send(detail(sourceId));
  });

  // The detail view: original note + extracted structure + suggested links.
  app.get<{ Params: { id: string } }>("/api/meetings/:id", async (request) => {
    const sourceId = parseId(request.params.id);
    return detail(sourceId);
  });

  // Edit a meeting note. Re-runs extraction over the edited body (a new
  // revision, #16) so its structure and links reflect the new content.
  app.put<{ Params: { id: string } }>("/api/meetings/:id", async (request) => {
    const sourceId = parseId(request.params.id);
    requireMeeting(ctx, sourceId);
    const body = parseOrThrow(meetings.UpdateMeetingBody, request.body, "body");
    await processMeetingNote(
      { store: ctx.store, pipeline: ctx.pipeline },
      {
        title: body.title,
        date: body.date ?? null,
        attendees: body.attendees,
        content: body.content,
      },
      sourceId,
    );
    return detail(sourceId);
  });

  // Reprocess: re-run extraction over the current note content, opening a new
  // revision and refreshing the structure + suggested links.
  app.post<{ Params: { id: string } }>("/api/meetings/:id/reprocess", async (request) => {
    const sourceId = parseId(request.params.id);
    const note = requireMeeting(ctx, sourceId);
    const source = ctx.store.getSource(sourceId);
    const { outcome } = await processMeetingNote(
      { store: ctx.store, pipeline: ctx.pipeline },
      {
        title: source?.title ?? "Untitled meeting",
        date: note.meeting_date,
        attendees: note.attendees,
        content: bodyWithoutHeader(ctx.store.getSourceContent(sourceId) ?? ""),
      },
      sourceId,
    );
    return { sourceId, status: outcome.status };
  });

  // Review a suggested link (accept or reject). The decision is durable across
  // reprocesses (#26).
  app.patch<{ Params: { id: string; linkId: string } }>(
    "/api/meetings/:id/links/:linkId",
    async (request) => {
      const sourceId = parseId(request.params.id);
      requireMeeting(ctx, sourceId);
      const linkId = parseId(request.params.linkId);
      const { status } = parseOrThrow(meetings.ReviewLinkBody, request.body, "body");
      const updated = ctx.store.reviewMeetingLinkSuggestion(linkId, status);
      if (!updated) throw httpError.notFound("No such link suggestion");
      return { updated };
    },
  );

  function parseId(raw: string): number {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) throw httpError.badRequest("Invalid meeting id");
    return id;
  }

  function requireMeeting(context: AppContext, sourceId: number) {
    const note = context.store.getMeetingNote(sourceId);
    if (!note || context.store.getSourceType(sourceId) !== MEETING_SOURCE_TYPE) {
      throw httpError.notFound("No such meeting note");
    }
    return note;
  }
}

/**
 * Strip the composed structured header (the "# Title", "**Date:**",
 * "**Attendees:**" lines) the create flow prepends, leaving the user's body so a
 * reprocess re-composes cleanly without duplicating the header.
 */
function bodyWithoutHeader(content: string): string {
  const lines = content.split("\n");
  let i = 0;
  if (lines[i]?.startsWith("# ")) i++;
  while (
    i < lines.length &&
    (lines[i]?.trim() === "" ||
      lines[i]?.startsWith("**Date:**") ||
      lines[i]?.startsWith("**Attendees:**"))
  ) {
    i++;
  }
  return lines.slice(i).join("\n").trim();
}

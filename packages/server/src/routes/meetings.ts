import { meetings } from "@meos/contracts";
import { MEETING_SOURCE_TYPE, processMeetingNote } from "@meos/core";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { httpError, parseOrThrow } from "../errors.js";
import { routeSchema } from "../route-schema.js";

const tags = ["meetings"];

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
    // An auto-detected meeting may carry a linked calendar event (#85); resolve
    // it to a compact ref for the detail view (best-effort — may have vanished).
    const calRef = note.linked_calendar_source_id
      ? ctx.store.getCalendarEventRef(note.linked_calendar_source_id)
      : undefined;
    return {
      sourceId,
      title: source.title,
      date: note.meeting_date,
      attendees: note.attendees,
      content: ctx.store.getSourceContent(sourceId) ?? "",
      detectionMethod: note.detection_method,
      detectionConfidence: note.detection_confidence,
      calendarEvent: calRef
        ? { sourceId: calRef.sourceId, title: calRef.title, start: calRef.start }
        : null,
      decisions: observations.filter((o) => o.kind === "decision"),
      actionItems: observations.filter((o) => o.kind === ACTION_KIND),
      risks: observations.filter((o) => o.kind === "risk"),
      openQuestions: observations.filter((o) => o.kind === "open_question"),
      links,
    };
  };

  // List every meeting note (newest meeting first).
  app.get(
    "/api/meetings",
    {
      schema: routeSchema({
        tags,
        summary: "List meeting notes",
        response: meetings.ListMeetingsResponse,
        // Exposed over MCP so an agent can browse meeting notes.
        mcp: { expose: true, name: "meetings", safety: "read" },
      }),
    },
    async () =>
      meetings.ListMeetingsResponse.parse({
        meetings: ctx.store.listMeetingNotes().map((m) => ({
          sourceId: m.source_id,
          title: m.title,
          date: m.meeting_date,
          attendees: m.attendees,
        })),
      }),
  );

  // Create a meeting note: ingest it as a trusted source, extract its structure,
  // and persist auto-suggested links. Returns the full detail view.
  app.post(
    "/api/meetings",
    {
      schema: routeSchema({
        tags,
        summary: "Create a meeting note",
        body: meetings.CreateMeetingBody,
        response: { 201: meetings.MeetingDetailSchema },
        // Exposed over MCP: ingest a meeting note as a citable source (reversible — editable/deletable).
        mcp: { expose: true, safety: "write" },
      }),
    },
    async (request, reply) => {
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
      return reply.code(201).send(meetings.MeetingDetailSchema.parse(detail(sourceId)));
    },
  );

  // The detail view: original note + extracted structure + suggested links.
  app.get<{ Params: { id: string } }>(
    "/api/meetings/:id",
    {
      schema: routeSchema({
        tags,
        summary: "Get a meeting note detail",
        response: meetings.MeetingDetailSchema,
        // Exposed over MCP so an agent can read a meeting's note + extracted structure.
        mcp: { expose: true, name: "meetings_get", safety: "read" },
      }),
    },
    async (request) => {
      const sourceId = parseId(request.params.id);
      return meetings.MeetingDetailSchema.parse(detail(sourceId));
    },
  );

  // Edit a meeting note. Re-runs extraction over the edited body (a new
  // revision, #16) so its structure and links reflect the new content.
  app.put<{ Params: { id: string } }>(
    "/api/meetings/:id",
    {
      schema: routeSchema({
        tags,
        summary: "Edit a meeting note",
        body: meetings.UpdateMeetingBody,
        response: meetings.MeetingDetailSchema,
        // Exposed over MCP: edit the note + re-run extraction (a new revision; reversible).
        mcp: { expose: true, name: "meetings_update", safety: "write" },
      }),
    },
    async (request) => {
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
      return meetings.MeetingDetailSchema.parse(detail(sourceId));
    },
  );

  // Reprocess: re-run extraction over the current note content, opening a new
  // revision and refreshing the structure + suggested links.
  app.post<{ Params: { id: string } }>(
    "/api/meetings/:id/reprocess",
    {
      schema: routeSchema({
        tags,
        summary: "Reprocess a meeting note",
        response: meetings.ReprocessMeetingResponse,
        // Exposed over MCP: re-run extraction over the current note (idempotent).
        mcp: { expose: true, name: "meetings_reprocess", safety: "write" },
      }),
    },
    async (request) => {
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
      return meetings.ReprocessMeetingResponse.parse({ sourceId, status: outcome.status });
    },
  );

  // Review a suggested link (accept or reject). The decision is durable across
  // reprocesses (#26).
  app.patch<{ Params: { id: string; linkId: string } }>(
    "/api/meetings/:id/links/:linkId",
    {
      schema: routeSchema({
        tags,
        summary: "Review a suggested meeting link",
        body: meetings.ReviewLinkBody,
        response: meetings.ReviewLinkResponse,
        // Exposed over MCP: accept/reject a suggested entity link (reversible decision).
        mcp: { expose: true, name: "meetings_link_review", safety: "write" },
      }),
    },
    async (request) => {
      const sourceId = parseId(request.params.id);
      requireMeeting(ctx, sourceId);
      const linkId = parseId(request.params.linkId);
      const { status } = parseOrThrow(meetings.ReviewLinkBody, request.body, "body");
      const updated = ctx.store.reviewMeetingLinkSuggestion(linkId, status);
      if (!updated) throw httpError.notFound("No such link suggestion");
      return meetings.ReviewLinkResponse.parse({ updated });
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

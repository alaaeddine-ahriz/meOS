import { ErrorCode, ErrorEnvelopeSchema, meetings } from "@meos/contracts";
import { StubLlmClient } from "@meos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./helpers/test-server.js";

let server: TestServer;

// A canned meeting extraction covering every meeting observation kind plus the
// entities a meeting links to. Keyed off the document title so two meetings
// produce distinct claims (the merge reinforces byte-identical ones, which would
// otherwise re-attach to the first meeting's source). Swapped into the live
// context's LLM so the create/edit/reprocess routes run fully offline.
function meetingExtraction(title: string) {
  const tag = title.replace(/[^a-z0-9]+/gi, " ").trim() || "meeting";
  return {
    entities: [
      { name: "Project Orion", type: "project", aliases: ["Orion"], summary: "Search project." },
      { name: "Dana Lee", type: "person", aliases: [], summary: "Engineer." },
    ],
    relationships: [],
    observations: [
      {
        entity: "Project Orion",
        claim: `In ${tag}, the team decided to ship Project Orion in Q3.`,
        kind: "decision",
        sourceQuote: null,
        validFrom: null,
        validUntil: null,
        confidence: 0.9,
        sensitivity: "normal",
      },
      {
        entity: "Dana Lee",
        claim: `In ${tag}, Dana Lee will prepare the rollout plan.`,
        kind: "task",
        sourceQuote: null,
        validFrom: null,
        validUntil: null,
        confidence: 0.8,
        sensitivity: "normal",
      },
      {
        entity: "Project Orion",
        claim: `In ${tag}, there is a risk the migration slips.`,
        kind: "risk",
        sourceQuote: null,
        validFrom: null,
        validUntil: null,
        confidence: 0.6,
        sensitivity: "normal",
      },
      {
        entity: "Project Orion",
        claim: `In ${tag}, it is unclear whether the budget is approved.`,
        kind: "open_question",
        sourceQuote: null,
        validFrom: null,
        validUntil: null,
        confidence: 0.5,
        sensitivity: "normal",
      },
    ],
  };
}

/** Pull "Document title: X" out of the extraction request's user message. */
function titleOf(request: { messages: Array<{ content: unknown }> }): string {
  const content = request.messages[0]?.content;
  const text = typeof content === "string" ? content : "";
  return text.match(/Document title:\s*(.+)/)?.[1]?.trim() ?? "meeting";
}

beforeAll(async () => {
  server = await buildTestServer();
  // Swap the keyless `local` client for a deterministic stub: extraction returns
  // the canned meeting graph; agent calls (wiki regen) are no-ops.
  server.ctx.llm.swap(
    new StubLlmClient({
      onStructured: (request) => {
        if (request.schemaName === "knowledge_extraction")
          return meetingExtraction(titleOf(request));
        // Contradiction detection runs post-merge in the real context; no conflicts.
        if (request.schemaName === "contradiction_judgement") return { conflicts: [] };
        return undefined;
      },
      onAgent: async () => "done",
      onAgentStream: () => [{ type: "text", text: "done" }],
    }),
  );
});

afterAll(async () => {
  await server.cleanup();
});

const createBody = {
  title: "Orion sync",
  date: "2026-03-04",
  attendees: ["Dana Lee", "Sam Patel"],
  content: "We decided to ship Orion in Q3. Dana will prepare the rollout plan.",
};

describe("POST /api/meetings", () => {
  it("400s with a VALIDATION envelope when the title is missing", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/meetings",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ content: "no title" }),
    });
    expect(res.statusCode).toBe(400);
    const envelope = ErrorEnvelopeSchema.parse(res.json());
    expect(envelope.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it("creates a meeting and returns its detail with extracted structure + links", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/meetings",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(createBody),
    });
    expect(res.statusCode).toBe(201);
    const detail = meetings.MeetingDetailSchema.parse(res.json());
    expect(detail.title).toBe("Orion sync");
    expect(detail.date).toBe("2026-03-04");
    expect(detail.attendees).toEqual(["Dana Lee", "Sam Patel"]);
    expect(detail.decisions).toHaveLength(1);
    expect(detail.actionItems).toHaveLength(1);
    expect(detail.risks).toHaveLength(1);
    expect(detail.openQuestions).toHaveLength(1);
    expect(detail.links.map((l) => l.entityName).sort()).toEqual(["Dana Lee", "Project Orion"]);
    for (const link of detail.links) expect(link.rationale.length).toBeGreaterThan(0);
  });
});

describe("meeting lifecycle", () => {
  let sourceId: number;

  it("lists, fetches, edits, reviews a link, and reprocesses", async () => {
    // Create.
    const created = meetings.MeetingDetailSchema.parse(
      (
        await server.app.inject({
          method: "POST",
          url: "/api/meetings",
          headers: { "content-type": "application/json" },
          payload: JSON.stringify({ ...createBody, title: "Lifecycle sync" }),
        })
      ).json(),
    );
    sourceId = created.sourceId;

    // List includes it.
    const list = meetings.ListMeetingsResponse.parse(
      (await server.app.inject({ method: "GET", url: "/api/meetings" })).json(),
    );
    expect(list.meetings.some((m) => m.sourceId === sourceId)).toBe(true);

    // Fetch detail.
    const detail = meetings.MeetingDetailSchema.parse(
      (await server.app.inject({ method: "GET", url: `/api/meetings/${sourceId}` })).json(),
    );
    expect(detail.decisions).toHaveLength(1);

    // Review a suggested link → accepted.
    const link = detail.links[0]!;
    const reviewed = await server.app.inject({
      method: "PATCH",
      url: `/api/meetings/${sourceId}/links/${link.id}`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ status: "accepted" }),
    });
    expect(reviewed.statusCode).toBe(200);
    expect(meetings.ReviewLinkResponse.parse(reviewed.json()).updated).toBe(true);

    // Edit the note.
    const edited = await server.app.inject({
      method: "PUT",
      url: `/api/meetings/${sourceId}`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ ...createBody, title: "Lifecycle sync v2" }),
    });
    expect(edited.statusCode).toBe(200);
    expect(meetings.MeetingDetailSchema.parse(edited.json()).title).toBe("Lifecycle sync v2");
    // The accepted link decision survived the edit/re-extraction.
    const afterEdit = meetings.MeetingDetailSchema.parse(edited.json());
    expect(afterEdit.links.find((l) => l.entityId === link.entityId)?.status).toBe("accepted");

    // Reprocess opens a new revision and re-extracts.
    const reprocessed = await server.app.inject({
      method: "POST",
      url: `/api/meetings/${sourceId}/reprocess`,
    });
    expect(reprocessed.statusCode).toBe(200);
    const result = meetings.ReprocessMeetingResponse.parse(reprocessed.json());
    expect(result.sourceId).toBe(sourceId);
    expect(result.status).toBe("done");
    expect(server.ctx.store.revisionsForSource(sourceId).length).toBeGreaterThanOrEqual(2);
  });

  it("404s for an unknown meeting", async () => {
    const res = await server.app.inject({ method: "GET", url: "/api/meetings/999999" });
    expect(res.statusCode).toBe(404);
    expect(ErrorEnvelopeSchema.parse(res.json()).code).toBe(ErrorCode.NOT_FOUND);
  });
});

import { knowledge } from "@meos/contracts";
import {
  classifyMemoryTier,
  detectSensitivity,
  initialConfidence,
  normalizeRelationshipLabel,
  redactSecrets,
  resolveCandidate,
  strongerSensitivity,
  type EntityRow,
  type EntityType,
} from "@meos/core";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { httpError, parseOrThrow } from "../errors.js";
import { routeSchema } from "../route-schema.js";

const tags = ["knowledge"];

/**
 * Granular knowledge writes (native agent intelligence, PR2). Where
 * `POST /api/wiki/agent/facts` merges a whole extraction gated on verbatim source
 * quotes, these endpoints let a caller (and, via MCP, a coding agent) write the
 * knowledge base one primitive at a time: upsert an entity, add one observation,
 * add one relationship.
 *
 * Every write goes through the SAME canonical store path the extraction-merge
 * uses, so the two cannot diverge on identity or provenance:
 *  - entity resolution   → `resolveCandidate` (exact name/alias/slug, then fuzzy
 *                          merge), with the same `findEntityByName ?? slug`
 *                          fallback `mergeExtraction`'s inner `resolve()` uses;
 *  - observations        → `store.insertObservation` with `initialConfidence`,
 *                          `detectSensitivity`/`redactSecrets`, and
 *                          `classifyMemoryTier` — identical to `mergeExtraction`;
 *  - relationships       → `store.upsertRelationship` with
 *                          `normalizeRelationshipLabel`;
 *  - staleness           → `store.markWikiStale` (+ `recordStaleSource` credit
 *                          when a real source is named), exactly as the merge
 *                          flags pages so the wiki picks the change up.
 *
 * Provenance: a granular write is agent/user-authored by default (`manual`), so —
 * unlike the facts route — it does NOT require a fabricated verbatim quote. A
 * `manual` write stores no `source_id` (the column is nullable) and keeps any
 * `quote` as free display text. A `source` write names an existing ingested
 * source by id and reuses the merge's source-backed provenance (char spans via
 * the located quote, stale-source credit toward the next regeneration).
 */
export function registerKnowledgeRoutes(app: FastifyInstance, ctx: AppContext): void {
  /**
   * Resolve an {@link knowledge.EntityRef} to an existing entity id, optionally
   * creating one when resolving by (type, name). Mirrors the resolution order in
   * `mergeExtraction`: exact id → `resolveCandidate` (which itself does exact
   * name/alias/slug first, then a fuzzy same-type merge) → create. A resolution
   * that only reaches "review" confidence is treated as a fresh entity (the
   * duplicates screen surfaces the pair for a human), never silently merged.
   */
  const resolveRef = (
    ref: knowledge.EntityRefT,
    options: { create: boolean },
  ): { entity: EntityRow; created: boolean } => {
    if (ref.id !== undefined) {
      const entity = ctx.store.getEntity(ref.id);
      if (!entity) throw httpError.notFound(`No entity #${ref.id}`);
      return { entity, created: false };
    }
    // The schema's refine guarantees name+type are both present when id is absent.
    const name = ref.name!.trim();
    const type = ref.type as EntityType;

    const decision = resolveCandidate(ctx.store, { name, type });
    if (decision?.action === "merge") {
      // The supplied surface form becomes an alias so it resolves directly next
      // time without re-running candidate generation — same as the merge does.
      if (decision.entity.name.trim().toLowerCase() !== name.toLowerCase()) {
        ctx.store.addAlias(decision.entity.id, name);
      }
      return { entity: decision.entity, created: false };
    }

    // A "review"-grade match still creates a fresh entity (left for the duplicates
    // screen), matching `mergeExtraction`'s behaviour for ambiguous candidates.
    if (!options.create) throw httpError.notFound(`No entity named "${name}" (${type})`);
    return { entity: ctx.store.createEntity({ type, name }), created: true };
  };

  /**
   * Flag an entity's wiki page stale exactly as `mergeExtraction` does, crediting
   * the source toward the next regeneration when a real one is named. Returns
   * whether the page was flagged (it self-skips entities with no wiki-eligible
   * backing, e.g. a connector-only contact).
   */
  const flagStale = (entityId: number, sourceId: number | undefined): boolean => {
    const flagged = ctx.store.markWikiStale(entityId);
    if (flagged && sourceId !== undefined) ctx.store.recordStaleSource(entityId, sourceId);
    return flagged;
  };

  /**
   * Resolve a write's {@link knowledge.Provenance} to a backing source. A `manual`
   * write has none; a `source` write must name a real, existing source (its
   * active-revision text is what `mergeExtraction` locates quotes against).
   */
  const resolveSource = (
    provenance: knowledge.ProvenanceT,
  ): { sourceId: number; text: string | undefined } | undefined => {
    if (provenance.kind !== "source") return undefined;
    // The schema's refine guarantees `sourceId` is present when kind is "source".
    const sourceId = provenance.sourceId!;
    if (!ctx.store.getSource(sourceId)) throw httpError.notFound(`No source #${sourceId}`);
    const revision = ctx.store.activeRevision(sourceId);
    const text =
      revision?.normalized_content ?? ctx.store.getSourceRawContent(sourceId) ?? undefined;
    return { sourceId, text };
  };

  // --- POST /api/knowledge/entities -----------------------------------
  // Upsert: resolve (type, name) to an existing entity or create one, then apply
  // the optional summary/aliases. Idempotent — a repeated name resolves rather
  // than duplicates.
  app.post(
    "/api/knowledge/entities",
    {
      schema: routeSchema({
        tags,
        summary: "Upsert a knowledge entity",
        body: knowledge.UpsertEntityBody,
        response: knowledge.UpsertEntityResponse,
        // The agent's native extraction primitive: create/resolve an entity. Idempotent.
        mcp: { expose: true, name: "knowledge_entity_upsert", safety: "write" },
      }),
    },
    async (request) => {
      const body = parseOrThrow(knowledge.UpsertEntityBody, request.body, "body");

      const { entity, created } = resolveRef(
        { name: body.name, type: body.type },
        { create: true },
      );

      // Update the summary when supplied; only flag the page stale if it changed,
      // mirroring the merge's "regenerate only when content actually differs".
      if (body.summary !== undefined && body.summary !== (entity.summary ?? undefined)) {
        ctx.store.setEntitySummary(entity.id, body.summary);
        ctx.store.markWikiStale(entity.id);
      }
      for (const alias of body.aliases ?? []) {
        if (alias.trim() && alias.trim().toLowerCase() !== entity.name.trim().toLowerCase()) {
          ctx.store.addAlias(entity.id, alias);
        }
      }

      const fresh = ctx.store.getEntity(entity.id) ?? entity;
      return knowledge.UpsertEntityResponse.parse({
        id: fresh.id,
        slug: fresh.slug,
        created,
      });
    },
  );

  // --- POST /api/knowledge/observations -------------------------------
  // Add one fact/observation about an entity, with provenance. Reuses the merge's
  // observation insertion (confidence scaling, secret redaction, sensitivity,
  // memory tier) and its staleness flagging.
  app.post(
    "/api/knowledge/observations",
    {
      schema: routeSchema({
        tags,
        summary: "Add an observation about an entity",
        body: knowledge.AddObservationBody,
        response: knowledge.AddObservationResponse,
        // Native extraction primitive: record one fact about an entity, with provenance.
        mcp: { expose: true, name: "knowledge_observation_add", safety: "write" },
      }),
    },
    async (request) => {
      const body = parseOrThrow(knowledge.AddObservationBody, request.body, "body");

      // The claim is either an explicit `text` or a `predicate` + `object` pair.
      const claim =
        body.text?.trim() ||
        (body.predicate && body.object ? `${body.predicate.trim()} ${body.object.trim()}` : "");
      if (!claim) {
        throw httpError.badRequest("Provide `text`, or both `predicate` and `object`.");
      }

      const provenance = body.provenance ?? { kind: "manual" as const };
      // A `source` write names a real source; its text locates the quote's char
      // span exactly as the merge does. A `manual` write has no backing source.
      const source = resolveSource(provenance);
      const sourceId = source?.sourceId;
      const sourceText = source?.text;

      const { entity } = resolveRef(body.entity, { create: true });

      // Redact credentials before anything touches storage or the embedder, then
      // embed the claim — identical to the merge's per-observation handling.
      const text = redactSecrets(claim);
      const [vector] = await ctx.embedder.embed([text]);

      // Locate the quote's char span within the named source's text (provenance);
      // a manual write keeps the quote as free display text with no span.
      const quote = provenance.quote ?? null;
      const span = locateQuote(sourceText, quote);
      const sourceType = sourceId !== undefined ? ctx.store.getSourceType(sourceId) : undefined;

      const observationId = ctx.store.insertObservation({
        entityId: entity.id,
        text,
        sourceId,
        embedding: vector,
        confidence: initialConfidence(body.confidence ?? 0.7, sourceType),
        kind: body.kind,
        sourceQuote: quote ? redactSecrets(quote) : null,
        charStart: span?.start ?? null,
        charEnd: span?.end ?? null,
        validFrom: body.validFrom ?? null,
        validUntil: body.validUntil ?? null,
        // Honour the caller's label, but a detected credential always escalates it.
        sensitivity: strongerSensitivity(body.sensitivity ?? "normal", detectSensitivity(claim)),
        // A new claim enters at its natural tier; corroboration promotes it later.
        memoryTier: classifyMemoryTier({ kind: body.kind, sourceType, sourceCount: 1 }),
      });

      const staleFlagged = flagStale(entity.id, sourceId);

      ctx.activity.recordExternalRun({
        entityId: entity.id,
        name: entity.name,
        type: entity.type,
        slug: entity.slug,
        sourceIds: sourceId !== undefined ? [sourceId] : [],
        summary: `Recorded a ${body.kind} about "${entity.name}": ${text}`,
      });

      return knowledge.AddObservationResponse.parse({
        observationId,
        entityId: entity.id,
        created: true,
        staleFlagged,
      });
    },
  );

  // --- POST /api/knowledge/relationships ------------------------------
  // Add one relationship between two resolved entities, reusing
  // `upsertRelationship` + the canonical resolution and label normalisation.
  app.post(
    "/api/knowledge/relationships",
    {
      schema: routeSchema({
        tags,
        summary: "Add a relationship between two entities",
        body: knowledge.AddRelationshipBody,
        response: knowledge.AddRelationshipResponse,
        // Native extraction primitive: link two entities with a normalised predicate.
        mcp: { expose: true, name: "knowledge_relationship_add", safety: "write" },
      }),
    },
    async (request) => {
      const body = parseOrThrow(knowledge.AddRelationshipBody, request.body, "body");

      const provenance = body.provenance ?? { kind: "manual" as const };
      const sourceId = resolveSource(provenance)?.sourceId;

      const { entity: subject } = resolveRef(body.subject, { create: true });
      const { entity: object } = resolveRef(body.object, { create: true });
      if (subject.id === object.id) {
        throw httpError.badRequest("A relationship's subject and object must differ.");
      }

      const predicate = normalizeRelationshipLabel(body.predicate);
      const created = ctx.store.upsertRelationship(subject.id, object.id, predicate, sourceId);

      // A new edge changes both pages; reinforcing an existing one does not, so
      // only flag stale on creation — matching the merge's `changed` set.
      if (created) {
        flagStale(subject.id, sourceId);
        flagStale(object.id, sourceId);
      }

      return knowledge.AddRelationshipResponse.parse({
        subjectId: subject.id,
        objectId: object.id,
        predicate,
        created,
      });
    },
  );
}

/** Char span of a quote within its source text, or null when it can't be located. */
function locateQuote(
  sourceText: string | undefined,
  quote: string | null,
): { start: number; end: number } | null {
  if (!sourceText || !quote) return null;
  const trimmed = quote.trim();
  if (!trimmed) return null;
  const start = sourceText.indexOf(trimmed);
  return start === -1 ? null : { start, end: start + trimmed.length };
}

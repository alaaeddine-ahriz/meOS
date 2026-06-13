import { z } from "zod";
import type { LlmClient } from "../llm/types.js";
import { PROFILE_SECTIONS, type Profile, type ProfileSectionId } from "./profile-doc.js";

/**
 * The AI assistant behind the Profile panel. It never overwrites the profile
 * directly: it returns a *proposed* full profile (every section) so the UI can
 * diff it against the current one and let the user accept, edit, or reject. Two
 * entry points — drafting from uploaded context documents, and editing in
 * natural language ("make the work context more concise", "remove KAIST").
 */

/** The proposal shape: one string per section, plus a short note on what changed. */
const profileProposalSchema = z.object({
  aboutMe: z.string(),
  workContext: z.string(),
  keyProjects: z.string(),
  focusRules: z.string(),
  /** One or two sentences describing what the proposal changed and why. */
  summary: z.string(),
});

type ProfileProposalRaw = z.infer<typeof profileProposalSchema>;

export interface ProfileProposal {
  /** The full proposed profile, keyed by section id (ready to diff + persist). */
  profile: Profile;
  /** A human-readable note on what changed, shown above the diff. */
  summary: string;
}

const FIELD_BY_SECTION: Record<ProfileSectionId, keyof ProfileProposalRaw> = {
  "about-me": "aboutMe",
  "work-context": "workContext",
  "key-projects": "keyProjects",
  "focus-rules": "focusRules",
};

function toProfile(raw: ProfileProposalRaw): Profile {
  const profile = {} as Profile;
  for (const section of PROFILE_SECTIONS) {
    profile[section.id] = (raw[FIELD_BY_SECTION[section.id]] ?? "").trim();
  }
  return profile;
}

/** Render the current profile so the model edits it rather than starting blank. */
function renderCurrentProfile(profile: Profile): string {
  const blocks = PROFILE_SECTIONS.map((section) => {
    const content = profile[section.id]?.trim();
    return `## ${section.title} (${FIELD_BY_SECTION[section.id]})\n${content || "(empty)"}`;
  });
  return blocks.join("\n\n");
}

const SYSTEM_PROMPT = `You curate the user profile for MeOS, a personal second brain. The profile is the *lens* the system uses to decide what matters in everything the user captures.

The profile has four sections, returned as fields:
- aboutMe — who the user is: role, background, expertise, how they work.
- workContext — current work and mission, the key people and organisations, and current goals.
- keyProjects — the projects that matter most right now (a markdown list is ideal: name — what it is, status, why it matters).
- focusRules — what MeOS should prioritise and what it should ignore.

Rules:
- Return the COMPLETE profile every time (all four fields), not just the parts you changed — unchanged sections must be returned verbatim.
- Write in the first person, concise and concrete. Markdown is fine (lists, short paragraphs). No headings inside a field — the section titles are added by the system.
- Ground everything in what the user has told you (current profile + any provided documents/instruction). Never invent facts, employers, projects, or goals.
- If a section has nothing to say, return an empty string for it — never pad.
- "summary" is one or two sentences describing what you changed and why.`;

/**
 * Propose a profile drafted (or updated) from uploaded context documents — an
 * onboarding doc, a project overview, a mission brief, an "about me" note. The
 * existing profile is preserved and extended, not discarded.
 */
export async function draftProfileFromContext(deps: {
  llm: LlmClient;
  currentProfile: Profile;
  /** Parsed text of the uploaded context documents, each with a title. */
  documents: Array<{ title: string; text: string }>;
}): Promise<ProfileProposal> {
  const { llm, currentProfile, documents } = deps;
  const docBlock = documents
    .map((d) => `### Document: ${d.title}\n${d.text}`)
    .join("\n\n");

  const raw = await llm.completeStructured({
    system: SYSTEM_PROMPT,
    schema: profileProposalSchema,
    schemaName: "profile_proposal",
    messages: [
      {
        role: "user",
        content: [
          "Here is the user's current profile:",
          "",
          renderCurrentProfile(currentProfile),
          "",
          "Extract profile-relevant context from the following document(s) and propose an updated profile. Keep everything already in the profile that the documents don't contradict; weave in the new context where it belongs.",
          "",
          docBlock || "(no documents provided)",
        ].join("\n"),
      },
    ],
  });

  return { profile: toProfile(raw), summary: raw.summary.trim() };
}

/**
 * Propose an initial profile inferred from the user's own knowledge base — the
 * wiki MeOS has already compiled. Rather than starting from a blank page, this
 * reads what the system knows about the user's projects, the organisations and
 * people around them, and recurring themes, and drafts a first-person profile
 * they can edit. The existing profile (if any) is preserved and extended.
 */
export async function draftProfileFromKnowledge(deps: {
  llm: LlmClient;
  currentProfile: Profile;
  /** A compiled summary of the wiki / knowledge base (entities, pages, themes). */
  knowledge: string;
}): Promise<ProfileProposal> {
  const { llm, currentProfile, knowledge } = deps;

  const raw = await llm.completeStructured({
    system: SYSTEM_PROMPT,
    schema: profileProposalSchema,
    schemaName: "profile_proposal",
    messages: [
      {
        role: "user",
        content: [
          "Here is the user's current profile:",
          "",
          renderCurrentProfile(currentProfile),
          "",
          "Below is everything MeOS has already learned about the user's world, compiled from their notes into a wiki. Infer a first-person profile FOR THE USER from it: their key projects, the organisations and people they work with, the goals and decisions that recur, and sensible focus rules. The wiki is written in the third person — translate it into a profile the user would write about themselves.",
          "Only state what the knowledge supports. If you cannot tell who the user is personally, keep 'aboutMe' light rather than inventing biography. Leave a section empty if there is nothing grounded to say.",
          "",
          knowledge || "(the knowledge base is empty)",
        ].join("\n"),
      },
    ],
  });

  return { profile: toProfile(raw), summary: raw.summary.trim() };
}

/**
 * Propose a profile edited per a natural-language instruction — "add that I'm
 * focused on local-first AI tools", "make the work context more concise",
 * "remove the part about KAIST", "extract the key projects from this document".
 * Optional uploadedContext lets an instruction reference a document.
 */
export async function editProfileWithInstruction(deps: {
  llm: LlmClient;
  currentProfile: Profile;
  instruction: string;
  uploadedContext?: string;
}): Promise<ProfileProposal> {
  const { llm, currentProfile, instruction, uploadedContext } = deps;

  const raw = await llm.completeStructured({
    system: SYSTEM_PROMPT,
    schema: profileProposalSchema,
    schemaName: "profile_proposal",
    messages: [
      {
        role: "user",
        content: [
          "Here is the user's current profile:",
          "",
          renderCurrentProfile(currentProfile),
          "",
          uploadedContext ? `Reference context the instruction may draw on:\n${uploadedContext}\n` : "",
          `Apply this instruction and return the complete updated profile:\n"${instruction}"`,
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });

  return { profile: toProfile(raw), summary: raw.summary.trim() };
}

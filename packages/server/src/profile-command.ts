import {
  editProfileWithInstruction,
  loadProfile,
  PROFILE_SECTIONS,
  saveProfileSection,
} from "@meos/core";
import type { AppContext } from "./context.js";

/**
 * The `/profile` chat slash command: the user edits their profile lens
 * conversationally — "/profile add that I'm focused on local-first AI tools" —
 * and MeOS applies the change and reports what it updated. The edit is audited
 * and every section keeps a restorable version history, so applying directly
 * (rather than a separate review step) stays safe and reversible.
 */

export function isProfileCommand(message: string): boolean {
  return /^\/profile\b/i.test(message.trim());
}

type Send = (event: { type: string; text?: string }) => void;

export async function runProfileCommand(
  ctx: AppContext,
  conversationId: number,
  message: string,
  send: Send,
): Promise<void> {
  const trimmed = message.trim();
  const instruction = trimmed.replace(/^\/profile\b/i, "").trim();

  // Persist the command so the conversation reads coherently after a reload.
  const firstTurn = ctx.store.listMessages(conversationId).length === 0;
  ctx.store.addMessage(conversationId, "user", trimmed);
  if (firstTurn) ctx.store.setConversationTitle(conversationId, "Profile update");

  const reply = instruction ? await applyInstruction(ctx, instruction) : usageMessage(ctx);

  send({ type: "delta", text: reply });
  ctx.store.addMessage(conversationId, "assistant", reply);
}

/** Delimiters the chat UI looks for to render the change as a real diff + action. */
export const PROFILE_DIFF_OPEN = "@@PROFILE_DIFF@@";
export const PROFILE_DIFF_CLOSE = "@@END@@";

/**
 * A minimal unified `git` patch between two blocks — common prefix/suffix lines
 * trimmed, the changed middle shown removed-then-added. Mirrors the web
 * DiffView's expected format so the chat can render the edit with red/green.
 */
function buildPatch(label: string, before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const lines = [`diff --git a/${label} b/${label}`, "@@ @@"];
  for (let i = Math.max(0, start - 1); i < start; i++) lines.push(` ${a[i]}`);
  for (let i = start; i < endA; i++) lines.push(`-${a[i]}`);
  for (let i = start; i < endB; i++) lines.push(`+${b[i]}`);
  return lines.join("\n");
}

async function applyInstruction(ctx: AppContext, instruction: string): Promise<string> {
  const dataDir = ctx.config.dataDir;
  const current = loadProfile(dataDir);
  const { profile, summary } = await editProfileWithInstruction({
    llm: ctx.llm,
    currentProfile: current,
    instruction,
  });

  const applied: string[] = [];
  const patches: string[] = [];
  for (const section of PROFILE_SECTIONS) {
    const next = profile[section.id];
    if (typeof next !== "string") continue;
    if (next.trim() === (current[section.id] ?? "").trim()) continue;
    patches.push(buildPatch(section.title, current[section.id] ?? "", next.trim()));
    saveProfileSection(dataDir, section.id, next);
    applied.push(section.title);
  }

  if (applied.length === 0) {
    return `I didn't change anything — your profile already reflects that.${summary ? `\n\n${summary}` : ""}`;
  }

  ctx.store.logAudit(
    "profile_edit",
    JSON.stringify({ action: "chat_edit", instruction, sections: applied }),
  );
  // The summary renders as prose; the diff block is parsed out by the chat UI
  // and shown as a red/green diff with a button to open the full profile.
  return [
    summary || `Updated ${applied.join(", ")}.`,
    "",
    PROFILE_DIFF_OPEN,
    patches.join("\n"),
    PROFILE_DIFF_CLOSE,
  ].join("\n");
}

function usageMessage(ctx: AppContext): string {
  const profile = loadProfile(ctx.config.dataDir);
  const filled = PROFILE_SECTIONS.filter((s) => profile[s.id]?.trim()).map((s) => s.title);
  return [
    "Tell me what to change about your profile and I'll update it. For example:",
    "",
    "- `/profile add that I'm focused on local-first AI tools`",
    "- `/profile make the work context more concise`",
    "- `/profile remove the part about KAIST`",
    "",
    filled.length > 0
      ? `Your profile currently covers: ${filled.join(", ")}.`
      : "Your profile is empty — give me an instruction, or generate a first draft from your wiki in Settings → Profile.",
  ].join("\n");
}

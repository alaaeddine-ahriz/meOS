import type { Block } from "../parse.js";
import { BlockBuilder } from "./builder.js";

interface EmailMeta {
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  date?: string;
}

/**
 * Build blocks for one parsed email message: a heading block carrying the
 * From/To/Subject/Date metadata, then paragraph blocks for the body (split on
 * blank lines). `messageIndex` distinguishes messages inside an .mbox.
 */
function blocksForMessage(
  meta: EmailMeta,
  body: string,
  messageIndex: number,
  push: (block: Omit<Block, "id" | "charStart" | "charEnd">) => void,
): void {
  const headerLines = [
    meta.subject ? `Subject: ${meta.subject}` : undefined,
    meta.from ? `From: ${meta.from}` : undefined,
    meta.to ? `To: ${meta.to}` : undefined,
    meta.cc ? `Cc: ${meta.cc}` : undefined,
    meta.date ? `Date: ${meta.date}` : undefined,
  ].filter((l): l is string => Boolean(l));

  const headingText = headerLines.join("\n") || `Message ${messageIndex + 1}`;
  push({
    type: "heading",
    text: headingText,
    headingPath: [],
    meta: { level: 1, message: messageIndex, email: { ...meta } },
  });

  const headingPath = meta.subject ? [meta.subject] : [];
  const paragraphs = body
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  for (const para of paragraphs) {
    push({
      type: "paragraph",
      text: para,
      headingPath,
      meta: { message: messageIndex },
    });
  }
}

function addrText(value: unknown): string | undefined {
  if (!value) return undefined;
  if (Array.isArray(value)) {
    const parts = value.map((v) => addrText(v)).filter(Boolean);
    return parts.length ? parts.join(", ") : undefined;
  }
  const obj = value as { text?: string };
  return obj.text || undefined;
}

/** Project a parsed mailparser message down to our {@link EmailMeta} fields. */
function metaFromMail(mail: {
  from?: unknown;
  to?: unknown;
  cc?: unknown;
  subject?: string;
  date?: Date;
}): EmailMeta {
  return {
    from: addrText(mail.from),
    to: addrText(mail.to),
    cc: addrText(mail.cc),
    subject: mail.subject || undefined,
    date: mail.date ? mail.date.toISOString() : undefined,
  };
}

/**
 * Parse a single RFC-822 email (.eml). Headers (From/To/Cc/Subject/Date) become
 * a metadata heading block and the body is split into paragraph blocks. All
 * email metadata is preserved in `meta.email`. Deterministic: the parse is a
 * pure function of the bytes (the only volatile value, Date, is rendered as a
 * stable ISO string from the message's own header).
 */
export async function parseEml(buffer: Buffer): Promise<{ text: string; blocks: Block[] }> {
  const { simpleParser } = await import("mailparser");
  const mail = await simpleParser(buffer);
  return assemble([{ meta: metaFromMail(mail), body: mail.text ?? "" }]);
}

/**
 * Parse a Unix mbox into one logical document, splitting on the "From "
 * separator lines and emitting a heading + body blocks per message. Each
 * message carries its `meta.message` index. Determinism holds for the same
 * reason as {@link parseEml}.
 */
export async function parseMbox(buffer: Buffer): Promise<{ text: string; blocks: Block[] }> {
  const { simpleParser } = await import("mailparser");
  const raw = buffer.toString("utf-8");
  // mbox messages are separated by lines beginning with "From " at column 0.
  const rawMessages = raw
    .split(/\r?\n(?=From )/)
    .map((m) => m.replace(/^From .*\r?\n/, ""))
    .filter((m) => m.trim().length > 0);

  const parsed: Array<{ meta: EmailMeta; body: string }> = [];
  for (const rawMsg of rawMessages) {
    const mail = await simpleParser(Buffer.from(rawMsg));
    parsed.push({ meta: metaFromMail(mail), body: mail.text ?? "" });
  }
  return assemble(parsed);
}

function assemble(messages: Array<{ meta: EmailMeta; body: string }>): {
  text: string;
  blocks: Block[];
} {
  const builder = new BlockBuilder();
  messages.forEach(({ meta, body }, i) =>
    blocksForMessage(meta, body, i, (block) => builder.push(block)),
  );
  return builder.result();
}

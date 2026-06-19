/** Tiny lenient JSON accessors shared by the stream adapters. */
export type Rec = Record<string, unknown>;

export function parseLine(line: string): Rec | null {
  const text = line.trim();
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return obj(parsed);
  } catch {
    // Non-JSON noise (warnings/progress) can leak to stdout — ignore it.
    return null;
  }
}

export function obj(value: unknown): Rec | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Rec)
    : null;
}
export function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Render an arbitrary tool/command output value as text. */
export function asText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .map((raw) => {
        const block = obj(raw);
        return block?.type === "text" ? str(block.text) : undefined;
      })
      .filter((t): t is string => Boolean(t));
    if (texts.length > 0) return texts.join("\n");
  }
  if (content === null || content === undefined) return "";
  try {
    return JSON.stringify(content) ?? "";
  } catch {
    return "[unserializable output]";
  }
}

import { useMemo } from "react";
import { cn } from "@/lib/utils";

type LineType = "add" | "del" | "hunk" | "context";

interface DiffLine {
  type: LineType;
  text: string;
}

interface DiffFileBlock {
  path: string;
  lines: DiffLine[];
}

/** Pull the b-side path from a `diff --git a/x b/x` header. */
function headerPath(line: string): string {
  const match = line.match(/ b\/(.+)$/);
  return match ? match[1]! : line.replace(/^diff --git /, "");
}

/** Parse a unified `git` diff into per-file blocks of typed lines. */
function parseDiff(patch: string): DiffFileBlock[] {
  const files: DiffFileBlock[] = [];
  let current: DiffFileBlock | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git")) {
      current = { path: headerPath(line), lines: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    // File-level metadata that adds noise to a prose diff.
    if (
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("similarity index") ||
      line.startsWith("rename ")
    ) {
      continue;
    }
    if (line.startsWith("@@")) {
      current.lines.push({ type: "hunk", text: line });
    } else if (line.startsWith("+")) {
      current.lines.push({ type: "add", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      current.lines.push({ type: "del", text: line.slice(1) });
    } else {
      current.lines.push({ type: "context", text: line.startsWith(" ") ? line.slice(1) : line });
    }
  }
  return files;
}

const LINE_STYLE: Record<LineType, string> = {
  add: "bg-moss/10 text-moss",
  del: "bg-ember/10 text-ember",
  hunk: "mt-2 text-dim",
  context: "text-faded",
};

const PREFIX: Record<LineType, string> = { add: "+", del: "-", hunk: "", context: " " };

/**
 * Render a unified git diff in the app's mono style. When the patch spans
 * several files each gets a small path header; pass `showPaths={false}` to hide
 * them when the surrounding UI already lists the files.
 */
export function DiffView({ patch, showPaths = true }: { patch: string; showPaths?: boolean }) {
  const files = useMemo(() => parseDiff(patch), [patch]);

  if (files.length === 0 || files.every((f) => f.lines.length === 0)) {
    return <p className="text-sm text-dim">No textual changes.</p>;
  }

  return (
    <div className="overflow-hidden rounded-md border border-line">
      {files.map((file, fileIndex) => (
        <div key={fileIndex} className={cn(fileIndex > 0 && "border-t border-line")}>
          {showPaths && (
            <div className="bg-card px-3 py-1.5 font-mono text-[11px] text-dim">{file.path}</div>
          )}
          <pre className="overflow-x-auto py-1 font-mono text-[12px] leading-relaxed">
            {file.lines.map((line, i) => (
              <div key={i} className={cn("px-3 whitespace-pre-wrap", LINE_STYLE[line.type])}>
                {line.type === "hunk" ? line.text : `${PREFIX[line.type]} ${line.text}`}
              </div>
            ))}
          </pre>
        </div>
      ))}
    </div>
  );
}

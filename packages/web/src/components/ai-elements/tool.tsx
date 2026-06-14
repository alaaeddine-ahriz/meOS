"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

/** Lifecycle of a tool call, mirroring the AI SDK's tool-part states. */
export type ToolState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error";

export type ToolProps = ComponentProps<typeof Collapsible>;

/** A collapsible IDE-style block for one tool call: header + input + output. */
export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn("not-prose mb-2 w-full rounded-lg border border-border bg-muted/40", className)}
    {...props}
  />
);

const STATE_LABEL: Record<ToolState, string> = {
  "input-streaming": "Calling",
  "input-available": "Running",
  "output-available": "Done",
  "output-error": "Error",
};

const STATE_ICON: Record<ToolState, ReactNode> = {
  "input-streaming": <CircleIcon className="size-3.5 animate-pulse text-muted-foreground" />,
  "input-available": <ClockIcon className="size-3.5 animate-pulse text-muted-foreground" />,
  "output-available": <CheckCircle2Icon className="size-3.5 text-foreground" />,
  "output-error": <XCircleIcon className="size-3.5 text-destructive" />,
};

export type ToolHeaderProps = {
  /** Display name for the tool (humanised by the caller). */
  title: ReactNode;
  state: ToolState;
  className?: string;
};

export const ToolHeader = ({ title, state, className }: ToolHeaderProps) => (
  <CollapsibleTrigger
    className={cn(
      "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/60",
      className,
    )}
  >
    <WrenchIcon className="size-3.5 shrink-0 text-muted-foreground" />
    <span className="min-w-0 flex-1 truncate font-medium text-foreground">{title}</span>
    <span className="flex shrink-0 items-center gap-1 text-muted-foreground text-xs">
      {STATE_ICON[state]}
      {STATE_LABEL[state]}
    </span>
    <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform [[data-state=open]_&]:rotate-180" />
  </CollapsibleTrigger>
);

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "space-y-2 border-t border-border px-3 py-2 text-xs",
      "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=open]:animate-in",
      className,
    )}
    {...props}
  />
);

/** The tool's input arguments, shown as compact JSON. */
export const ToolInput = ({ input }: { input: unknown }) => (
  <div>
    <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Input</p>
    <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-background/60 p-2 font-mono text-[11px] text-foreground">
      {formatValue(input)}
    </pre>
  </div>
);

/** The tool's result (truncated, scrollable), or an error string. */
export const ToolOutput = ({ output, errorText }: { output?: unknown; errorText?: string }) => {
  if (output === undefined && !errorText) return null;
  return (
    <div>
      <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {errorText ? "Error" : "Output"}
      </p>
      <pre
        className={cn(
          "max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-background/60 p-2 font-mono text-[11px] leading-relaxed",
          errorText ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {errorText ?? formatValue(output)}
      </pre>
    </div>
  );
};

/** Render strings as-is, everything else as pretty JSON. */
function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

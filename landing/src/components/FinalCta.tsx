import { ArrowRight, Github } from "lucide-react";
import { REPO_URL } from "../lib/site.ts";

export function FinalCta() {
  return (
    <section className="px-5 py-20 text-center sm:px-8">
      <h2 className="mx-auto max-w-2xl text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
        Start your second brain.
      </h2>
      <p className="mx-auto mt-4 max-w-md text-muted">
        Clone it, add your LLM key, and start feeding it. It's free and open source.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 rounded-md bg-accent px-6 py-3 text-sm font-medium text-bg transition-opacity hover:opacity-90"
        >
          Get started
          <ArrowRight className="size-4" />
        </a>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 rounded-md border border-border bg-surface px-6 py-3 text-sm font-medium text-text transition-colors hover:border-accent-soft"
        >
          <Github className="size-4" />
          Star on GitHub
        </a>
      </div>
    </section>
  );
}

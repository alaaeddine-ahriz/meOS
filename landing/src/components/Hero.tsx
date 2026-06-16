import { ArrowRight, Github } from "lucide-react";
import { REPO_URL } from "../lib/site.ts";
import { HeroVisual } from "./HeroVisual.tsx";

export function Hero() {
  return (
    <section className="grid grid-cols-1 lg:grid-cols-2">
      {/* left — copy */}
      <div className="rise flex flex-col justify-center border-b border-border px-5 py-16 sm:px-8 lg:border-r lg:border-b-0 lg:py-24">
        <p className="mb-5 inline-flex w-fit items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-muted">
          <span className="size-1.5 rounded-full bg-accent" />
          Local-first · Open source
        </p>

        <h1 className="text-balance text-5xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
          Remember everything.
          <br />
          <span className="text-accent">Just ask.</span>
        </h1>

        <p className="mt-6 max-w-md text-lg leading-relaxed text-muted">
          meOS turns the notes, emails, and files you capture into a personal knowledge base — then
          answers questions about your life and work in plain language.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-bg transition-opacity hover:opacity-90"
          >
            Get started
            <ArrowRight className="size-4" />
          </a>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-md border border-border bg-surface px-5 py-2.5 text-sm font-medium text-text transition-colors hover:border-accent-soft"
          >
            <Github className="size-4" />
            View on GitHub
          </a>
        </div>
      </div>

      {/* right — "everything feeds one brain" */}
      <div className="relative flex items-center justify-center overflow-hidden px-8 py-16 lg:py-0">
        <HeroVisual />
      </div>
    </section>
  );
}

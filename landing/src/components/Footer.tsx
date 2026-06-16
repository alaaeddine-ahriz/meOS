import { Github } from "lucide-react";
import { REPO_URL, SITE_NAME, TAGLINE } from "../lib/site.ts";
import { Logo } from "./Logo.tsx";

export function Footer() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <div>
          <div className="flex items-center gap-2.5 text-text">
            <Logo className="size-5 text-accent" />
            <span className="font-semibold">{SITE_NAME}</span>
          </div>
          <p className="mt-2 text-sm text-muted">{TAGLINE}</p>
        </div>

        <div className="flex items-center gap-5 text-sm text-muted">
          <a href="#features" className="transition-colors hover:text-text">
            Features
          </a>
          <a href="#faq" className="transition-colors hover:text-text">
            FAQ
          </a>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 transition-colors hover:text-text"
          >
            <Github className="size-4" />
            GitHub
          </a>
        </div>
      </div>
      <div className="border-t border-border px-5 py-5 text-center text-xs text-dim sm:px-8">
        © {SITE_NAME}. Open source · Local-first.
      </div>
    </footer>
  );
}

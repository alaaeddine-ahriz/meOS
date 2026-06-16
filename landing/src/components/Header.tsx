import { Github, Moon, Sun } from "lucide-react";
import { useTheme } from "../lib/useTheme.ts";
import { REPO_URL, SITE_NAME } from "../lib/site.ts";
import { Logo } from "./Logo.tsx";

export function Header() {
  const { theme, toggle } = useTheme();

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-bg/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
        <a href="#top" className="flex items-center gap-2.5 text-text">
          <Logo className="size-6 text-accent" />
          <span className="text-lg font-semibold tracking-tight">{SITE_NAME}</span>
        </a>

        <nav className="flex items-center gap-1 sm:gap-2">
          <a
            href="#features"
            className="hidden rounded-md px-3 py-2 text-sm text-muted transition-colors hover:text-text sm:block"
          >
            Features
          </a>
          <a
            href="#faq"
            className="hidden rounded-md px-3 py-2 text-sm text-muted transition-colors hover:text-text sm:block"
          >
            FAQ
          </a>

          <button
            type="button"
            onClick={toggle}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            className="grid size-9 place-items-center rounded-md text-muted transition-colors hover:bg-surface hover:text-text"
          >
            {theme === "dark" ? <Sun className="size-4.5" /> : <Moon className="size-4.5" />}
          </button>

          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="View meOS on GitHub"
            className="grid size-9 place-items-center rounded-md text-muted transition-colors hover:bg-surface hover:text-text"
          >
            <Github className="size-4.5" />
          </a>

          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="ml-1 rounded-md bg-accent px-3.5 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90"
          >
            Get started
          </a>
        </nav>
      </div>
    </header>
  );
}

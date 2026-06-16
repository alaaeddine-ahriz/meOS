import { BookOpen, Inbox, MessagesSquare, Share2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";

const FEATURES: Array<{ icon: LucideIcon; title: string; body: string }> = [
  {
    icon: Inbox,
    title: "Capture everything",
    body: "Drop in notes, files, links, and stray thoughts. No folders, no tags, no filing — just throw it in.",
  },
  {
    icon: Share2,
    title: "It connects the dots",
    body: "An LLM pulls out entities, relationships, and facts with confidence. Your knowledge base compounds as you go.",
  },
  {
    icon: BookOpen,
    title: "A wiki you never write",
    body: "meOS keeps a living wiki of your world up to date for you. You read it — you never have to edit it.",
  },
  {
    icon: MessagesSquare,
    title: "Ask your own life",
    body: "Chat with everything you've ever captured and get answers grounded in your own context, with sources.",
  },
];

export function Features() {
  return (
    <section id="features" className="border-b border-border">
      <div className="border-b border-border px-5 py-12 sm:px-8">
        <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          A brain that files itself
        </h2>
        <p className="mt-3 max-w-xl text-muted">Four things meOS does so you don't have to.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2">
        {FEATURES.map(({ icon: Icon, title, body }, i) => (
          <div
            key={title}
            className={
              "group px-5 py-10 transition-colors hover:bg-bg-soft sm:px-8 " +
              // borders that build a clean 2×2 grid
              (i % 2 === 0 ? "sm:border-r border-border " : "") +
              (i < 2 ? "border-b border-border" : "")
            }
          >
            <div className="mb-4 grid size-11 place-items-center rounded-lg border border-border bg-surface text-accent transition-colors group-hover:border-accent-soft">
              <Icon className="size-5" />
            </div>
            <h3 className="text-lg font-semibold">{title}</h3>
            <p className="mt-2 max-w-sm leading-relaxed text-muted">{body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

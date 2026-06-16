import type { ReactNode } from "react";
import { AnyToolLogo, ECOSYSTEM, type LogoItem, PROVIDERS } from "../lib/logos.tsx";

function Pill({ name, children, dashed }: { name: string; children: ReactNode; dashed?: boolean }) {
  return (
    <div
      className={
        "group flex items-center gap-2.5 rounded-lg border bg-surface px-4 py-3 transition-colors hover:border-accent-soft " +
        (dashed ? "border-dashed border-line" : "border-border")
      }
    >
      {/* text-text keeps the few currentColor marks (OpenAI, Local) crisp;
          coloured brand glyphs set their own fill and ignore it. */}
      <span className="size-5 text-text">{children}</span>
      <span className="text-sm font-medium text-muted transition-colors group-hover:text-text">
        {name}
      </span>
    </div>
  );
}

function PillRow({ items, extra }: { items: LogoItem[]; extra?: ReactNode }) {
  return (
    <div className="mt-8 flex flex-wrap gap-3">
      {items.map(({ name, Logo }) => (
        <Pill key={name} name={name}>
          <Logo />
        </Pill>
      ))}
      {extra}
    </div>
  );
}

export function Providers() {
  return (
    <section className="border-b border-border px-5 py-14 sm:px-8">
      <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">Bring your own provider</h2>
      <p className="mt-3 max-w-xl text-muted">
        Plug in whichever model you trust — or run one locally. No lock-in, no markup.
      </p>
      <PillRow items={PROVIDERS} />
    </section>
  );
}

export function Ecosystem() {
  return (
    <section className="border-b border-border px-5 py-14 sm:px-8">
      <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">Connect your ecosystem</h2>
      <p className="mt-3 max-w-xl text-muted">
        Pull in what matters from the tools you already live in — or connect anything else.
      </p>
      <PillRow
        items={ECOSYSTEM}
        extra={
          <Pill name="Any tool" dashed>
            <span className="text-accent">
              <AnyToolLogo />
            </span>
          </Pill>
        }
      />
    </section>
  );
}

const STEPS = [
  {
    n: "01",
    title: "Feed it",
    body: "Send meOS anything — a note, a doc, a link, a half-formed idea.",
  },
  {
    n: "02",
    title: "It understands",
    body: "meOS reads it, updates your knowledge base, and rewrites the wiki.",
  },
  {
    n: "03",
    title: "You ask",
    body: "Chat with your second brain and get answers from your own context.",
  },
];

export function Steps() {
  return (
    <section className="border-b border-border px-5 py-14 sm:px-8">
      <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">How it works</h2>
      <div className="mt-10 grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3">
        {STEPS.map((s) => (
          <div key={s.n} className="bg-bg px-6 py-8">
            <span className="font-mono text-sm text-accent">{s.n}</span>
            <h3 className="mt-3 text-lg font-semibold">{s.title}</h3>
            <p className="mt-2 leading-relaxed text-muted">{s.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

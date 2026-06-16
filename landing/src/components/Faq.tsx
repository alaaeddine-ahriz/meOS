const FAQS = [
  {
    q: "Where does my data live?",
    a: "Local-first. meOS runs on your machine and keeps everything in a local database. You bring your own LLM key.",
  },
  {
    q: "Which LLMs does it support?",
    a: "Anthropic, OpenAI, Google, OpenRouter, or a local model. Pick a provider and model in Settings and paste your API key.",
  },
  {
    q: "Do I have to organise anything?",
    a: "No. That's the whole point — capture everything, organise nothing. meOS does the filing for you.",
  },
  {
    q: "Is it open source?",
    a: "Yes. The full source is on GitHub under an open license — read it, run it, fork it.",
  },
  {
    q: "Is there a desktop app?",
    a: "Yes. There's a native desktop build (Tauri) that runs offline, plus the web app.",
  },
];

export function Faq() {
  return (
    <section id="faq" className="border-b border-border px-5 py-14 sm:px-8">
      <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">Questions</h2>
      <div className="mt-8 max-w-2xl divide-y divide-border border-y border-border">
        {FAQS.map((item) => (
          <details key={item.q} className="group py-4">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
              {item.q}
              <span className="text-dim transition-transform group-open:rotate-45">+</span>
            </summary>
            <p className="mt-2 max-w-xl leading-relaxed text-muted">{item.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

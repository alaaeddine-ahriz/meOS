import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type EntitySummary } from "../api.js";

interface PaletteItem {
  label: string;
  hint: string;
  to: string;
}

const VIEWS: PaletteItem[] = [
  { label: "Chat", hint: "view", to: "/" },
  { label: "Wiki", hint: "view", to: "/wiki" },
  { label: "Inbox", hint: "view", to: "/inbox" },
  { label: "Digest", hint: "view", to: "/digest" },
];

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [entities, setEntities] = useState<EntitySummary[]>([]);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    inputRef.current?.focus();
    api.listEntities().then((r) => setEntities(r.entities)).catch(() => {});
  }, []);

  const items = useMemo(() => {
    const all: PaletteItem[] = [
      ...VIEWS,
      ...entities.map((e) => ({ label: e.name, hint: e.type, to: `/wiki/${e.slug}` })),
    ];
    const q = query.trim().toLowerCase();
    return (q ? all.filter((item) => item.label.toLowerCase().includes(q)) : all).slice(0, 12);
  }, [query, entities]);

  useEffect(() => setSelected(0), [query]);

  const choose = (item: PaletteItem | undefined) => {
    if (!item) return;
    navigate(item.to);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-ink/70 backdrop-blur-[2px]" onClick={onClose}>
      <div
        className="rise mx-auto mt-[18vh] w-[480px] overflow-hidden rounded-xl border border-line bg-desk shadow-2xl shadow-black/60"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") setSelected((s) => Math.min(s + 1, items.length - 1));
            else if (event.key === "ArrowUp") setSelected((s) => Math.max(s - 1, 0));
            else if (event.key === "Enter") choose(items[selected]);
          }}
          placeholder="Jump to a view or wiki page..."
          className="w-full border-b border-line bg-transparent px-4 py-3 text-sm text-paper outline-none placeholder:text-dim"
        />
        <ul className="max-h-72 overflow-y-auto py-1">
          {items.map((item, index) => (
            <li key={item.to + item.label}>
              <button
                onMouseEnter={() => setSelected(index)}
                onClick={() => choose(item)}
                className={`flex w-full items-baseline justify-between px-4 py-2 text-left text-sm ${
                  index === selected ? "bg-card text-paper" : "text-faded"
                }`}
              >
                <span>{item.label}</span>
                <span className="font-mono text-[10px] uppercase tracking-wider text-dim">{item.hint}</span>
              </button>
            </li>
          ))}
          {items.length === 0 && <li className="px-4 py-3 text-sm text-dim">Nothing matches.</li>}
        </ul>
      </div>
    </div>
  );
}

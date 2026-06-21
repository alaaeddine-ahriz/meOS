import { Extension, type Editor, type Range } from "@tiptap/core";
import Suggestion, { type SuggestionOptions } from "@tiptap/suggestion";
// Type-only: loads @tiptap/extension-table's command augmentations (insertTable,
// …) so the typed `editor.chain()` below knows the table commands the editor
// registers via TableKit. No runtime cost — the extension is bundled already.
import type {} from "@tiptap/extension-table";

/** One entry in the `/` block menu. */
export interface SlashItem {
  title: string;
  /** Inline SVG markup (uses `currentColor`) shown to the left of the title. */
  icon: string;
  /** Words that also match this item when filtering the menu. */
  keywords?: string[];
  /** Apply the block transform, after the typed `/query` has been removed. */
  run: (ctx: { editor: Editor; range: Range }) => void;
}

// Lucide-style glyphs, kept inline so the menu has no icon-component dependency.
const icon = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const ICONS = {
  paragraph: icon(
    '<path d="M13 4v16"/><path d="M17 4v16"/><path d="M19 4H9.5a4.5 4.5 0 0 0 0 9H13"/>',
  ),
  h1: icon('<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="m17 12 3-2v8"/>'),
  h2: icon(
    '<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1"/>',
  ),
  h3: icon(
    '<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M17.5 10.5c1.7-1 3.5 0 3.5 1.5a2 2 0 0 1-2 2"/><path d="M17 17.5c2 1.5 4 .3 4-1.5a2 2 0 0 0-2-2"/>',
  ),
  table: icon(
    '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/>',
  ),
  check: icon(
    '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
  ),
  ordered: icon(
    '<path d="M10 12h11"/><path d="M10 18h11"/><path d="M10 6h11"/><path d="M4 10h2"/><path d="M4 6h1v4"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
  ),
  bullet: icon(
    '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  ),
  quote: icon(
    '<path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2 1 1 0 0 1 1-1V4a1 1 0 0 0-1-1z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2 1 1 0 0 1 1-1V4a1 1 0 0 0-1-1z"/>',
  ),
  meeting: icon(
    '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="m9 16 2 2 4-4"/>',
  ),
};

/** The block options offered by the `/` menu, in display order. */
export const SLASH_ITEMS: SlashItem[] = [
  {
    title: "Paragraph",
    icon: ICONS.paragraph,
    keywords: ["text", "plain", "body"],
    run: ({ editor, range }) => editor.chain().focus().deleteRange(range).setParagraph().run(),
  },
  {
    title: "Heading 1",
    icon: ICONS.h1,
    keywords: ["title", "h1", "big"],
    run: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode("heading", { level: 1 }).run(),
  },
  {
    title: "Heading 2",
    icon: ICONS.h2,
    keywords: ["subtitle", "h2"],
    run: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode("heading", { level: 2 }).run(),
  },
  {
    title: "Heading 3",
    icon: ICONS.h3,
    keywords: ["h3"],
    run: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode("heading", { level: 3 }).run(),
  },
  {
    title: "Table",
    icon: ICONS.table,
    keywords: ["grid", "rows", "columns"],
    run: ({ editor, range }) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run(),
  },
  {
    title: "Check List",
    icon: ICONS.check,
    keywords: ["todo", "task", "checkbox"],
    run: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleTaskList().run(),
  },
  {
    title: "Numbered List",
    icon: ICONS.ordered,
    keywords: ["ordered", "ol", "1."],
    run: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    title: "Bulleted List",
    icon: ICONS.bullet,
    keywords: ["unordered", "ul", "bullet"],
    run: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    title: "Quote",
    icon: ICONS.quote,
    keywords: ["blockquote", "citation"],
    run: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
];

function filterItems(query: string, items: SlashItem[]): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (it) => it.title.toLowerCase().includes(q) || it.keywords?.some((k) => k.includes(q)),
  );
}

/** Options the host view supplies to the slash menu. */
export interface SlashCommandOptions {
  /** Apply a named document template (currently just the meeting front matter). */
  onApplyTemplate: (name: "meeting") => void;
}

/**
 * The Notion-style `/` menu. Typing `/` at the start of an empty block opens a
 * list of block types; picking one removes the trigger text and applies the
 * transform. Rendered with plain DOM (no extra deps), mirroring the `@mention`
 * popup so the two menus stay visually consistent. A leading "Meeting note" item
 * drops the meeting template — it doesn't transform a block, it asks the host
 * view to set the note's front matter (type: meeting, today's date).
 */
export const SlashCommand = Extension.create<SlashCommandOptions>({
  name: "slashCommand",

  addOptions() {
    return { onApplyTemplate: () => {} };
  },

  addProseMirrorPlugins() {
    const onApplyTemplate = this.options.onApplyTemplate;
    const meetingItem: SlashItem = {
      title: "Meeting note",
      icon: ICONS.meeting,
      keywords: ["meeting", "template", "standup", "1:1", "agenda"],
      run: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).run();
        onApplyTemplate("meeting");
      },
    };
    const items = [meetingItem, ...SLASH_ITEMS];
    return [
      Suggestion<SlashItem>({
        editor: this.editor,
        char: "/",
        // Only trigger at the start of a block, so `/` inside prose is left alone.
        startOfLine: true,
        items: ({ query }) => filterItems(query, items),
        command: ({ editor, range, props }) => props.run({ editor, range }),
        render: renderSlashMenu,
      } satisfies Omit<SuggestionOptions<SlashItem>, "editor"> & { editor: Editor }),
    ];
  },
});

/** Plain-DOM popup for the `/` menu — same shape as the `@mention` renderer. */
function renderSlashMenu(): ReturnType<NonNullable<SuggestionOptions<SlashItem>["render"]>> {
  let el: HTMLDivElement | null = null;
  let items: SlashItem[] = [];
  let active = 0;
  let pick: (item: SlashItem) => void = () => {};

  const paint = () => {
    if (!el) return;
    el.innerHTML = "";
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "slash-menu-empty";
      empty.textContent = "No matches";
      el.appendChild(empty);
      return;
    }
    items.forEach((item, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "slash-menu-item" + (i === active ? " is-active" : "");
      row.innerHTML = `<span class="slash-menu-icon">${item.icon}</span><span class="slash-menu-label"></span>`;
      row.querySelector(".slash-menu-label")!.textContent = item.title;
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        pick(item);
      });
      row.addEventListener("mousemove", () => {
        if (active === i) return;
        active = i;
        paint();
      });
      el!.appendChild(row);
    });
  };

  const scrollActiveIntoView = () => {
    el?.querySelector(".slash-menu-item.is-active")?.scrollIntoView({ block: "nearest" });
  };

  const place = (rect: DOMRect | null) => {
    if (!el || !rect) return;
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.bottom + 4}px`;
  };

  return {
    onStart: (props) => {
      document.querySelectorAll(".slash-menu").forEach((n) => n.remove());
      items = props.items;
      active = 0;
      pick = props.command;
      el = document.createElement("div");
      el.className = "slash-menu";
      document.body.appendChild(el);
      paint();
      place(props.clientRect?.() ?? null);
    },
    onUpdate: (props) => {
      items = props.items;
      active = Math.min(active, Math.max(0, items.length - 1));
      pick = props.command;
      paint();
      place(props.clientRect?.() ?? null);
    },
    onKeyDown: (props) => {
      const move = (delta: number) => {
        active = items.length ? (active + delta + items.length) % items.length : 0;
        paint();
        scrollActiveIntoView();
        return true;
      };
      if (props.event.key === "ArrowDown") return move(1);
      if (props.event.key === "ArrowUp") return move(-1);
      if (props.event.key === "Enter") {
        const selected = items[active];
        if (selected) pick(selected);
        return true;
      }
      if (props.event.key === "Escape") {
        el?.remove();
        el = null;
        return true;
      }
      return false;
    },
    onExit: () => {
      el?.remove();
      el = null;
    },
  };
}

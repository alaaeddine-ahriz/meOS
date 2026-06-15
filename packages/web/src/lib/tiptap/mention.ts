import { mergeAttributes, type Editor } from "@tiptap/core";
import Mention, { type MentionOptions } from "@tiptap/extension-mention";
import { Plugin } from "@tiptap/pm/state";
import type { SuggestionOptions } from "@tiptap/suggestion";

/** One thing an `@mention` can point at: another note, or a wiki entity. */
export interface LinkTarget {
  label: string;
  type: "note" | "wiki";
  /** Note path or wiki slug — used by the view to route. */
  target: string;
}

/** What a clicked chip resolves to, handed back to the view to navigate. */
export interface FollowTarget {
  kind: string;
  target: string;
  label: string;
}

interface MentionExtraOptions {
  onFollow: (target: FollowTarget) => void;
}

const MENTION_RE = /\[\[([^\]\n]+)\]\]/g;

/**
 * Obsidian-style mentions rendered as atomic "chips". Typing `@` opens an
 * autocomplete over the user's notes and the wiki; selecting one inserts a
 * pill the user can click to navigate. On disk each chip is stored as a plain
 * `[[Name]]` link, so notes stay portable and the backlink index keeps working;
 * {@link linkifyMentions} turns those links back into chips when a note loads.
 */
export const VaultMention = Mention.extend<MentionOptions & MentionExtraOptions>({
  name: "mention",

  addOptions() {
    return {
      ...this.parent?.(),
      onFollow: () => {},
    } as MentionOptions & MentionExtraOptions;
  },

  // Carry the resolved target on the node so a click navigates without guessing.
  addAttributes() {
    return {
      ...this.parent?.(),
      kind: {
        default: "new",
        parseHTML: (el) => el.getAttribute("data-kind"),
        renderHTML: (attrs) => ({ "data-kind": attrs.kind }),
      },
      target: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-target"),
        renderHTML: (attrs) => ({ "data-target": attrs.target }),
      },
    };
  },

  // Render the chip as just the label (no leading "@") inside a styled pill.
  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes({ "data-type": "mention" }, this.options.HTMLAttributes, HTMLAttributes),
      `${node.attrs.label ?? node.attrs.id ?? ""}`,
    ];
  },

  // Persist a chip to markdown as a bare `[[Name]]` wiki-link.
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize(
          state: { write: (text: string) => void },
          node: { attrs: { label?: string; id?: string } },
        ) {
          state.write(`[[${node.attrs.label ?? node.attrs.id ?? ""}]]`);
        },
      },
    };
  },

  addProseMirrorPlugins() {
    const onFollow = (this.options as MentionExtraOptions).onFollow;
    return [
      ...(this.parent?.() ?? []),
      new Plugin({
        props: {
          handleClickOn(_view, _pos, _node, _nodePos, event) {
            const el = (event.target as HTMLElement)?.closest(
              ".mention-chip",
            ) as HTMLElement | null;
            if (!el) return false;
            event.preventDefault();
            onFollow({
              kind: el.getAttribute("data-kind") || "new",
              target: el.getAttribute("data-target") || "",
              label: el.getAttribute("data-label") || el.textContent || "",
            });
            return true;
          },
        },
      }),
    ];
  },
});

/** Build the `@` suggestion config from the view's data source + insert command. */
export function mentionSuggestion(
  suggest: (query: string) => LinkTarget[],
): Partial<SuggestionOptions<LinkTarget>> {
  return {
    char: "@",
    items: ({ query }) => suggest(query),
    command: ({ editor, range, props }) => {
      editor
        .chain()
        .focus()
        .insertContentAt(range, [
          {
            type: "mention",
            attrs: {
              id: props.target || props.label,
              label: props.label,
              kind: props.type,
              target: props.target,
            },
          },
          { type: "text", text: " " },
        ])
        .run();
    },
    render: renderSuggestion,
  };
}

/**
 * Rewrite the `[[Name]]` links in a freshly-loaded note into mention chips,
 * resolving each to its note/wiki target so clicks route correctly. Runs once
 * on load (history-silent) before edits are tracked, so it never autosaves.
 */
export function linkifyMentions(
  editor: Editor,
  resolve: (label: string) => { kind: string; target: string } | null,
): void {
  const { state } = editor;
  const matches: Array<{ from: number; to: number; label: string }> = [];
  state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    for (const m of node.text.matchAll(MENTION_RE)) {
      const from = pos + m.index!;
      matches.push({ from, to: from + m[0].length, label: m[1]!.trim() });
    }
  });
  if (matches.length === 0) return;

  const tr = state.tr;
  // Apply back-to-front so earlier offsets stay valid as we splice.
  for (const match of matches.reverse()) {
    const info = resolve(match.label);
    const chip = state.schema.nodes.mention!.create({
      id: info?.target || match.label,
      label: match.label,
      kind: info?.kind ?? "new",
      target: info?.target ?? "",
    });
    tr.replaceWith(match.from, match.to, chip);
  }
  tr.setMeta("addToHistory", false);
  editor.view.dispatch(tr);
}

/** A minimal, dependency-free autocomplete popup for the `@` suggestion. */
function renderSuggestion(): ReturnType<NonNullable<SuggestionOptions<LinkTarget>["render"]>> {
  let el: HTMLDivElement | null = null;
  let items: LinkTarget[] = [];
  let active = 0;
  let pick: (item: LinkTarget) => void = () => {};

  const paint = () => {
    if (!el) return;
    el.innerHTML = "";
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mention-menu-empty";
      empty.textContent = "No matches";
      el.appendChild(empty);
      return;
    }
    items.forEach((item, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "mention-menu-item" + (i === active ? " is-active" : "");
      row.innerHTML = `<span class="mention-menu-kind">${item.type === "wiki" ? "wiki" : "note"}</span><span class="mention-menu-label"></span>`;
      row.querySelector(".mention-menu-label")!.textContent = item.label;
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        pick(item);
      });
      el!.appendChild(row);
    });
  };

  const place = (rect: DOMRect | null) => {
    if (!el || !rect) return;
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.bottom + 4}px`;
  };

  return {
    onStart: (props) => {
      document.querySelectorAll(".mention-menu").forEach((n) => n.remove());
      items = props.items;
      active = 0;
      pick = (item) => props.command(item);
      el = document.createElement("div");
      el.className = "mention-menu";
      document.body.appendChild(el);
      paint();
      place(props.clientRect?.() ?? null);
    },
    onUpdate: (props) => {
      items = props.items;
      active = 0;
      pick = (item) => props.command(item);
      paint();
      place(props.clientRect?.() ?? null);
    },
    onKeyDown: (props) => {
      if (props.event.key === "ArrowDown") {
        active = items.length ? (active + 1) % items.length : 0;
        paint();
        return true;
      }
      if (props.event.key === "ArrowUp") {
        active = items.length ? (active - 1 + items.length) % items.length : 0;
        paint();
        return true;
      }
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

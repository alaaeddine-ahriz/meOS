import { mergeAttributes, type Editor } from "@tiptap/core";
import Mention, { type MentionOptions } from "@tiptap/extension-mention";
import { Plugin } from "@tiptap/pm/state";
import type { SuggestionOptions } from "@tiptap/suggestion";

/** What an `@mention` can point at. */
export type MentionKind = "note" | "wiki" | "date" | "event";

/** One thing an `@mention` can point at: a note, a wiki entity, a date, or an event. */
export interface LinkTarget {
  label: string;
  type: MentionKind;
  /** Note path / wiki slug / ISO date / event deep-link — used by the view to route. */
  target: string;
  /**
   * Extra data a date or event carries so inserting it can drive a meeting's
   * front matter (set the date, prefill attendees). Ignored for note/wiki.
   */
  meta?: { date?: string; attendees?: string[] };
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
 * Decode the inner text of a `[[…]]` link into a chip's kind/target/label. Dates
 * persist as `[[date:YYYY-MM-DD]]` and events as `[[event:<deep-link>|Title]]`;
 * everything else is a plain note/wiki label resolved by the view.
 */
function parseMentionToken(inner: string): {
  kind?: "date" | "event";
  target?: string;
  label: string;
} {
  if (inner.startsWith("date:")) {
    const value = inner.slice(5).trim();
    return { kind: "date", target: value, label: value };
  }
  if (inner.startsWith("event:")) {
    const rest = inner.slice(6);
    const bar = rest.indexOf("|");
    const target = (bar >= 0 ? rest.slice(0, bar) : rest).trim();
    const label = (bar >= 0 ? rest.slice(bar + 1) : rest).trim();
    return { kind: "event", target, label: label || target };
  }
  return { label: inner };
}

/** Encode a chip's attrs back to its on-disk `[[…]]` form. */
function serializeMention(attrs: {
  label?: string;
  id?: string;
  kind?: string;
  target?: string;
}): string {
  const text = attrs.label ?? attrs.id ?? "";
  if (attrs.kind === "date" && attrs.target) return `[[date:${attrs.target}]]`;
  if (attrs.kind === "event" && attrs.target) return `[[event:${attrs.target}|${text}]]`;
  return `[[${text}]]`;
}

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
          node: { attrs: { label?: string; id?: string; kind?: string; target?: string } },
        ) {
          state.write(serializeMention(node.attrs));
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

/**
 * Build the `@` suggestion config from the view's data source + insert command.
 * `onInsert` fires after a chip is inserted so the view can react (e.g. a date or
 * event mention populating a meeting's front matter).
 */
export function mentionSuggestion(
  suggest: (query: string) => LinkTarget[],
  onInsert?: (item: LinkTarget) => void,
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
      onInsert?.(props);
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
    const token = parseMentionToken(match.label);
    // Dates/events carry their own kind+target; note/wiki labels resolve via the view.
    const info = token.kind
      ? { kind: token.kind, target: token.target ?? "" }
      : resolve(token.label);
    const chip = state.schema.nodes.mention!.create({
      id: info?.target || token.label,
      label: token.label,
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
      row.innerHTML = `<span class="mention-menu-kind">${item.type}</span><span class="mention-menu-label"></span>`;
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

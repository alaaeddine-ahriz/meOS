"use client";

import { useEffect, useRef } from "react";
import { EditorContent, EditorContext, useEditor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";

// --- Tiptap Core Extensions ---
import { StarterKit } from "@tiptap/starter-kit";
import { Image } from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { TextAlign } from "@tiptap/extension-text-align";
import { Typography } from "@tiptap/extension-typography";
import { Highlight } from "@tiptap/extension-highlight";
import { Subscript } from "@tiptap/extension-subscript";
import { Superscript } from "@tiptap/extension-superscript";
import { Placeholder, Selection } from "@tiptap/extensions";
import { Markdown } from "tiptap-markdown";
import type { MarkdownStorage } from "tiptap-markdown";

// --- meOS vault wiring ---
import {
  VaultMention,
  mentionSuggestion,
  linkifyMentions,
  type FollowTarget,
  type LinkTarget,
} from "@/lib/tiptap/mention";
import { SlashCommand } from "@/lib/tiptap/slash";

// --- UI Primitives ---
import { Toolbar, ToolbarGroup, ToolbarSeparator } from "@/components/tiptap-ui-primitive/toolbar";

// --- Tiptap Node ---
import { HorizontalRule } from "@/components/tiptap-node/horizontal-rule-node/horizontal-rule-node-extension";
import "@/components/tiptap-node/blockquote-node/blockquote-node.scss";
import "@/components/tiptap-node/code-block-node/code-block-node.scss";
import "@/components/tiptap-node/horizontal-rule-node/horizontal-rule-node.scss";
import "@/components/tiptap-node/list-node/list-node.scss";
import "@/components/tiptap-node/image-node/image-node.scss";
import "@/components/tiptap-node/heading-node/heading-node.scss";
import "@/components/tiptap-node/paragraph-node/paragraph-node.scss";

// --- Tiptap UI ---
import { LinkPopover } from "@/components/tiptap-ui/link-popover";
import { MarkButton } from "@/components/tiptap-ui/mark-button";

// --- Styles ---
import "@/components/tiptap-templates/simple/simple-editor.scss";

export interface SimpleEditorProps {
  /** Initial markdown. The component is keyed on the note path, so this is read once. */
  markdown: string;
  onChange: (markdown: string) => void;
  /** Autocomplete source for the `@` mention popup. */
  suggest: (query: string) => LinkTarget[];
  /** Called when a mention chip is clicked. */
  onFollow: (target: FollowTarget) => void;
  /** Called after a mention is inserted, so the view can drive front matter. */
  onInsert?: (target: LinkTarget) => void;
  /** Called when a `/` template is chosen (e.g. `/meeting`). */
  onApplyTemplate?: (name: "meeting") => void;
}

export function SimpleEditor({
  markdown,
  onChange,
  suggest,
  onFollow,
  onInsert,
  onApplyTemplate,
}: SimpleEditorProps) {
  // Parsing the initial markdown can emit a normalising transaction while the
  // editor is still being created; ignore updates until mounted so we never
  // setState mid-render (or autosave an untouched note).
  const ready = useRef(false);
  // The mention suggestion + chip clicks capture vault state that changes over
  // time; route them through refs so the editor never needs recreating.
  const suggestRef = useRef(suggest);
  suggestRef.current = suggest;
  const followRef = useRef(onFollow);
  followRef.current = onFollow;
  const insertRef = useRef(onInsert);
  insertRef.current = onInsert;
  const applyTemplateRef = useRef(onApplyTemplate);
  applyTemplateRef.current = onApplyTemplate;

  const editor = useEditor({
    immediatelyRender: false,
    editorProps: {
      attributes: {
        autocomplete: "off",
        autocorrect: "off",
        autocapitalize: "off",
        "aria-label": "Main content area, start typing to enter text.",
        class: "simple-editor",
      },
    },
    extensions: [
      StarterKit.configure({
        horizontalRule: false,
        link: {
          openOnClick: false,
          enableClickSelection: true,
        },
      }),
      HorizontalRule,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: true } }),
      Highlight.configure({ multicolor: true }),
      Image,
      Typography,
      Superscript,
      Subscript,
      Selection,
      Placeholder.configure({
        placeholder: "Write… type / for blocks, @ to mention a note, person, date, or event",
      }),
      // HTML mode so nodes/marks without Markdown syntax — tables and the
      // bubble-menu's underline/sub/superscript — round-trip as `<table>`,
      // `<u>`, `<sub>`, `<sup>` instead of being dropped on save.
      Markdown.configure({ html: true, transformPastedText: true }),
      SlashCommand.configure({
        onApplyTemplate: (name) => applyTemplateRef.current?.(name),
      }),
      VaultMention.configure({
        HTMLAttributes: { class: "mention-chip" },
        suggestion: mentionSuggestion(
          (query) => suggestRef.current(query),
          (item) => insertRef.current?.(item),
        ),
        onFollow: (target) => followRef.current(target),
      }),
    ],
    content: markdown,
    onCreate: ({ editor }) => {
      // Re-hydrate the note's on-disk `[[Name]]` links into mention chips,
      // resolving each to its note/wiki target via the live autocomplete source.
      linkifyMentions(editor, (label) => {
        const exact = suggestRef
          .current(label)
          .find((h) => h.label.toLowerCase() === label.toLowerCase());
        return exact ? { kind: exact.type, target: exact.target } : null;
      });
    },
    onUpdate: ({ editor }) => {
      if (!ready.current) return;
      const md = (editor.storage as unknown as { markdown: MarkdownStorage }).markdown;
      onChange(md.getMarkdown());
    },
  });

  useEffect(() => {
    ready.current = true;
  }, []);

  return (
    <div className="simple-editor-wrapper">
      <EditorContext.Provider value={{ editor }}>
        {editor && (
          <BubbleMenu
            editor={editor}
            className="bubble-menu"
            options={{ placement: "top", offset: 8 }}
          >
            <Toolbar variant="floating">
              <ToolbarGroup>
                <MarkButton type="bold" />
                <MarkButton type="italic" />
                <MarkButton type="underline" />
                <MarkButton type="strike" />
              </ToolbarGroup>

              <ToolbarSeparator />

              <ToolbarGroup>
                <MarkButton type="code" />
                <LinkPopover />
              </ToolbarGroup>

              <ToolbarSeparator />

              <ToolbarGroup>
                <MarkButton type="subscript" />
                <MarkButton type="superscript" />
              </ToolbarGroup>
            </Toolbar>
          </BubbleMenu>
        )}

        <EditorContent editor={editor} role="presentation" className="simple-editor-content" />
      </EditorContext.Provider>
    </div>
  );
}

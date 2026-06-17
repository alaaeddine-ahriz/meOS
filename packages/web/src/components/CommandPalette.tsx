import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { ENTITY_TYPES } from "@/lib/entity-meta";
import { api, type Conversation, type EntitySummary } from "../api.js";

const VIEWS = [
  { label: "Chat", to: "/" },
  // "Notes" entry removed — notes/meeting feature deprecated.
  { label: "Wiki", to: "/wiki" },
  { label: "Graph", to: "/wiki?view=graph" },
  { label: "Activity", to: "/activity" },
  { label: "Review", to: "/activity?tab=review" },
  { label: "Digest", to: "/activity?tab=digest" },
  { label: "Settings", to: "/settings" },
];

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [entities, setEntities] = useState<EntitySummary[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    api
      .listEntities()
      .then((r) => setEntities(r.entities))
      .catch(() => {});
    api
      .listConversations()
      .then((r) => setConversations(r.conversations))
      .catch(() => {});
  }, [open]);

  const choose = (to: string) => {
    navigate(to);
    onOpenChange(false);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      showCloseButton={false}
      className="top-[18vh] translate-y-0 border-line bg-desk"
    >
      <CommandInput
        placeholder="Jump to a view, chat, or wiki page..."
        className="text-paper placeholder:text-dim"
      />
      <CommandList className="max-h-72">
        <CommandEmpty className="py-3 text-sm text-dim">Nothing matches.</CommandEmpty>
        <CommandGroup heading="Actions">
          <CommandItem value="new-chat" onSelect={() => choose("/")}>
            <span>New chat</span>
            <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-dim">
              chat
            </span>
          </CommandItem>
        </CommandGroup>
        {conversations.length > 0 && (
          <CommandGroup heading="Chats">
            {conversations.map((conversation) => (
              <CommandItem
                key={conversation.id}
                value={`chat-${conversation.id} ${conversation.title ?? ""}`}
                onSelect={() => choose(`/?c=${conversation.id}`)}
              >
                <span className="truncate">
                  {conversation.title ?? `Conversation ${conversation.id}`}
                </span>
                <span className="ml-auto shrink-0 font-mono text-[10px] uppercase tracking-wider text-dim">
                  chat
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandGroup heading="Views">
          {VIEWS.map((view) => (
            <CommandItem
              key={view.to}
              value={`view-${view.label}`}
              onSelect={() => choose(view.to)}
            >
              <span>{view.label}</span>
              <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-dim">
                view
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
        {entities.length > 0 && (
          <CommandGroup heading="Wiki">
            {entities.map((entity) => {
              const Icon = ENTITY_TYPES[entity.type]?.icon;
              return (
                <CommandItem
                  key={entity.id}
                  value={`${entity.name} ${entity.type}`}
                  onSelect={() => choose(`/wiki/${entity.slug}`)}
                >
                  {Icon && <Icon className="size-3.5 text-dim" />}
                  <span>{entity.name}</span>
                  <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-dim">
                    {entity.type}
                  </span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}

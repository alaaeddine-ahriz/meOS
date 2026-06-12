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
import { api, type EntitySummary } from "../api.js";

const VIEWS = [
  { label: "Chat", to: "/" },
  { label: "Wiki", to: "/wiki" },
  { label: "Inbox", to: "/inbox" },
  { label: "Digest", to: "/digest" },
];

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [entities, setEntities] = useState<EntitySummary[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    api.listEntities().then((r) => setEntities(r.entities)).catch(() => {});
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
      <CommandInput placeholder="Jump to a view or wiki page..." className="text-paper placeholder:text-dim" />
      <CommandList className="max-h-72">
        <CommandEmpty className="py-3 text-sm text-dim">Nothing matches.</CommandEmpty>
        <CommandGroup heading="Views">
          {VIEWS.map((view) => (
            <CommandItem key={view.to} value={`view-${view.label}`} onSelect={() => choose(view.to)}>
              <span>{view.label}</span>
              <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-dim">view</span>
            </CommandItem>
          ))}
        </CommandGroup>
        {entities.length > 0 && (
          <CommandGroup heading="Wiki">
            {entities.map((entity) => (
              <CommandItem
                key={entity.id}
                value={`${entity.name} ${entity.type}`}
                onSelect={() => choose(`/wiki/${entity.slug}`)}
              >
                <span>{entity.name}</span>
                <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-dim">{entity.type}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}

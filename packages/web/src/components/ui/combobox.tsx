import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface ComboboxProps {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  /** When set, a typed value that matches no option can still be chosen. */
  allowCustom?: boolean;
  className?: string;
  contentClassName?: string;
}

/**
 * A searchable single-select built from Popover + Command — a drop-in for a
 * plain dropdown when the option list is long or the user may want to type an
 * identifier we don't list (`allowCustom`). The trigger mirrors the surrounding
 * form controls; callers pass `className` to match.
 */
export function Combobox({
  value,
  onChange,
  options,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "No results.",
  disabled,
  allowCustom = false,
  className,
  contentClassName,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
    setQuery("");
  };

  // Offer the typed value as a choice when it matches nothing yet — lets the user
  // commit a model identifier the provider didn't return.
  const trimmed = query.trim();
  const showCustom =
    allowCustom &&
    trimmed.length > 0 &&
    !options.some((o) => o.toLowerCase() === trimmed.toLowerCase());

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn("w-full justify-between font-normal", className)}
        >
          <span className={cn("truncate", !value && "text-dim")}>{value || placeholder}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className={cn("w-(--radix-popover-trigger-width) p-0", contentClassName)}
        align="start"
      >
        <Command>
          <CommandInput
            placeholder={searchPlaceholder}
            value={query}
            onValueChange={setQuery}
            className="font-mono text-[13px]"
          />
          <CommandList>
            {!showCustom && <CommandEmpty>{emptyText}</CommandEmpty>}
            <CommandGroup>
              {showCustom && (
                <CommandItem
                  value={trimmed}
                  onSelect={() => choose(trimmed)}
                  className="font-mono text-[13px]"
                >
                  <Check className="size-3.5 opacity-0" />
                  Use “{trimmed}”
                </CommandItem>
              )}
              {options.map((option) => (
                <CommandItem
                  key={option}
                  value={option}
                  onSelect={() => choose(option)}
                  className="font-mono text-[13px]"
                >
                  <Check
                    className={cn("size-3.5", value === option ? "opacity-100" : "opacity-0")}
                  />
                  {option}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

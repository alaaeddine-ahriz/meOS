import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { api } from "../api.js";

/**
 * Quick capture, summonable from anywhere with ⌘J. A thought goes in, the
 * dialog closes, processing happens in the background.
 */
export function CaptureDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setTitle("");
      setText("");
      setSaving(false);
    }
  }, [open]);

  const capture = async () => {
    if (!text.trim() || saving) return;
    setSaving(true);
    try {
      await api.ingestText(title.trim(), text);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-[18vh] translate-y-0 border-line bg-desk sm:max-w-md"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void capture();
        }}
      >
        <DialogHeader>
          <DialogTitle className="font-serif text-xl font-medium text-paper">Capture</DialogTitle>
          <DialogDescription className="text-sm text-dim">
            A thought, a meeting note, a draft. MeOS files it for you.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Title (optional)"
          className="border-line bg-transparent text-sm text-paper placeholder:text-dim focus-visible:border-lamp-dim focus-visible:ring-0"
        />
        <Textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={5}
          autoFocus
          placeholder="Write it down before it escapes…"
          className="resize-y border-line bg-transparent text-sm text-paper placeholder:text-dim focus-visible:border-lamp-dim focus-visible:ring-0"
        />
        <div className="flex items-center justify-end gap-3">
          <Button
            onClick={() => void capture()}
            disabled={!text.trim() || saving}
            className="bg-lamp text-ink hover:bg-lamp/85"
          >
            {saving ? "Capturing…" : "Capture"}
            <Kbd className="bg-ink/15 text-ink">⌘↵</Kbd>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

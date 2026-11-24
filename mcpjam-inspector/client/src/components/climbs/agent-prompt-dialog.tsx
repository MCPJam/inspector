import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Textarea } from "@mcpjam/design-system/textarea";
import { CopyButton } from "./copy-button";

/** A prompt to copy into a person's coding agent, with a line on what happens next. */
export function AgentPromptDialog({
  open,
  onOpenChange,
  title,
  note,
  prompt,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  note: string;
  prompt: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{note}</DialogDescription>
        </DialogHeader>
        <Textarea readOnly rows={7} value={prompt} aria-label="Prompt" />
        <DialogFooter>
          <CopyButton text={prompt} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

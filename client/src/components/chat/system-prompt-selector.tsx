import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Settings2 } from "lucide-react";
import { toast } from "sonner";

interface SystemPromptSelectorProps {
  systemPrompt: string;
  onSystemPromptChange: (prompt: string) => void;
  disabled?: boolean;
  isLoading?: boolean;
}

export function SystemPromptSelector({
  systemPrompt,
  onSystemPromptChange,
  disabled,
  isLoading,
}: SystemPromptSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [draftPrompt, setDraftPrompt] = useState(systemPrompt);

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (open) {
      setDraftPrompt(systemPrompt);
    }
  };

  const handleSave = () => {
    onSystemPromptChange(draftPrompt);
    setIsOpen(false);
    toast.success("System prompt updated");
  };

  const handleCancel = () => {
    setDraftPrompt(systemPrompt);
    setIsOpen(false);
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || isLoading}
          className="h-8 px-2 rounded-full hover:bg-muted/80 transition-colors text-xs cursor-pointer"
        >
          <Settings2 className="h-2 w-2 mr-1" />
          <span className="text-[10px] font-medium">System Prompt</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>System Prompt</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <Textarea
            value={draftPrompt}
            onChange={(e) => setDraftPrompt(e.target.value)}
            placeholder="You are a helpful assistant with access to MCP tools."
            className="min-h-[140px] resize-none"
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={handleCancel}
              className="cursor-pointer"
            >
              Cancel
            </Button>
            <Button onClick={handleSave} className="cursor-pointer">
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

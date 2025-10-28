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
import { Slider } from "@/components/ui/slider";
import { Settings2 } from "lucide-react";
import { toast } from "sonner";

interface SystemPromptSelectorProps {
  systemPrompt: string;
  onSystemPromptChange: (prompt: string) => void;
  temperature: number;
  onTemperatureChange: (temperature: number) => void;
  disabled?: boolean;
  isLoading?: boolean;
}

export function SystemPromptSelector({
  systemPrompt,
  onSystemPromptChange,
  temperature,
  onTemperatureChange,
  disabled,
  isLoading,
}: SystemPromptSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [draftPrompt, setDraftPrompt] = useState(systemPrompt);
  const [draftTemperature, setDraftTemperature] = useState(temperature);

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (open) {
      setDraftPrompt(systemPrompt);
      setDraftTemperature(temperature);
    }
  };

  const handleSave = () => {
    onSystemPromptChange(draftPrompt);
    onTemperatureChange(draftTemperature);
    setIsOpen(false);
    toast.success("System prompt and temperature updated");
  };

  const handleCancel = () => {
    setDraftPrompt(systemPrompt);
    setDraftTemperature(temperature);
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
          <span className="text-[10px] font-medium">
            System Prompt & Temperature
          </span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>System Prompt & Temperature</DialogTitle>
        </DialogHeader>
        <div className="space-y-6">
          <div className="space-y-2">
            <label className="text-sm font-medium">System Prompt</label>
            <Textarea
              value={draftPrompt}
              onChange={(e) => setDraftPrompt(e.target.value)}
              placeholder="You are a helpful assistant with access to MCP tools."
              className="h-[140px] resize-none"
            />
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Temperature</label>
              <span className="text-sm text-muted-foreground">
                {draftTemperature.toFixed(1)}
              </span>
            </div>
            <Slider
              value={[draftTemperature]}
              onValueChange={(value) => setDraftTemperature(value[0])}
              min={0}
              max={2}
              step={0.1}
              className="w-full"
            />
            <p className="text-xs text-muted-foreground">
              Lower values (0-0.3) for focused tasks, higher values (0.7-2.0)
              for creative tasks
            </p>
          </div>

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

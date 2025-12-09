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
import { AlertTriangle, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ModelDefinition, isGPT5Model } from "@/shared/types";

interface SystemPromptSelectorProps {
  systemPrompt: string;
  onSystemPromptChange: (prompt: string) => void;
  temperature: number;
  onTemperatureChange: (temperature: number) => void;
  disabled?: boolean;
  isLoading?: boolean;
  hasMessages?: boolean;
  onResetChat: () => void;
  currentModel: ModelDefinition;
  /** When true, shows icon only for compact layout */
  compact?: boolean;
}

export function SystemPromptSelector({
  systemPrompt,
  onSystemPromptChange,
  temperature,
  onTemperatureChange,
  disabled,
  isLoading,
  hasMessages,
  onResetChat,
  currentModel,
  compact = false,
}: SystemPromptSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [draftPrompt, setDraftPrompt] = useState(systemPrompt);
  const [draftTemperature, setDraftTemperature] = useState(temperature);
  const [confirmReset, setConfirmReset] = useState(false);

  const isGpt5 = isGPT5Model(currentModel.id);

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (open) {
      setDraftPrompt(systemPrompt);
      setDraftTemperature(temperature);
    }
    setConfirmReset(false);
  };

  const handleSave = () => {
    const promptChanged = draftPrompt !== systemPrompt;
    const temperatureChanged = draftTemperature !== temperature;
    if (hasMessages && (promptChanged || temperatureChanged) && !confirmReset) {
      setConfirmReset(true);
      return;
    }

    onSystemPromptChange(draftPrompt);
    onTemperatureChange(draftTemperature);
    if (promptChanged || temperatureChanged) {
      onResetChat();
    }
    setIsOpen(false);
    setConfirmReset(false);
    toast.success("System prompt and temperature updated");
  };

  const handleCancel = () => {
    setDraftPrompt(systemPrompt);
    setDraftTemperature(temperature);
    setConfirmReset(false);
    setIsOpen(false);
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <Button
              variant="ghost"
              size={compact ? "icon" : "sm"}
              disabled={disabled || isLoading}
              className={
                compact
                  ? "h-8 w-8 rounded-full hover:bg-muted/80 transition-colors cursor-pointer"
                  : "h-8 px-2 rounded-full hover:bg-muted/80 transition-colors text-xs cursor-pointer max-w-[180px]"
              }
            >
              <Settings2
                className={compact ? "h-4 w-4" : "h-2 w-2 mr-1 flex-shrink-0"}
              />
              {!compact && (
                <span className="text-[10px] font-medium truncate">
                  System Prompt & Temperature
                </span>
              )}
            </Button>
          </DialogTrigger>
        </TooltipTrigger>
        {compact && (
          <TooltipContent side="top">
            System Prompt & Temperature
          </TooltipContent>
        )}
      </Tooltip>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>System Prompt & Temperature</DialogTitle>
        </DialogHeader>
        <div className="space-y-6">
          <div className="space-y-2">
            <label className="text-sm font-medium">System Prompt</label>
            <Textarea
              value={draftPrompt}
              onChange={(e) => {
                setDraftPrompt(e.target.value);
                setConfirmReset(false);
              }}
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
              onValueChange={(value) => {
                setDraftTemperature(value[0]);
                setConfirmReset(false);
              }}
              min={0}
              max={2}
              step={0.1}
              className="w-full"
              disabled={isGpt5}
            />
            {isGpt5 ? (
              <p className="text-xs text-muted-foreground">
                Temperature is not supported for GPT-5 models
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Lower values (0-0.3) for focused tasks, higher values (0.7-2.0)
                for creative tasks
              </p>
            )}
          </div>

          {confirmReset && (
            <Alert
              variant="destructive"
              className="bg-destructive/10 border-destructive/40"
            >
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Confirm reset</AlertTitle>
              <AlertDescription>
                Changing the system prompt or temperature will clear the current
                chat session. Press save again to continue.
              </AlertDescription>
            </Alert>
          )}

          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={handleCancel}
              className="cursor-pointer"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              className="cursor-pointer"
              variant={confirmReset ? "destructive" : "default"}
            >
              {confirmReset ? "Confirm & Reset" : "Save"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

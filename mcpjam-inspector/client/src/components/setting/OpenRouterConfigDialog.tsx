import { ExternalLink, X } from "lucide-react";
import { useState, useEffect } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Badge } from "../ui/badge";
import { ComboboxMultiSelect } from "../ui/combobox-multi-select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { useOpenRouterModels } from "@/hooks/use-openrouter-models";

interface OpenRouterConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  apiKey: string;
  selectedModels: string[];
  onApiKeyChange: (value: string) => void;
  onSelectedModelsChange: (models: string[]) => void;
  onSave: (apiKey: string, selectedModels: string[]) => void;
  onCancel: () => void;
}

export function OpenRouterConfigDialog({
  open,
  onOpenChange,
  apiKey,
  selectedModels,
  onApiKeyChange,
  onSelectedModelsChange,
  onSave,
  onCancel,
}: OpenRouterConfigDialogProps) {
  const { models, loading, error } = useOpenRouterModels();
  const [internalSelectedModels, setInternalSelectedModels] =
    useState<string[]>(selectedModels);

  // Sync internal state with props when they change
  useEffect(() => {
    setInternalSelectedModels(selectedModels);
  }, [selectedModels]);

  const handleSave = () => {
    onSelectedModelsChange(internalSelectedModels);
    onSave(apiKey, internalSelectedModels);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-lg bg-card p-2 flex items-center justify-center border">
              <img
                src="/openrouter_logo.png"
                alt="OpenRouter Logo"
                className="w-full h-full object-contain"
              />
            </div>
            <div>
              <DialogTitle className="text-left pb-2">
                Configure OpenRouter
              </DialogTitle>
              <DialogDescription className="text-left">
                Add your OpenRouter API Key
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label htmlFor="openrouter-api-key" className="text-sm font-medium">
              API Key
            </label>
            <Input
              id="openrouter-api-key"
              type="password"
              value={apiKey}
              onChange={(e) => onApiKeyChange(e.target.value)}
              placeholder="sk-..."
              className="mt-1"
            />
          </div>

          <div>
            <label htmlFor="openrouter-model" className="text-sm font-medium">
              Models
            </label>
            {loading ? (
              <div className="w-full mt-1 p-2 text-sm text-muted-foreground">
                Loading models...
              </div>
            ) : error ? (
              <div className="w-full mt-1 p-2 text-sm text-destructive">
                {error}
              </div>
            ) : (
              <>
                <ComboboxMultiSelect
                  items={models}
                  placeholder="Select models..."
                  searchPlaceholder="Search models..."
                  value={internalSelectedModels}
                  onValueChange={setInternalSelectedModels}
                  className="w-full mt-1"
                />
                {internalSelectedModels.length > 0 && (
                  <div className="mt-3">
                    <div className="flex flex-wrap gap-2">
                      {internalSelectedModels.map((modelId) => {
                        const model = models.find((m) => m.value === modelId);
                        return (
                          <Badge
                            key={modelId}
                            variant="secondary"
                            className="flex items-center gap-1 pr-1"
                          >
                            {model?.label || modelId}
                            <button
                              type="button"
                              onClick={() => {
                                setInternalSelectedModels((prev) =>
                                  prev.filter((id) => id !== modelId),
                                );
                              }}
                              className="ml-1 hover:bg-destructive hover:text-destructive-foreground rounded-sm p-0.5 transition-colors"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </Badge>
                        );
                      })}
                    </div>
                  </div>
                )}
                <p className="text-xs text-muted-foreground mt-1">
                  We only show models that support tool calling. Select one or
                  more to surface them in the chat.
                </p>
              </>
            )}
          </div>
          <div className="flex items-center gap-2 p-3 bg-info/10 rounded-lg">
            <ExternalLink className="w-4 h-4 text-info" />
            <span className="text-sm text-info">
              Need help?{" "}
              <button
                type="button"
                onClick={() =>
                  window.open("https://openrouter.ai/docs/quickstart", "_blank")
                }
                className="underline hover:no-underline"
              >
                OpenRouter Docs
              </button>
            </span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={internalSelectedModels.length === 0}
          >
            Save Configuration
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

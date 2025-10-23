import { ExternalLink } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

interface OpenRouterConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  apiKey: string;
  modelAlias: string;
  onApiKeyChange: (value: string) => void;
  onModelAliasChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

export function OpenRouterConfigDialog({
  open,
  onOpenChange,
  apiKey,
  modelAlias,
  onApiKeyChange,
  onModelAliasChange,
  onSave,
  onCancel,
}: OpenRouterConfigDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-lg bg-white dark:bg-gray-800 p-2 flex items-center justify-center">
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
              Model Aliases{" "}
              <span className="text-muted-foreground">(comma-separated)</span>
            </label>
            <Input
              id="openrouter-model"
              type="text"
              value={modelAlias}
              onChange={(e) => onModelAliasChange(e.target.value)}
              placeholder="gemini/gemini-2.5-flash, gpt-4, claude-3-opus"
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Enter multiple model aliases separated by commas. Each will appear
              as a separate option in the chat.
            </p>
          </div>

          <div className="flex items-center gap-2 p-3 bg-blue-50 dark:bg-blue-950/20 rounded-lg">
            <ExternalLink className="w-4 h-4 text-blue-600" />
            <span className="text-sm text-blue-600">
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
          <Button onClick={onSave} disabled={!modelAlias.trim()}>
            Save Configuration
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

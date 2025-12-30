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

interface LiteLLMConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  baseUrl: string;
  apiKey: string;
  modelAlias: string;
  onBaseUrlChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onModelAliasChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

export function LiteLLMConfigDialog({
  open,
  onOpenChange,
  baseUrl,
  apiKey,
  modelAlias,
  onBaseUrlChange,
  onApiKeyChange,
  onModelAliasChange,
  onSave,
  onCancel,
}: LiteLLMConfigDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-lg bg-card p-2 flex items-center justify-center border">
              <img
                src="/litellm_logo.png"
                alt="LiteLLM Logo"
                className="w-full h-full object-contain"
              />
            </div>
            <div>
              <DialogTitle className="text-left pb-2">
                Configure LiteLLM Proxy
              </DialogTitle>
              <DialogDescription className="text-left">
                Set up your LiteLLM proxy connection
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label htmlFor="litellm-url" className="text-sm font-medium">
              Base URL
            </label>
            <Input
              id="litellm-url"
              type="url"
              value={baseUrl}
              onChange={(e) => onBaseUrlChange(e.target.value)}
              placeholder="http://localhost:4000"
              className="mt-1"
            />
          </div>

          <div>
            <label htmlFor="litellm-api-key" className="text-sm font-medium">
              API Key
            </label>
            <Input
              id="litellm-api-key"
              type="password"
              value={apiKey}
              onChange={(e) => onApiKeyChange(e.target.value)}
              placeholder="sk-..."
              className="mt-1"
            />
          </div>

          <div>
            <label htmlFor="litellm-model" className="text-sm font-medium">
              Model Aliases{" "}
              <span className="text-muted-foreground">(comma-separated)</span>
            </label>
            <Input
              id="litellm-model"
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

          <div className="flex items-center gap-2 p-3 bg-info/10 rounded-lg">
            <ExternalLink className="w-4 h-4 text-info" />
            <span className="text-sm text-info">
              Need help?{" "}
              <button
                onClick={() =>
                  window.open(
                    "https://docs.litellm.ai/docs/proxy/quick_start",
                    "_blank",
                  )
                }
                className="underline hover:no-underline"
              >
                LiteLLM Proxy Docs
              </button>
            </span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            onClick={onSave}
            disabled={!baseUrl.trim() || !modelAlias.trim()}
          >
            Save Configuration
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

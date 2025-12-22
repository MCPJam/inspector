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

interface AzureOpenAIConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  baseUrl: string;
  apiKey: string;
  onBaseUrlChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

export function AzureOpenAIConfigDialog({
  open,
  onOpenChange,
  baseUrl,
  apiKey,
  onBaseUrlChange,
  onApiKeyChange,
  onSave,
  onCancel,
}: AzureOpenAIConfigDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-lg bg-card p-2 flex items-center justify-center border">
              <img
                src="/azure_logo.png"
                alt="Azure OpenAI Logo"
                className="w-full h-full object-contain"
              />
            </div>
            <div>
              <DialogTitle className="text-left pb-2">
                Configure Azure OpenAI
              </DialogTitle>
              <DialogDescription className="text-left">
                Set up your Azure OpenAI connection
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label htmlFor="azure-url" className="text-sm font-medium">
              Base URL
            </label>
            <Input
              id="azure-url"
              type="url"
              value={baseUrl}
              onChange={(e) => onBaseUrlChange(e.target.value)}
              placeholder="https://RESOURCE_NAME.openai.azure.com/openai"
              className="mt-1"
            />
          </div>

          <div>
            <label htmlFor="azure-api-key" className="text-sm font-medium">
              API Key
            </label>
            <Input
              id="azure-api-key"
              type="password"
              value={apiKey}
              onChange={(e) => onApiKeyChange(e.target.value)}
              placeholder="Open AI Key"
              className="mt-1"
            />
          </div>

          <div className="flex items-center gap-2 p-3 bg-info/10 rounded-lg">
            <ExternalLink className="w-4 h-4 text-info" />
            <span className="text-sm text-info">
              Need help?{" "}
              <button
                onClick={() =>
                  window.open(
                    "https://ai-sdk.dev/providers/ai-sdk-providers/azure#chat-models",
                    "_blank",
                  )
                }
                className="underline hover:no-underline"
              >
                Azure OpenAI Docs
              </button>
            </span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={!baseUrl.trim()}>
            Save Configuration
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

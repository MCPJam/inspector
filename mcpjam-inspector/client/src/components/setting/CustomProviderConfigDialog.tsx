import { useState, useEffect } from "react";
import type { CustomProvider, CompatibleProtocol } from "@mcpjam/sdk";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

interface CustomProviderConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When provided, the dialog is in edit mode with pre-populated fields */
  editProvider?: CustomProvider;
  onSave: (provider: CustomProvider) => void;
  onCancel: () => void;
}

export function CustomProviderConfigDialog({
  open,
  onOpenChange,
  editProvider,
  onSave,
  onCancel,
}: CustomProviderConfigDialogProps) {
  const [name, setName] = useState("");
  const [protocol, setProtocol] =
    useState<CompatibleProtocol>("openai-compatible");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelIds, setModelIds] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Populate fields when editing
  useEffect(() => {
    if (open) {
      if (editProvider) {
        setName(editProvider.name);
        setProtocol(editProvider.protocol);
        setBaseUrl(editProvider.baseUrl);
        setApiKey(editProvider.apiKey || "");
        setModelIds(editProvider.modelIds.join(", "));
      } else {
        setName("");
        setProtocol("openai-compatible");
        setBaseUrl("");
        setApiKey("");
        setModelIds("");
      }
      setError(null);
    }
  }, [open, editProvider]);

  const handleSave = () => {
    setError(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Provider name is required");
      return;
    }
    if (trimmedName.includes("/")) {
      setError("Provider name cannot contain '/'");
      return;
    }

    const trimmedBaseUrl = baseUrl.trim();
    if (!trimmedBaseUrl) {
      setError("API URL is required");
      return;
    }

    const parsedModelIds = modelIds
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (parsedModelIds.length === 0) {
      setError("At least one model name is required");
      return;
    }

    const provider: CustomProvider = {
      name: trimmedName,
      protocol,
      baseUrl: trimmedBaseUrl,
      modelIds: parsedModelIds,
      ...(apiKey.trim() && { apiKey: apiKey.trim() }),
    };

    onSave(provider);
  };

  const isValid =
    name.trim() &&
    !name.includes("/") &&
    baseUrl.trim() &&
    modelIds.split(",").some((id) => id.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-left">
            {editProvider ? "Edit Custom Provider" : "Add Custom Provider"}
          </DialogTitle>
          <DialogDescription className="text-left">
            Connect to any OpenAI-compatible or Anthropic-compatible API
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label htmlFor="cp-name" className="text-sm font-medium">
              Provider Name
            </label>
            <Input
              id="cp-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. groq, together, vllm"
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Used in model strings (e.g. &quot;groq/llama-3&quot;). No slashes.
            </p>
          </div>

          <div>
            <label htmlFor="cp-protocol" className="text-sm font-medium">
              Protocol
            </label>
            <Select
              value={protocol}
              onValueChange={(v) => setProtocol(v as CompatibleProtocol)}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai-compatible">
                  OpenAI Compatible
                </SelectItem>
                <SelectItem value="anthropic-compatible">
                  Anthropic Compatible
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <label htmlFor="cp-url" className="text-sm font-medium">
              API URL
            </label>
            <Input
              id="cp-url"
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.groq.com/openai/v1"
              className="mt-1"
            />
          </div>

          <div>
            <label htmlFor="cp-api-key" className="text-sm font-medium">
              API Key{" "}
              <span className="text-muted-foreground font-normal">
                (optional)
              </span>
            </label>
            <Input
              id="cp-api-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
              className="mt-1"
            />
          </div>

          <div>
            <label htmlFor="cp-models" className="text-sm font-medium">
              Model Names{" "}
              <span className="text-muted-foreground font-normal">
                (comma-separated)
              </span>
            </label>
            <Input
              id="cp-models"
              type="text"
              value={modelIds}
              onChange={(e) => setModelIds(e.target.value)}
              placeholder="llama-3.3-70b-versatile, mixtral-8x7b"
              className="mt-1"
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!isValid}>
            {editProvider ? "Save Changes" : "Add Provider"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

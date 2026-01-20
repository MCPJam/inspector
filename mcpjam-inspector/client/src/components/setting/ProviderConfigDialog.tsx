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
import { Alert, AlertDescription } from "../ui/alert";
import { usePostHog } from "posthog-js/react";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
interface ProviderConfig {
  id: string;
  name: string;
  logo: string;
  logoAlt: string;
  description: string;
  placeholder: string;
  getApiKeyUrl: string;
  defaultBaseUrl?: string;
}

interface ProviderConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: ProviderConfig | null;
  value: string;
  onValueChange: (value: string) => void;
  baseUrlValue?: string;
  onBaseUrlChange?: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

export function ProviderConfigDialog({
  open,
  onOpenChange,
  provider,
  value,
  onValueChange,
  baseUrlValue,
  onBaseUrlChange,
  onSave,
  onCancel,
}: ProviderConfigDialogProps) {
  const posthog = usePostHog();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3 mb-4">
            {provider && (
              <div className="w-12 h-12 rounded-lg bg-card p-2 border">
                <img
                  src={provider.logo}
                  alt={provider.logoAlt}
                  className="w-full h-full object-contain"
                />
              </div>
            )}
            <div>
              <DialogTitle className="text-left">
                Configure {provider?.name}
              </DialogTitle>
              <DialogDescription className="text-left">
                {provider?.description}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label htmlFor="api-key" className="text-sm font-medium">
              API Key
            </label>
            <Input
              id="api-key"
              type="password"
              value={value}
              onChange={(e) => onValueChange(e.target.value)}
              placeholder={provider?.placeholder}
              className="mt-1"
            />
          </div>

          {provider?.defaultBaseUrl && onBaseUrlChange && (
            <div>
              <label htmlFor="base-url" className="text-sm font-medium">
                Base URL (Optional)
              </label>
              <Input
                id="base-url"
                type="text"
                value={baseUrlValue || ""}
                onChange={(e) => onBaseUrlChange(e.target.value)}
                placeholder={provider.defaultBaseUrl}
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Leave empty to use the default endpoint
              </p>
            </div>
          )}

          <div className="flex items-center gap-2 p-3 bg-info/10 rounded-lg">
            <ExternalLink className="w-4 h-4 text-info" />
            <span className="text-sm text-info">
              Need an API key?{" "}
              <button
                onClick={() =>
                  provider && window.open(provider.getApiKeyUrl, "_blank")
                }
                className="underline hover:no-underline"
              >
                Get one here
              </button>
            </span>
          </div>

          {provider?.id === "openai" && (
            <Alert>
              <AlertDescription>
                <p>
                  <strong>
                    GPT-5 models require organization verification.
                  </strong>{" "}
                  If you encounter access errors, visit{" "}
                  <a
                    href="https://platform.openai.com/settings/organization/general"
                    target="_blank"
                    rel="noreferrer"
                    className="underline hover:no-underline font-medium align-baseline inline"
                  >
                    OpenAI Settings
                  </a>{" "}
                  and verify your organization. Access may take up to 15 minutes
                  after verification.
                </p>
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              posthog.capture("save_api_key", {
                location: "provider_config_dialog",
                platform: detectPlatform(),
                environment: detectEnvironment(),
              });
              onSave();
            }}
            disabled={!value.trim()}
          >
            Save API Key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

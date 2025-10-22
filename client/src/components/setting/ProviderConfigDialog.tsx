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
import { detectEnvironment, detectPlatform } from "@/logs/PosthogUtils";
interface ProviderConfig {
  id: string;
  name: string;
  logo: string;
  logoAlt: string;
  description: string;
  placeholder: string;
  getApiKeyUrl: string;
}

interface ProviderConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: ProviderConfig | null;
  value: string;
  onValueChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

export function ProviderConfigDialog({
  open,
  onOpenChange,
  provider,
  value,
  onValueChange,
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
              <div className="w-12 h-12 rounded-lg bg-white p-2 border">
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

          <div className="flex items-center gap-2 p-3 bg-blue-50 dark:bg-blue-950/20 rounded-lg">
            <ExternalLink className="w-4 h-4 text-blue-600" />
            <span className="text-sm text-blue-600">
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
          {provider?.id === "bedrock" && (
            <Alert>
              <AlertDescription>
                <p>
                  Enter your credentials as
                  <code className="mx-1 rounded bg-muted px-1 py-[1px] text-xs">
                    accessKeyId|secretAccessKey[|sessionToken]
                  </code>
                  . We store them locally in your browser. Optionally set the
                  <code className="mx-1 rounded bg-muted px-1 py-[1px] text-xs">
                    AWS_BEDROCK_REGION
                  </code>
                  environment variable on the server (defaults to
                  <code className="mx-1 rounded bg-muted px-1 py-[1px] text-xs">
                    us-west-2
                  </code>
                  ).
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

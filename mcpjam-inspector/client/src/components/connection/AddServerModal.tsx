import { useEffect } from "react";
import { toast } from "sonner";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { ChevronDown, ChevronRight } from "lucide-react";
import { ServerFormData } from "@/shared/types.js";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { HOSTED_MODE } from "@/lib/config";
import { usePostHog } from "posthog-js/react";
import { useServerForm } from "./hooks/use-server-form";
import { AuthenticationSection } from "./shared/AuthenticationSection";
import { CustomHeadersSection } from "./shared/CustomHeadersSection";
import { EnvVarsSection } from "./shared/EnvVarsSection";

interface AddServerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (formData: ServerFormData) => void;
  initialData?: Partial<ServerFormData>;
}

export function AddServerModal({
  isOpen,
  onClose,
  onSubmit,
  initialData,
}: AddServerModalProps) {
  const posthog = usePostHog();
  const formState = useServerForm();

  // Initialize form with initial data if provided
  useEffect(() => {
    if (initialData && isOpen) {
      if (initialData.name) {
        formState.setName(initialData.name);
      }
      // Only set type if it's allowed (STDIO is disabled in web app)
      if (initialData.type && !(HOSTED_MODE && initialData.type === "stdio")) {
        formState.setType(initialData.type);
      }
      if (initialData.command) {
        const fullCommand = initialData.args
          ? `${initialData.command} ${initialData.args.join(" ")}`
          : initialData.command;
        formState.setCommandInput(fullCommand);
      }
      if (initialData.url) {
        formState.setUrl(initialData.url);
      }
      if (initialData.env) {
        const envArray = Object.entries(initialData.env).map(
          ([key, value]) => ({
            key,
            value,
          }),
        );
        formState.setEnvVars(envArray);
        if (envArray.length > 0) {
          formState.setShowEnvVars(true);
        }
      }
      // Handle authentication configuration
      if (initialData.useOAuth) {
        formState.setAuthType("oauth");
        formState.setShowAuthSettings(true);
      } else if (
        initialData.headers &&
        initialData.headers["Authorization"] !== undefined
      ) {
        // Has Authorization header - set up bearer token
        formState.setAuthType("bearer");
        formState.setShowAuthSettings(true);
        formState.setBearerToken(initialData.headers["Authorization"] || "");
      }
    }
  }, [initialData, isOpen]);

  const handleClose = () => {
    formState.resetForm();
    onClose();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    // Validate Client ID if using custom configuration
    if (formState.authType === "oauth" && formState.useCustomClientId) {
      const clientIdError = formState.validateClientId(formState.clientId);
      if (clientIdError) {
        toast.error(clientIdError);
        return;
      }

      // Validate Client Secret if provided
      if (formState.clientSecret) {
        const clientSecretError = formState.validateClientSecret(
          formState.clientSecret,
        );
        if (clientSecretError) {
          toast.error(clientSecretError);
          return;
        }
      }
    }

    // Validate form
    const validationError = formState.validateForm();
    if (validationError) {
      toast.error(validationError);
      return;
    }

    const finalFormData = formState.buildFormData();
    onSubmit(finalFormData);
    formState.resetForm();
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent
        className="max-w-2xl max-h-[90vh] overflow-y-auto"
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Add MCP Server
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Server Name */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">
              Server Name
            </label>
            <Input
              value={formState.name}
              onChange={(e) => formState.setName(e.target.value)}
              placeholder="my-mcp-server"
              required
              className="h-10"
            />
          </div>

          {/* Connection Type */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">
              Connection Type
            </label>
            {formState.type === "stdio" && !HOSTED_MODE ? (
              <div className="flex">
                <Select
                  value={formState.type}
                  onValueChange={(value: "stdio" | "http") => {
                    const currentValue = formState.commandInput;
                    formState.setType(value);
                    if (value === "http" && currentValue) {
                      formState.setUrl(currentValue);
                    }
                  }}
                >
                  <SelectTrigger className="w-22 rounded-r-none border-r-0 text-xs border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stdio">STDIO</SelectItem>
                    <SelectItem value="http">HTTP</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  value={formState.commandInput}
                  onChange={(e) => formState.setCommandInput(e.target.value)}
                  placeholder="npx -y @modelcontextprotocol/server-everything"
                  required
                  className="flex-1 rounded-l-none"
                />
              </div>
            ) : (
              <div className="flex">
                <Select
                  value={formState.type}
                  onValueChange={(value: "stdio" | "http") => {
                    // STDIO is disabled in web app
                    if (value === "stdio" && HOSTED_MODE) return;
                    const currentValue = formState.url;
                    formState.setType(value);
                    if (value === "stdio" && currentValue) {
                      formState.setCommandInput(currentValue);
                    }
                  }}
                >
                  <SelectTrigger className="w-22 rounded-r-none border-r-0 text-xs border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {!HOSTED_MODE && (
                      <SelectItem value="stdio">STDIO</SelectItem>
                    )}
                    <SelectItem value="http">HTTP</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  value={formState.url}
                  onChange={(e) => formState.setUrl(e.target.value)}
                  placeholder="http://localhost:8080/mcp"
                  required
                  className="flex-1 rounded-l-none"
                />
              </div>
            )}
          </div>

          {/* STDIO: Environment Variables */}
          {formState.type === "stdio" && (
            <EnvVarsSection
              envVars={formState.envVars}
              showEnvVars={formState.showEnvVars}
              onToggle={() => formState.setShowEnvVars(!formState.showEnvVars)}
              onAdd={formState.addEnvVar}
              onRemove={formState.removeEnvVar}
              onUpdate={formState.updateEnvVar}
            />
          )}

          {/* HTTP: Authentication */}
          {formState.type === "http" && (
            <AuthenticationSection
              authType={formState.authType}
              onAuthTypeChange={(value) => {
                formState.setAuthType(value);
                formState.setShowAuthSettings(value !== "none");
              }}
              showAuthSettings={formState.showAuthSettings}
              bearerToken={formState.bearerToken}
              onBearerTokenChange={formState.setBearerToken}
              oauthScopesInput={formState.oauthScopesInput}
              onOauthScopesChange={formState.setOauthScopesInput}
              useCustomClientId={formState.useCustomClientId}
              onUseCustomClientIdChange={(checked) => {
                formState.setUseCustomClientId(checked);
                if (!checked) {
                  formState.setClientId("");
                  formState.setClientSecret("");
                  formState.setClientIdError(null);
                  formState.setClientSecretError(null);
                }
              }}
              clientId={formState.clientId}
              onClientIdChange={(value) => {
                formState.setClientId(value);
                const error = formState.validateClientId(value);
                formState.setClientIdError(error);
              }}
              clientSecret={formState.clientSecret}
              onClientSecretChange={(value) => {
                formState.setClientSecret(value);
                const error = formState.validateClientSecret(value);
                formState.setClientSecretError(error);
              }}
              clientIdError={formState.clientIdError}
              clientSecretError={formState.clientSecretError}
            />
          )}

          {/* HTTP: Custom Headers */}
          {formState.type === "http" && (
            <CustomHeadersSection
              customHeaders={formState.customHeaders}
              onAdd={formState.addCustomHeader}
              onRemove={formState.removeCustomHeader}
              onUpdate={formState.updateCustomHeader}
            />
          )}

          {/* Configuration Section */}
          <div className="border border-border rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() =>
                formState.setShowConfiguration(!formState.showConfiguration)
              }
              className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-2">
                {formState.showConfiguration ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                )}
                <span className="text-sm font-medium text-foreground">
                  Additional Configuration
                </span>
              </div>
            </button>

            {formState.showConfiguration && (
              <div className="p-4 space-y-4 border-t border-border bg-muted/30">
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-foreground">
                    Request Timeout
                  </label>
                  <Input
                    type="number"
                    value={formState.requestTimeout}
                    onChange={(e) =>
                      formState.setRequestTimeout(e.target.value)
                    }
                    placeholder="10000"
                    className="h-10"
                    min="1000"
                    max="600000"
                    step="1000"
                  />
                  <p className="text-xs text-muted-foreground">
                    Timeout in ms (default: 10000ms, min: 1000ms, max: 600000ms)
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div className="flex justify-end space-x-2 pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                posthog.capture("cancel_button_clicked", {
                  location: "add_server_modal",
                  platform: detectPlatform(),
                  environment: detectEnvironment(),
                });
                handleClose();
              }}
              className="px-4"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              onClick={() => {
                posthog.capture("add_server_button_clicked", {
                  location: "add_server_modal",
                  platform: detectPlatform(),
                  environment: detectEnvironment(),
                });
              }}
              className="px-4"
            >
              Add Server
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

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
import { detectEnvironment, detectPlatform } from "@/logs/PosthogUtils";
import { usePostHog } from "posthog-js/react";
import { useServerForm } from "./hooks/use-server-form";
import { AuthenticationSection } from "./shared/AuthenticationSection";
import { CustomHeadersSection } from "./shared/CustomHeadersSection";
import { EnvVarsSection } from "./shared/EnvVarsSection";

interface AddServerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (formData: ServerFormData) => void;
}

export function AddServerModal({
  isOpen,
  onClose,
  onSubmit,
}: AddServerModalProps) {
  const posthog = usePostHog();
  const formState = useServerForm();

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

    if (formState.serverFormData.name) {
      const finalFormData = formState.buildFormData();

      // Validate form
      const validationError = formState.validateForm(finalFormData);
      if (validationError) {
        toast.error(validationError);
        return;
      }

      onSubmit(finalFormData);
      formState.resetForm();
      onClose();
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
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
              value={formState.serverFormData.name}
              onChange={(e) =>
                formState.setServerFormData((prev) => ({
                  ...prev,
                  name: e.target.value,
                }))
              }
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
            {formState.serverFormData.type === "stdio" ? (
              <div className="flex">
                <Select
                  value={formState.serverFormData.type}
                  onValueChange={(value: "stdio" | "http") =>
                    formState.setServerFormData((prev) => ({
                      ...prev,
                      type: value,
                    }))
                  }
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
                  value={formState.serverFormData.type}
                  onValueChange={(value: "stdio" | "http") =>
                    formState.setServerFormData((prev) => ({
                      ...prev,
                      type: value,
                    }))
                  }
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
                  value={formState.serverFormData.url}
                  onChange={(e) =>
                    formState.setServerFormData((prev) => ({
                      ...prev,
                      url: e.target.value,
                    }))
                  }
                  placeholder="http://localhost:8080/mcp"
                  required
                  className="flex-1 rounded-l-none"
                />
              </div>
            )}
          </div>

          {/* STDIO: Environment Variables */}
          {formState.serverFormData.type === "stdio" && (
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
          {formState.serverFormData.type === "http" && (
            <AuthenticationSection
              authType={formState.authType}
              onAuthTypeChange={(value) => {
                formState.setAuthType(value);
                formState.setShowAuthSettings(value !== "none");
                if (value === "oauth") {
                  formState.setServerFormData((prev) => ({
                    ...prev,
                    useOAuth: true,
                  }));
                } else {
                  formState.setServerFormData((prev) => ({
                    ...prev,
                    useOAuth: false,
                  }));
                }
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
          {formState.serverFormData.type === "http" && (
            <CustomHeadersSection
              customHeaders={formState.customHeaders}
              showCustomHeaders={formState.showCustomHeaders}
              onToggle={() =>
                formState.setShowCustomHeaders(!formState.showCustomHeaders)
              }
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

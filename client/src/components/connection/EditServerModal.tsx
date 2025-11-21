import type React from "react";
import { toast } from "sonner";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { ServerFormData } from "@/shared/types.js";
import { ServerWithName } from "@/hooks/use-app-state";
import { detectEnvironment, detectPlatform } from "@/logs/PosthogUtils";
import { usePostHog } from "posthog-js/react";
import { useServerForm } from "./hooks/use-server-form";
import { AuthenticationSection } from "./shared/AuthenticationSection";
import { CustomHeadersSection } from "./shared/CustomHeadersSection";
import { EnvVarsSection } from "./shared/EnvVarsSection";

interface EditServerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (
    formData: ServerFormData,
    originalServerName: string,
    skipAutoConnect?: boolean,
  ) => void;
  server: ServerWithName;
  skipAutoConnect?: boolean;
}

export function EditServerModal({
  isOpen,
  onClose,
  onSubmit,
  server,
  skipAutoConnect = false,
}: EditServerModalProps) {
  const posthog = usePostHog();

  // Use the shared form hook
  const {
    serverFormData,
    setServerFormData,
    commandInput,
    setCommandInput,
    oauthScopesInput,
    setOauthScopesInput,
    clientId,
    setClientId,
    clientSecret,
    setClientSecret,
    bearerToken,
    setBearerToken,
    authType,
    setAuthType,
    useCustomClientId,
    setUseCustomClientId,
    requestTimeout,
    setRequestTimeout,
    clientIdError,
    setClientIdError,
    clientSecretError,
    setClientSecretError,
    envVars,
    customHeaders,
    showEnvVars,
    setShowEnvVars,
    showAuthSettings,
    setShowAuthSettings,
    validateClientId,
    validateClientSecret,
    addEnvVar,
    removeEnvVar,
    updateEnvVar,
    addCustomHeader,
    removeCustomHeader,
    updateCustomHeader,
    buildFormData,
  } = useServerForm(server);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    // Validate Client ID if using custom configuration
    if (authType === "oauth" && useCustomClientId) {
      const clientIdError = validateClientId(clientId);
      if (clientIdError) {
        toast.error(clientIdError);
        return;
      }

      // Validate Client Secret if provided
      if (clientSecret) {
        const clientSecretError = validateClientSecret(clientSecret);
        if (clientSecretError) {
          toast.error(clientSecretError);
          return;
        }
      }
    }

    const finalFormData = buildFormData();
    onSubmit(finalFormData, server.name, skipAutoConnect);
    handleClose();
  };

  const handleClose = () => {
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader className="space-y-3">
          <DialogTitle className="flex text-sm font-semibold">
            <img src="/mcp.svg" alt="MCP" className="mr-2" /> Edit MCP Server
          </DialogTitle>
          <DialogDescription className="sr-only">
            Edit your MCP server configuration and authentication settings
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            posthog.capture("update_server_button_clicked", {
              location: "edit_server_modal_combined",
              platform: detectPlatform(),
              environment: detectEnvironment(),
            });
            handleSubmit(e);
          }}
          className="space-y-6"
        >
          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">
              Server Name
            </label>
            <Input
              value={serverFormData.name}
              onChange={(e) =>
                setServerFormData((prev) => ({
                  ...prev,
                  name: e.target.value,
                }))
              }
              placeholder="my-mcp-server"
              required
              className="h-10"
            />
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">
              Connection Type
            </label>
            {serverFormData.type === "stdio" ? (
              <div className="flex">
                <Select
                  value={serverFormData.type}
                  onValueChange={(value: "stdio" | "http") => {
                    // Preserve the current input value before switching
                    const currentValue = commandInput;
                    setServerFormData((prev) => ({
                      ...prev,
                      type: value,
                    }));

                    // Apply the preserved value to the appropriate field after switching
                    if (value === "http" && currentValue) {
                      setServerFormData((prev) => ({
                        ...prev,
                        url: currentValue,
                      }));
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
                  value={commandInput}
                  onChange={(e) => setCommandInput(e.target.value)}
                  placeholder="npx -y @modelcontextprotocol/server-everything"
                  required
                  className="flex-1 rounded-l-none text-sm border-border"
                />
              </div>
            ) : (
              <div className="flex">
                <Select
                  value={serverFormData.type}
                  onValueChange={(value: "stdio" | "http") => {
                    // Preserve the current input value before switching
                    const currentValue = serverFormData.url;
                    setServerFormData((prev) => ({
                      ...prev,
                      type: value,
                    }));

                    // Apply the preserved value to the appropriate field after switching
                    if (value === "stdio" && currentValue) {
                      setCommandInput(currentValue);
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
                  value={serverFormData.url}
                  onChange={(e) =>
                    setServerFormData((prev) => ({
                      ...prev,
                      url: e.target.value,
                    }))
                  }
                  placeholder="http://localhost:8080/mcp"
                  required
                  className="flex-1 rounded-l-none text-sm border-border"
                />
              </div>
            )}
          </div>

          {serverFormData.type === "http" && (
            <div className="space-y-3 pt-2">
              <AuthenticationSection
                authType={authType}
                onAuthTypeChange={(value) => {
                  setAuthType(value);
                  setShowAuthSettings(value !== "none");
                  setServerFormData((prev) => ({
                    ...prev,
                    useOAuth: value === "oauth",
                  }));
                }}
                showAuthSettings={showAuthSettings}
                bearerToken={bearerToken}
                onBearerTokenChange={setBearerToken}
                oauthScopesInput={oauthScopesInput}
                onOauthScopesChange={setOauthScopesInput}
                useCustomClientId={useCustomClientId}
                onUseCustomClientIdChange={(checked) => {
                  setUseCustomClientId(checked);
                  if (!checked) {
                    setClientId("");
                    setClientSecret("");
                    setClientIdError(null);
                    setClientSecretError(null);
                  }
                }}
                clientId={clientId}
                onClientIdChange={(value) => {
                  setClientId(value);
                  const error = validateClientId(value);
                  setClientIdError(error);
                }}
                clientSecret={clientSecret}
                onClientSecretChange={(value) => {
                  setClientSecret(value);
                  const error = validateClientSecret(value);
                  setClientSecretError(error);
                }}
                clientIdError={clientIdError}
                clientSecretError={clientSecretError}
              />
            </div>
          )}

          {serverFormData.type === "stdio" && (
            <EnvVarsSection
              envVars={envVars}
              showEnvVars={showEnvVars}
              onToggle={() => setShowEnvVars(!showEnvVars)}
              onAdd={addEnvVar}
              onRemove={removeEnvVar}
              onUpdate={updateEnvVar}
            />
          )}

          {serverFormData.type === "http" && (
            <CustomHeadersSection
              customHeaders={customHeaders}
              onAdd={addCustomHeader}
              onRemove={removeCustomHeader}
              onUpdate={updateCustomHeader}
            />
          )}

          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">
              Request Timeout (ms)
            </label>
            <Input
              type="number"
              value={requestTimeout}
              onChange={(e) => setRequestTimeout(e.target.value)}
              placeholder="10000"
              className="h-10"
              min="1000"
              max="600000"
              step="1000"
            />
            <p className="text-xs text-muted-foreground">
              Default 10000 (min 1000, max 600000)
            </p>
          </div>

          <div className="flex justify-end space-x-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                posthog.capture("cancel_button_clicked", {
                  location: "edit_server_modal_combined",
                  platform: detectPlatform(),
                  environment: detectEnvironment(),
                });
                handleClose();
              }}
              className="px-4"
            >
              Cancel
            </Button>
            <Button type="submit" className="px-4">
              Update Server
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

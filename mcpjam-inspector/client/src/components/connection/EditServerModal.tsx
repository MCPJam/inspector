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
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
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
  existingServerNames?: string[];
}

export function EditServerModal({
  isOpen,
  onClose,
  onSubmit,
  server,
  skipAutoConnect = false,
  existingServerNames = [],
}: EditServerModalProps) {
  const posthog = usePostHog();

  // Use the shared form hook
  const formState = useServerForm(server);
  const trimmedName = formState.name.trim();
  const isDuplicateServerName =
    trimmedName !== "" &&
    trimmedName !== server.name &&
    existingServerNames.includes(trimmedName);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isDuplicateServerName) {
      toast.error(
        `A server named "${trimmedName}" already exists. Choose a different name.`,
      );
      return;
    }

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

    const finalFormData = formState.buildFormData();
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
              value={formState.name}
              onChange={(e) => formState.setName(e.target.value)}
              placeholder="my-mcp-server"
              required
              className="h-10"
            />
            {isDuplicateServerName && (
              <p className="text-xs text-destructive">
                A server with this name already exists in this workspace.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">
              Connection Type
            </label>
            {formState.type === "stdio" ? (
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
                  className="flex-1 rounded-l-none text-sm border-border"
                />
              </div>
            ) : (
              <div className="flex">
                <Select
                  value={formState.type}
                  onValueChange={(value: "stdio" | "http") => {
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
                    <SelectItem value="stdio">STDIO</SelectItem>
                    <SelectItem value="http">HTTP</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  value={formState.url}
                  onChange={(e) => formState.setUrl(e.target.value)}
                  placeholder="http://localhost:8080/mcp"
                  required
                  className="flex-1 rounded-l-none text-sm border-border"
                />
              </div>
            )}
          </div>

          {formState.type === "http" && (
            <div className="space-y-3 pt-2">
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
            </div>
          )}

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

          {formState.type === "http" && (
            <CustomHeadersSection
              customHeaders={formState.customHeaders}
              onAdd={formState.addCustomHeader}
              onRemove={formState.removeCustomHeader}
              onUpdate={formState.updateCustomHeader}
            />
          )}

          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">
              Request Timeout (ms)
            </label>
            <Input
              type="number"
              value={formState.requestTimeout}
              onChange={(e) => formState.setRequestTimeout(e.target.value)}
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
            <Button
              type="submit"
              className="px-4"
              disabled={isDuplicateServerName}
            >
              Update Server
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

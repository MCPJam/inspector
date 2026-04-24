import { useEffect } from "react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@mcpjam/design-system/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { ServerFormData } from "@/shared/types.js";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { HOSTED_MODE } from "@/lib/config";
import { usePostHog } from "posthog-js/react";
import { useServerForm } from "./hooks/use-server-form";
import { AdvancedConnectionSettingsSection } from "./shared/AdvancedConnectionSettingsSection";
import { AuthenticationSection } from "./shared/AuthenticationSection";
import { EnvVarsSection } from "./shared/EnvVarsSection";
import { HostedConnectionTypeControl } from "./shared/HostedConnectionTypeControl";
import type { Workspace } from "@/state/app-types";

interface AddServerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (formData: ServerFormData) => void;
  initialData?: Partial<ServerFormData>;
  requireHttps?: boolean;
  workspaceClientConfig?: Workspace["clientConfig"];
}

export function AddServerModal({
  isOpen,
  onClose,
  onSubmit,
  initialData,
  requireHttps,
  workspaceClientConfig,
}: AddServerModalProps) {
  const posthog = usePostHog();
  const formState = useServerForm(undefined, {
    requireHttps,
    workspaceClientConfig,
  });
  const hostedUrlPlaceholder = "https://example.com/mcp";

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
        if (initialData.oauthProtocolMode) {
          formState.setOauthProtocolMode(initialData.oauthProtocolMode);
        }
        if (initialData.oauthRegistrationMode) {
          formState.setOauthRegistrationMode(initialData.oauthRegistrationMode);
          formState.setUseCustomClientId(
            initialData.oauthRegistrationMode === "preregistered",
          );
        }
        if (initialData.oauthScopes && initialData.oauthScopes.length > 0) {
          formState.setOauthScopesInput(initialData.oauthScopes.join(" "));
        }
        if (initialData.clientId) {
          formState.setUseCustomClientId(true);
          formState.setOauthRegistrationMode("preregistered");
          formState.setClientId(initialData.clientId);
        }
        if (initialData.clientSecret) {
          formState.setClientSecret(initialData.clientSecret);
        }
      } else if (
        initialData.headers &&
        initialData.headers["Authorization"] !== undefined
      ) {
        // Has Authorization header - set up bearer token
        formState.setAuthType("bearer");
        formState.setShowAuthSettings(true);
        formState.setBearerToken(initialData.headers["Authorization"] || "");
      }
      if (initialData.headers) {
        const headersArray = Object.entries(initialData.headers)
          .filter(([key]) => key !== "Authorization")
          .map(([key, value]) => ({
            key,
            value,
          }));
        if (headersArray.length > 0) {
          formState.setCustomHeaders(headersArray);
          formState.setShowConfiguration(true);
        }
      }
      if (
        typeof initialData.requestTimeout === "number" &&
        Number.isFinite(initialData.requestTimeout)
      ) {
        formState.setRequestTimeout(String(initialData.requestTimeout));
        formState.setShowConfiguration(true);
      }
      if (initialData.clientCapabilities) {
        formState.setClientCapabilitiesOverrideEnabled(true);
        formState.setClientCapabilitiesOverrideText(
          JSON.stringify(initialData.clientCapabilities, null, 2),
        );
        formState.setShowConfiguration(true);
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
    if (
      formState.authType === "oauth" &&
      formState.oauthRegistrationMode === "preregistered"
    ) {
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
            {HOSTED_MODE ? (
              formState.type === "stdio" ? (
                <HostedConnectionTypeControl transportType="stdio">
                  <Input
                    value={formState.commandInput}
                    onChange={(e) => formState.setCommandInput(e.target.value)}
                    placeholder="npx -y @modelcontextprotocol/server-everything"
                    required
                    className="flex-1 rounded-l-none"
                  />
                </HostedConnectionTypeControl>
              ) : (
                <HostedConnectionTypeControl transportType="http">
                  <Input
                    value={formState.url}
                    onChange={(e) => formState.setUrl(e.target.value)}
                    placeholder={hostedUrlPlaceholder}
                    required
                    className="flex-1 rounded-l-none"
                  />
                </HostedConnectionTypeControl>
              )
            ) : formState.type === "stdio" ? (
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
              serverUrl={formState.url}
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
              oauthProtocolMode={formState.oauthProtocolMode}
              onOauthProtocolModeChange={formState.setOauthProtocolMode}
              oauthRegistrationMode={formState.oauthRegistrationMode}
              onOauthRegistrationModeChange={
                formState.setOauthRegistrationMode
              }
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

          <AdvancedConnectionSettingsSection
            showConfiguration={formState.showConfiguration}
            onToggle={() =>
              formState.setShowConfiguration(!formState.showConfiguration)
            }
            requestTimeout={formState.requestTimeout}
            onRequestTimeoutChange={formState.setRequestTimeout}
            inheritedRequestTimeout={formState.inheritedRequestTimeout}
            clientCapabilitiesOverrideEnabled={
              formState.clientCapabilitiesOverrideEnabled
            }
            onClientCapabilitiesOverrideEnabledChange={(enabled) => {
              formState.setClientCapabilitiesOverrideEnabled(enabled);
              if (!enabled) {
                formState.setClientCapabilitiesOverrideError(null);
              }
            }}
            clientCapabilitiesOverrideText={
              formState.clientCapabilitiesOverrideText
            }
            onClientCapabilitiesOverrideTextChange={
              formState.setClientCapabilitiesOverrideText
            }
            clientCapabilitiesOverrideError={
              formState.clientCapabilitiesOverrideError
            }
            {...(formState.type === "http"
              ? {
                  customHeaders: formState.customHeaders,
                  onAddHeader: formState.addCustomHeader,
                  onRemoveHeader: formState.removeCustomHeader,
                  onUpdateHeader: formState.updateCustomHeader,
                }
              : {})}
          />

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

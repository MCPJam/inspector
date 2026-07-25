import { useEffect, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { toast } from "@/lib/toast";
import { normalizeRegistrationMode } from "@/shared/xaa.js";
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
import {
  ServerFormData,
  normalizeOauthProtocolMode,
} from "@/shared/types.js";
import { track } from "@/lib/analytics";
import { HOSTED_MODE } from "@/lib/config";
import { useAppReady, useAppReadyMessage } from "@/hooks/use-app-ready";
import { useServerForm } from "./hooks/use-server-form";
import { AdvancedConnectionSettingsSection } from "./shared/AdvancedConnectionSettingsSection";
import { AuthenticationSection } from "./shared/AuthenticationSection";
import { EnvVarsSection } from "./shared/EnvVarsSection";
import { HostedConnectionTypeControl } from "./shared/HostedConnectionTypeControl";
import { findProjectByAnyId, type Project } from "@/state/app-types";
import { useOptionalSharedAppState } from "@/state/app-state-context";
import { useActiveMcpProfile } from "@/contexts/active-mcp-profile-context";

interface AddServerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (formData: ServerFormData) => void;
  initialData?: Partial<ServerFormData>;
  requireHttps?: boolean;
  projectClientConfig?: Project["clientConfig"];
  organizationId?: string | null;
  isSignedIn?: boolean;
  /** Project default XAA test identity — shown as override placeholders. */
  projectXaaDefaultIdentity?: { subject: string; email: string } | null;
  /**
   * Shared (hosted) project id. When present, the Connection-overrides
   * section shows the per-server MCP protocol-version picker; the chosen
   * pin rides `ServerFormData.mcpProtocolVersionOverride` and the caller
   * persists it on the project layer once the hosted server row exists.
   * Absent (local-only / CLI contexts) the picker stays hidden — there is
   * no project row to bind the override to.
   */
  projectId?: string | null;
}

// normalizeOauthProtocolMode / ServerFormOAuthProtocolMode are single-sourced
// in shared/types (the normalizer preserves the 2026-07-28 draft era).

// Single-sourced in the SDK's registration vocabulary (accepts the legacy
// pre_registered alias; unknown → undefined so callers apply defaults).
const normalizeOauthRegistrationMode = normalizeRegistrationMode;

function isAuthorizationHeader(key: string): boolean {
  return key.trim().toLowerCase() === "authorization";
}

function getAuthorizationHeaderValue(
  headers?: Record<string, string>,
): string | undefined {
  if (!headers) {
    return undefined;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (isAuthorizationHeader(key)) {
      return value;
    }
  }

  return undefined;
}

function createHeaderEntry(key: string, value: string) {
  return {
    id:
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    key,
    value,
  };
}

export function resolveAddServerConfidentialCimdContext({
  organizationId,
  isSignedIn,
  activeProjectOrganizationId,
  hasSignedInUser,
}: {
  organizationId?: string | null;
  isSignedIn?: boolean;
  activeProjectOrganizationId?: string;
  hasSignedInUser: boolean;
}) {
  return {
    organizationId:
      organizationId !== undefined
        ? organizationId
        : activeProjectOrganizationId ?? null,
    isSignedIn: isSignedIn !== undefined ? isSignedIn : hasSignedInUser,
  };
}

export function AddServerModal({
  isOpen,
  onClose,
  onSubmit,
  initialData,
  requireHttps,
  projectClientConfig,
  organizationId,
  isSignedIn,
  projectXaaDefaultIdentity = null,
  projectId = null,
}: AddServerModalProps) {
  const appState = useOptionalSharedAppState();
  // Active host's mcpProfile — the host-level wire pin that "auto" OAuth
  // falls back to when no per-server override is set (see handleSubmit and
  // AuthenticationSection's serverMcpProtocolVersion prop). Provided by the
  // Servers tab's ActiveMcpProfileProvider; undefined in local/CLI contexts.
  const activeMcpProfile = useActiveMcpProfile();
  const activeProject = findProjectByAnyId(
    appState?.projects,
    appState?.activeProjectId,
  );
  const { user } = useAuth();
  const resolvedConfidentialCimdContext =
    resolveAddServerConfidentialCimdContext({
      organizationId,
      isSignedIn,
      activeProjectOrganizationId: activeProject?.organizationId,
      hasSignedInUser: Boolean(user),
    });
  const formState = useServerForm(undefined, {
    requireHttps,
    projectClientConfig,
    confidentialCimdProbeEnabled: isOpen,
    organizationId: resolvedConfidentialCimdContext.organizationId,
    isSignedIn: resolvedConfidentialCimdContext.isSignedIn,
  });
  // Per-server MCP wire-version pin. Lives OUTSIDE `useServerForm` on
  // purpose: the edit flow persists this on the project layer via
  // `projectServerConfig:setConfig` (see `ServerDetailModal`), never through
  // the server-save payload, so the shared form hook must not start
  // emitting it. Here it rides the one-shot `ServerFormData` and the add
  // path applies it once the hosted server row exists.
  const [mcpProtocolVersionOverride, setMcpProtocolVersionOverride] = useState<
    ServerFormData["mcpProtocolVersionOverride"]
  >(undefined);
  const hostedUrlPlaceholder = "https://example.com/mcp";
  const appReady = useAppReady();
  const appReadyMessage = useAppReadyMessage();
  const isAppBootstrapping = appReady.status !== "ready";

  // Initialize form with initial data if provided
  useEffect(() => {
    if (initialData && isOpen) {
      // Hydrate the per-server wire pin from the prefill so the OAuth-protocol
      // "auto" bridge sees it: a 2026-07-28-pinned prefill must resolve to the
      // 2026 OAuth flow and round-trip its pin, not silently drop to 2025.
      setMcpProtocolVersionOverride(initialData.mcpProtocolVersionOverride);
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
          formState.setOauthProtocolMode(
            normalizeOauthProtocolMode(initialData.oauthProtocolMode),
          );
        }
        if (initialData.registrationMode) {
          formState.setOauthRegistrationMode(
            normalizeOauthRegistrationMode(initialData.registrationMode) ??
              "auto",
          );
          formState.setUseCustomClientId(
            initialData.registrationMode === "preregistered",
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
        if (initialData.hasClientSecret) {
          formState.setHasStoredClientSecret(true);
        }
      } else if (initialData.useXaa || initialData.authMethod === "xaa") {
        formState.setAuthType("xaa");
        formState.setShowAuthSettings(true);
        formState.setOauthRegistrationMode(
          normalizeOauthRegistrationMode(initialData.registrationMode) ??
            "auto",
        );
        formState.setXaaClientAuth(
          initialData.xaaClientAuth === "private_key_jwt"
            ? "private_key_jwt"
            : "none",
        );
        formState.setUseCustomClientId(
          initialData.registrationMode === "preregistered" ||
            initialData.registrationMode === "auto" ||
            initialData.registrationMode == null,
        );
        if (initialData.oauthScopes?.length) {
          formState.setOauthScopesInput(initialData.oauthScopes.join(" "));
        }
        if (initialData.clientId) formState.setClientId(initialData.clientId);
        if (initialData.clientSecret) {
          formState.setClientSecret(initialData.clientSecret);
        }
        if (initialData.hasClientSecret) {
          formState.setHasStoredClientSecret(true);
        }
        formState.setXaaAuthzIssuer(initialData.xaaAuthzIssuer ?? "");
        formState.setXaaAllowPathScopedIssuer(
          initialData.xaaAllowPathScopedIssuer === true,
        );
        formState.setXaaSubject(initialData.xaaSubject ?? "");
        formState.setXaaEmail(initialData.xaaEmail ?? "");
      } else if (initialData.headers) {
        const authorizationHeader = getAuthorizationHeaderValue(
          initialData.headers,
        );

        if (authorizationHeader !== undefined) {
          // Has Authorization header - set up bearer token
          formState.setAuthType("bearer");
          formState.setShowAuthSettings(true);
          formState.setBearerToken(
            authorizationHeader.startsWith("Bearer ")
              ? authorizationHeader.replace("Bearer ", "")
              : authorizationHeader,
          );
        }
      }
      if (initialData.headers) {
        const headersArray = Object.entries(initialData.headers)
          .filter(([key]) => !isAuthorizationHeader(key))
          .map(([key, value]) => createHeaderEntry(key, value));
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
    setMcpProtocolVersionOverride(undefined);
    onClose();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (isAppBootstrapping) {
      toast.error(appReadyMessage ?? "App is still loading. Try again in a moment.");
      return;
    }

    // Validate Client ID if using custom configuration
    if (
      formState.authType === "oauth" &&
      formState.registrationMode === "preregistered"
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

    const finalFormData: ServerFormData = {
      ...formState.buildFormData({
        // Resolve a default ("auto") OAuth protocol against the effective wire
        // pin so a 2026-07-28-pinned server submits the 2026 OAuth flow, not
        // the 2025 default. Precedence mirrors AuthenticationSection's preview:
        // the per-server pin wins, else the active host's mcpProfile pin. An
        // explicit dropdown selection still wins over both.
        wireProtocolVersionOverride:
          mcpProtocolVersionOverride ?? activeMcpProfile?.mcpProtocolVersion,
      }),
      ...(mcpProtocolVersionOverride !== undefined
        ? { mcpProtocolVersionOverride }
        : {}),
    };
    onSubmit(finalFormData);
    formState.resetForm();
    setMcpProtocolVersionOverride(undefined);
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
              serverMcpProtocolVersion={mcpProtocolVersionOverride}
              registrationMode={formState.registrationMode}
              onOauthRegistrationModeChange={
                formState.setOauthRegistrationMode
              }
              xaaClientAuth={formState.xaaClientAuth}
              onXaaClientAuthChange={formState.setXaaClientAuth}
              confidentialCimdStatus={
                formState.confidentialCimdCapability.status
              }
              confidentialCimdBlockReason={
                formState.confidentialCimdBlockReason
              }
              onRetryConfidentialCimd={
                formState.confidentialCimdCapability.retry
              }
              useCustomClientId={formState.useCustomClientId}
              onUseCustomClientIdChange={(checked) => {
                formState.setUseCustomClientId(checked);
                if (!checked) {
                  formState.setClientId("");
                  formState.setClientSecret("");
                  if (formState.hasStoredClientSecret) {
                    formState.setClearClientSecret(true);
                  }
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
                if (value.trim()) {
                  formState.setClearClientSecret(false);
                }
                const error = formState.validateClientSecret(value);
                formState.setClientSecretError(error);
              }}
              hasStoredClientSecret={formState.hasStoredClientSecret}
              clearClientSecret={formState.clearClientSecret}
              onClearClientSecret={() => formState.setClearClientSecret(true)}
              onUndoClearClientSecret={() =>
                formState.setClearClientSecret(false)
              }
              clientIdError={formState.clientIdError}
              clientSecretError={formState.clientSecretError}
              xaaAuthzIssuer={formState.xaaAuthzIssuer}
              onXaaAuthzIssuerChange={formState.setXaaAuthzIssuer}
              xaaAllowPathScopedIssuer={formState.xaaAllowPathScopedIssuer}
              onXaaAllowPathScopedIssuerChange={
                formState.setXaaAllowPathScopedIssuer
              }
              xaaSubject={formState.xaaSubject}
              onXaaSubjectChange={formState.setXaaSubject}
              xaaEmail={formState.xaaEmail}
              onXaaEmailChange={formState.setXaaEmail}
              autoSelectsXaa={formState.autoSelectsXaa}
              projectDefaultIdentity={projectXaaDefaultIdentity}
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
            showMcpProtocolVersionOverride={Boolean(projectId)}
            mcpProtocolVersionOverride={mcpProtocolVersionOverride}
            onMcpProtocolVersionOverrideChange={setMcpProtocolVersionOverride}
            transportKind={formState.type === "http" ? "http" : "stdio"}
            {...(formState.type === "http"
              ? {
                  customHeaders: formState.customHeaders,
                  onAddHeader: formState.addCustomHeader,
                  onRemoveHeader: formState.removeCustomHeader,
                  onUpdateHeader: formState.updateCustomHeader,
                  headersWarning: formState.oauthAuthorizationHeaderWarning,
                }
              : {})}
          />

          {/* Action Buttons */}
          <div className="flex justify-end space-x-2 pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                track("cancel_button_clicked", {
                  location: "add_server_modal",
                });
                handleClose();
              }}
              className="px-4"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                formState.authConfigurationBlocksSubmit || isAppBootstrapping
              }
              title={isAppBootstrapping ? appReadyMessage ?? undefined : undefined}
              onClick={() => {
                track("add_server_button_clicked", {
                  location: "add_server_modal",
                });
              }}
              className="px-4"
            >
              {isAppBootstrapping ? appReadyMessage ?? "Loading..." : "Add Server"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

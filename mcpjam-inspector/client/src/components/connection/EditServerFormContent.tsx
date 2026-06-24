import { Input } from "@mcpjam/design-system/input";
import { useCallback, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { AdvancedConnectionSettingsSection } from "./shared/AdvancedConnectionSettingsSection";
import { AuthenticationSection } from "./shared/AuthenticationSection";
import { EnvVarsSection } from "./shared/EnvVarsSection";
import { HostedConnectionTypeControl } from "./shared/HostedConnectionTypeControl";
import type { useServerForm } from "./hooks/use-server-form";
import { HOSTED_MODE } from "@/lib/config";
import type { McpProtocolVersion } from "@/lib/client-config-v2";
import { fetchServerSecrets } from "@/lib/apis/server-secrets-api";

interface EditServerFormContentProps {
  formState: ReturnType<typeof useServerForm>;
  isDuplicateServerName: boolean;
  projectId?: string | null;
  hostedServerId?: string | null;
  /**
   * Per-server wire-mode override from the project server config.
   * Sourced from `projectServerConfig:getConfig().overrides[serverId]
   * .mcpProtocolVersionOverride`. Undefined = inherit host default. Persistence
   * goes back through `projectServerConfig:setConfig`, NOT through the
   * server's own config blob — wire mode is a project-server-refs field.
   */
  mcpProtocolVersionOverride?: McpProtocolVersion;
  onMcpProtocolVersionOverrideChange?: (
    mode: McpProtocolVersion | undefined
  ) => void;
}

export function EditServerFormContent({
  formState,
  isDuplicateServerName,
  projectId = null,
  hostedServerId = null,
  mcpProtocolVersionOverride,
  onMcpProtocolVersionOverrideChange,
}: EditServerFormContentProps) {
  const hostedUrlPlaceholder = "https://example.com/mcp";
  const [revealingEnv, setRevealingEnv] = useState(false);
  const [revealingHeaders, setRevealingHeaders] = useState(false);
  const [revealingBearer, setRevealingBearer] = useState(false);
  const [envRevealError, setEnvRevealError] = useState<string | null>(null);
  const [headersRevealError, setHeadersRevealError] = useState<string | null>(
    null
  );
  const [bearerRevealError, setBearerRevealError] = useState<string | null>(
    null
  );

  const revealSecrets = useCallback(
    // "bearer" reuses the headers reveal — fetchServerSecrets returns the full
    // header set, and revealStoredHeaders routes Authorization to the bearer
    // field while keeping the rest as custom headers.
    async (kind: "env" | "headers" | "bearer") => {
      const setRevealing =
        kind === "env"
          ? setRevealingEnv
          : kind === "bearer"
          ? setRevealingBearer
          : setRevealingHeaders;
      const setError =
        kind === "env"
          ? setEnvRevealError
          : kind === "bearer"
          ? setBearerRevealError
          : setHeadersRevealError;

      if (!projectId || !hostedServerId) {
        setError("Server secrets can only be revealed after saving.");
        return;
      }

      setRevealing(true);
      setError(null);

      try {
        const result = await fetchServerSecrets({
          projectId,
          serverId: hostedServerId,
        });
        if (kind === "env") {
          formState.revealStoredEnv(result.env);
        } else {
          formState.revealStoredHeaders(result.headers);
        }
      } catch {
        setError(
          "Couldn't reveal saved secrets. Try again, or re-save this server's env vars/headers."
        );
      } finally {
        setRevealing(false);
      }
    },
    [formState, hostedServerId, projectId]
  );

  return (
    <div className="space-y-6">
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
            A server with this name already exists in this project.
          </p>
        )}
      </div>

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
                className="flex-1 rounded-l-none text-sm border-border"
              />
            </HostedConnectionTypeControl>
          ) : (
            <HostedConnectionTypeControl transportType="http">
              <Input
                value={formState.url}
                onChange={(e) => formState.setUrl(e.target.value)}
                placeholder={hostedUrlPlaceholder}
                required
                className="flex-1 rounded-l-none text-sm border-border"
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
            serverUrl={formState.url}
            authType={formState.authType}
            onAuthTypeChange={(value) => {
              formState.setAuthType(value);
              formState.setShowAuthSettings(value !== "none");
            }}
            showAuthSettings={formState.showAuthSettings}
            bearerToken={formState.bearerToken}
            onBearerTokenChange={formState.setBearerToken}
            hasStoredBearerToken={formState.hasStoredBearerToken}
            onRevealBearerToken={() => revealSecrets("bearer")}
            isRevealingBearerToken={revealingBearer}
            bearerRevealError={bearerRevealError}
            oauthScopesInput={formState.oauthScopesInput}
            onOauthScopesChange={formState.setOauthScopesInput}
            oauthProtocolMode={formState.oauthProtocolMode}
            onOauthProtocolModeChange={formState.setOauthProtocolMode}
            oauthRegistrationMode={formState.oauthRegistrationMode}
            onOauthRegistrationModeChange={formState.setOauthRegistrationMode}
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
            projectId={projectId}
            hostedServerId={hostedServerId}
            xaaAuthzIssuer={formState.xaaAuthzIssuer}
            onXaaAuthzIssuerChange={formState.setXaaAuthzIssuer}
            xaaSubject={formState.xaaSubject}
            onXaaSubjectChange={formState.setXaaSubject}
            xaaEmail={formState.xaaEmail}
            onXaaEmailChange={formState.setXaaEmail}
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
          hasStoredEnv={formState.hasStoredEnv}
          isRevealing={revealingEnv}
          revealError={envRevealError}
          onReveal={() => revealSecrets("env")}
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
        /* Render the row regardless of whether a setter is wired. When
           `onMcpProtocolVersionOverrideChange` is absent (no project/server
           id, or project config still loading), the select disables but
           remains visible for discoverability. */
        showMcpProtocolVersionOverride
        mcpProtocolVersionOverride={mcpProtocolVersionOverride}
        onMcpProtocolVersionOverrideChange={onMcpProtocolVersionOverrideChange}
        transportKind={formState.type}
        {...(formState.type === "http"
          ? {
              customHeaders: formState.customHeaders,
              onAddHeader: formState.addCustomHeader,
              onRemoveHeader: formState.removeCustomHeader,
              onUpdateHeader: formState.updateCustomHeader,
              hasStoredHeaders: formState.hasStoredHeaders,
              isRevealingHeaders: revealingHeaders,
              headersRevealError,
              onRevealHeaders: () => revealSecrets("headers"),
              headersWarning: formState.oauthAuthorizationHeaderWarning,
            }
          : {})}
      />
    </div>
  );
}

import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { AuthenticationSection } from "./shared/AuthenticationSection";
import { CustomHeadersSection } from "./shared/CustomHeadersSection";
import { EnvVarsSection } from "./shared/EnvVarsSection";
import { HostedConnectionTypeControl } from "./shared/HostedConnectionTypeControl";
import type { useServerForm } from "./hooks/use-server-form";
import { HOSTED_MODE } from "@/lib/config";

interface EditServerFormContentProps {
  formState: ReturnType<typeof useServerForm>;
  isDuplicateServerName: boolean;
}

export function EditServerFormContent({
  formState,
  isDuplicateServerName,
}: EditServerFormContentProps) {
  const hostedUrlPlaceholder = "https://example.com/mcp";

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
            A server with this name already exists in this workspace.
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
    </div>
  );
}

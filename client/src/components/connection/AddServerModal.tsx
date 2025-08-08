import { useState } from "react";
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
import { ServerFormData } from "@/shared/types.js";

interface AddServerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConnect: (formData: ServerFormData) => void;
}

export function AddServerModal({
  isOpen,
  onClose,
  onConnect,
}: AddServerModalProps) {
  const [serverFormData, setServerFormData] = useState<ServerFormData>({
    name: "",
    type: "stdio",
    command: "",
    args: [],
    url: "",
    headers: {},
    env: {},
    useOAuth: true,
    oauthScopes: ["mcp:*"],
    clientId: "",
  });
  const [commandInput, setCommandInput] = useState("");
  const [oauthScopesInput, setOauthScopesInput] = useState("");
  const [clientId, setClientId] = useState("");
  const [bearerToken, setBearerToken] = useState("");
  const [authType, setAuthType] = useState<"oauth" | "bearer" | "none">("none");
  const [useCustomClientId, setUseCustomClientId] = useState(false);
  const [clientIdError, setClientIdError] = useState<string | null>(null);
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>(
    [],
  );

  // Basic client ID validation
  const validateClientId = (id: string): string | null => {
    if (!id.trim()) {
      return "Client ID is required when using manual configuration";
    }

    // Basic format validation - most OAuth providers use alphanumeric with hyphens/underscores
    const validPattern =
      /^[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;
    if (!validPattern.test(id.trim())) {
      return "Client ID should contain only letters, numbers, dots, hyphens, and underscores";
    }

    if (id.trim().length < 3) {
      return "Client ID must be at least 3 characters long";
    }

    if (id.trim().length > 100) {
      return "Client ID must be less than 100 characters long";
    }

    return null;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    // Validate Client ID if using custom configuration
    if (authType === "oauth" && useCustomClientId) {
      const clientIdError = validateClientId(clientId);
      if (clientIdError) {
        toast.error(clientIdError);
        return;
      }
    }

    if (serverFormData.name) {
      let finalFormData = { ...serverFormData };

      if (serverFormData.type === "stdio" && commandInput) {
        const parts = commandInput.split(" ").filter((part) => part.trim());
        const command = parts[0] || "";
        const args = parts.slice(1);
        finalFormData = { ...finalFormData, command, args };

        // Add environment variables for STDIO
        const envObj = envVars.reduce(
          (acc, { key, value }) => {
            if (key && value) acc[key] = value;
            return acc;
          },
          {} as Record<string, string>,
        );
        finalFormData = { ...finalFormData, env: envObj };
      }

      if (serverFormData.type === "http") {
        if (authType === "none") {
          finalFormData = {
            ...finalFormData,
            useOAuth: false,
          };
        } else if (authType === "bearer" && bearerToken) {
          finalFormData = {
            ...finalFormData,
            headers: {
              ...finalFormData.headers,
              Authorization: `Bearer ${bearerToken}`,
            },
            useOAuth: false,
          };
        } else if (
          authType === "oauth" &&
          serverFormData.useOAuth &&
          oauthScopesInput
        ) {
          const scopes = oauthScopesInput
            .split(" ")
            .filter((scope) => scope.trim());
          finalFormData = {
            ...finalFormData,
            oauthScopes: scopes,
            clientId: useCustomClientId
              ? clientId.trim() || undefined
              : undefined,
          };
        }
      }

      onConnect(finalFormData);
      resetForm();
      onClose();
    }
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const resetForm = () => {
    setServerFormData({
      name: "",
      type: "stdio",
      command: "",
      args: [],
      url: "",
      headers: {},
      env: {},
      useOAuth: true,
      oauthScopes: ["mcp:*"],
      clientId: "",
    });
    setCommandInput("");
    setOauthScopesInput("");
    setClientId("");
    setBearerToken("");
    setAuthType("none");
    setUseCustomClientId(false);
    setClientIdError(null);
    setEnvVars([]);
  };

  const addEnvVar = () => {
    setEnvVars([...envVars, { key: "", value: "" }]);
  };

  const removeEnvVar = (index: number) => {
    setEnvVars(envVars.filter((_, i) => i !== index));
  };

  const updateEnvVar = (
    index: number,
    field: "key" | "value",
    value: string,
  ) => {
    const updated = [...envVars];
    updated[index][field] = value;
    setEnvVars(updated);
  };

  const handleClientIdChange = (value: string) => {
    setClientId(value);
    // Clear error when user starts typing
    if (clientIdError) {
      setClientIdError(null);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-md sm:max-w-lg">
        <DialogHeader className="space-y-2">
          <DialogTitle className="flex text-xl font-semibold">
            <img src="/mcp.svg" alt="MCP" className="mr-2" /> Add MCP Server
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6">
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
                  onValueChange={(value: "stdio" | "http") =>
                    setServerFormData((prev) => ({
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
                    <SelectItem value="http">HTTP/SSE</SelectItem>
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
                  onValueChange={(value: "stdio" | "http") =>
                    setServerFormData((prev) => ({
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
                  value={serverFormData.url}
                  onChange={(e) =>
                    setServerFormData((prev) => ({
                      ...prev,
                      url: e.target.value,
                    }))
                  }
                  placeholder="http://localhost:8080/mcp"
                  required
                  className="flex-1 rounded-l-none text-sm"
                />
              </div>
            )}
          </div>

          {serverFormData.type === "stdio" && (
            <div className="space-y-4 p-4 border rounded-lg bg-muted/30 border-border/50">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-foreground">
                  Environment Variables
                </label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addEnvVar}
                  className="h-8 px-2 text-xs cursor-pointer"
                >
                  Add Variable
                </Button>
              </div>
              {envVars.length > 0 && (
                <div className="space-y-2">
                  {envVars.map((envVar, index) => (
                    <div key={index} className="flex gap-2">
                      <Input
                        placeholder="key"
                        value={envVar.key}
                        onChange={(e) =>
                          updateEnvVar(index, "key", e.target.value)
                        }
                        className="h-8 text-sm"
                      />
                      <Input
                        placeholder="value"
                        value={envVar.value}
                        onChange={(e) =>
                          updateEnvVar(index, "value", e.target.value)
                        }
                        className="h-8 text-sm"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => removeEnvVar(index)}
                        className="h-8 px-2 text-xs"
                      >
                        ×
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {serverFormData.type === "http" && (
            <div className="space-y-4 p-4 border rounded-lg bg-muted/30 border-border/50">
              <div className="space-y-3">
                <label className="block text-sm font-medium text-foreground">
                  Authentication Method
                </label>
                <div className="flex gap-4">
                  <div className="flex items-center space-x-2">
                    <input
                      type="radio"
                      id="none"
                      name="authType"
                      checked={authType === "none"}
                      onChange={() => setAuthType("none")}
                      className="w-4 h-4 cursor-pointer"
                    />
                    <label htmlFor="none" className="text-sm cursor-pointer">
                      None
                    </label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <input
                      type="radio"
                      id="oauth"
                      name="authType"
                      checked={authType === "oauth"}
                      onChange={() => setAuthType("oauth")}
                      className="w-4 h-4 cursor-pointer"
                    />
                    <label htmlFor="oauth" className="text-sm cursor-pointer">
                      OAuth 2.1
                    </label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <input
                      type="radio"
                      id="bearer"
                      name="authType"
                      checked={authType === "bearer"}
                      onChange={() => setAuthType("bearer")}
                      className="w-4 h-4 cursor-pointer"
                    />
                    <label htmlFor="bearer" className="text-sm cursor-pointer">
                      Bearer Token
                    </label>
                  </div>
                </div>
              </div>

              {authType === "oauth" && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <label className="block text-sm font-medium text-foreground">
                      OAuth Scopes
                    </label>
                    <Input
                      value={oauthScopesInput}
                      onChange={(e) => setOauthScopesInput(e.target.value)}
                      placeholder="mcp:* mcp:tools mcp:resources"
                      className="h-10"
                    />
                    <p className="text-xs text-muted-foreground">
                      Space-separated OAuth scopes. Use &apos;mcp:*&apos; for
                      full access.
                    </p>
                  </div>
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <label className="block text-sm font-medium text-foreground">
                        Client Registration Method
                      </label>
                      <div className="flex items-center space-x-6">
                        <div className="flex items-center space-x-2">
                          <input
                            type="radio"
                            id="dynamic-registration"
                            name="clientRegistration"
                            checked={!useCustomClientId}
                            onChange={() => setUseCustomClientId(false)}
                            className="w-4 h-4 cursor-pointer"
                          />
                          <label
                            htmlFor="dynamic-registration"
                            className="text-sm cursor-pointer"
                          >
                            Dynamic Registration
                          </label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <input
                            type="radio"
                            id="manual-client-id"
                            name="clientRegistration"
                            checked={useCustomClientId}
                            onChange={() => setUseCustomClientId(true)}
                            className="w-4 h-4 cursor-pointer"
                          />
                          <label
                            htmlFor="manual-client-id"
                            className="text-sm cursor-pointer"
                          >
                            Manual Client ID
                          </label>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Dynamic registration lets the server automatically
                        assign a client ID. Manual configuration allows you to
                        specify a pre-registered client ID.
                      </p>
                    </div>

                    {useCustomClientId && (
                      <div className="space-y-2">
                        <label className="block text-sm font-medium text-foreground">
                          Client ID <span className="text-red-500">*</span>
                        </label>
                        <Input
                          value={clientId}
                          onChange={(e) => handleClientIdChange(e.target.value)}
                          placeholder="your-registered-client-id"
                          className={`h-10 ${clientIdError ? "border-red-500 focus:border-red-500" : ""}`}
                          required={useCustomClientId}
                        />
                        {clientIdError ? (
                          <p className="text-xs text-red-600">
                            {clientIdError}
                          </p>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            Enter the client ID that was pre-registered with the
                            OAuth provider. This must match exactly what was
                            configured on the server.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {authType === "bearer" && (
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-foreground">
                    Bearer Token
                  </label>
                  <Input
                    type="password"
                    value={bearerToken}
                    onChange={(e) => setBearerToken(e.target.value)}
                    placeholder="Enter your bearer token"
                    className="h-10"
                  />
                  <p className="text-xs text-muted-foreground">
                    Token will be sent as Authorization: Bearer &lt;token&gt;
                    header
                  </p>
                </div>
              )}
            </div>
          )}

          <div className="flex gap-3 pt-6 border-t">
            <Button type="submit" className="flex-1 cursor-pointer">
              Connect Server
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleClose}
              className="flex-1 cursor-pointer"
            >
              Cancel
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

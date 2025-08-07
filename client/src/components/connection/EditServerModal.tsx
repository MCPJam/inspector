import { useState, useEffect } from "react";
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
import { ServerFormData } from "@/lib/types";
import { ServerWithName } from "@/hooks/use-app-state";

interface EditServerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onUpdate: (originalServerName: string, formData: ServerFormData) => void;
  server: ServerWithName;
}

export function EditServerModal({
  isOpen,
  onClose,
  onUpdate,
  server,
}: EditServerModalProps) {
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
  });
  const [commandInput, setCommandInput] = useState("");
  const [oauthScopesInput, setOauthScopesInput] = useState("");
  const [bearerToken, setBearerToken] = useState("");
  const [authType, setAuthType] = useState<"oauth" | "bearer" | "none">("none");
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>(
    [],
  );

  // Convert ServerWithName to ServerFormData format
  const convertServerConfig = (server: ServerWithName): ServerFormData => {
    const config = server.config;
    const isHttpServer = "url" in config;

    if (isHttpServer) {
      // Extract bearer token from headers if present
      const headers =
        (config.requestInit?.headers as Record<string, string>) || {};
      const hasOAuth = server.oauthTokens != null;

      return {
        name: server.name,
        type: "http",
        url: config.url?.toString() || "",
        headers: headers,
        useOAuth: hasOAuth,
        oauthScopes: server.oauthTokens?.scope?.split(" ") || ["mcp:*"],
      };
    } else {
      // STDIO server
      return {
        name: server.name,
        type: "stdio",
        command: config.command || "",
        args: config.args || [],
        env: config.env || {},
      };
    }
  };

  // Initialize form with server data
  useEffect(() => {
    if (server && isOpen) {
      const formData = convertServerConfig(server);
      setServerFormData(formData);

      // Set additional form state
      if (formData.type === "stdio") {
        const command = formData.command || "";
        const args = formData.args || [];
        setCommandInput([command, ...args].join(" "));

        // Convert env object to key-value pairs
        const envEntries = Object.entries(formData.env || {}).map(
          ([key, value]) => ({
            key,
            value,
          }),
        );
        setEnvVars(envEntries);
      } else {
        // HTTP server
        const headers = formData.headers || {};
        const authHeader = headers.Authorization;
        const hasBearerToken = authHeader?.startsWith("Bearer ");
        const hasOAuth = formData.useOAuth;

        if (hasOAuth) {
          setAuthType("oauth");
          setOauthScopesInput(formData.oauthScopes?.join(" ") || "mcp:*");
          // Ensure useOAuth is true when we have OAuth tokens
          setServerFormData((prev) => ({ ...prev, useOAuth: true }));
        } else if (hasBearerToken) {
          setAuthType("bearer");
          setBearerToken(authHeader.slice(7)); // Remove 'Bearer ' prefix
          // Ensure useOAuth is false for bearer token
          setServerFormData((prev) => ({ ...prev, useOAuth: false }));
        } else {
          setAuthType("none");
          // Ensure useOAuth is false for no auth
          setServerFormData((prev) => ({ ...prev, useOAuth: false }));
        }
      }
    }
  }, [server, isOpen]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
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
            headers: {}, // Clear any existing auth headers
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
        } else if (authType === "oauth" && oauthScopesInput) {
          const scopes = oauthScopesInput
            .split(" ")
            .filter((scope) => scope.trim());
          finalFormData = {
            ...finalFormData,
            useOAuth: true,
            oauthScopes: scopes,
            headers: {}, // Clear any existing auth headers for OAuth
          };
        }
      }

      onUpdate(server.name, finalFormData);
      onClose();
    }
  };

  const handleClose = () => {
    onClose();
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

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-md sm:max-w-lg">
        <DialogHeader className="space-y-2">
          <DialogTitle className="flex text-xl font-semibold">
            <img src="/mcp.svg" alt="MCP" className="mr-2"/> Edit MCP Server
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
                        �
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
                      onChange={() => {
                        setAuthType("none");
                        setServerFormData((prev) => ({
                          ...prev,
                          useOAuth: false,
                        }));
                      }}
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
                      onChange={() => {
                        setAuthType("oauth");
                        setServerFormData((prev) => ({
                          ...prev,
                          useOAuth: true,
                        }));
                      }}
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
                      onChange={() => {
                        setAuthType("bearer");
                        setServerFormData((prev) => ({
                          ...prev,
                          useOAuth: false,
                        }));
                      }}
                      className="w-4 h-4 cursor-pointer"
                    />
                    <label htmlFor="bearer" className="text-sm cursor-pointer">
                      Bearer Token
                    </label>
                  </div>
                </div>
              </div>

              {authType === "oauth" && (
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
                    Space-separated OAuth scopes. Use &apos;mcp:*&apos; for full
                    access.
                  </p>
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
              Update Server
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

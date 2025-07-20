"use client";

import { useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { ServerFormData } from "@/lib/types";

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
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (serverFormData.name) {
      onConnect(serverFormData);
      setServerFormData({
        name: "",
        type: "stdio",
        command: "",
        args: [],
        url: "",
        headers: {},
        env: {},
        useOAuth: false,
        oauthScopes: ["mcp:*"],
      });
      onClose();
    }
  };

  const handleArgsChange = (value: string) => {
    setServerFormData((prev) => ({
      ...prev,
      args: value.split(" ").filter((arg) => arg.trim()),
    }));
  };

  const handleClose = () => {
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
    });
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add New Server</DialogTitle>
          <DialogDescription>
            Configure a new MCP server connection
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">
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
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Type</label>
            <select
              value={serverFormData.type}
              onChange={(e) =>
                setServerFormData((prev) => ({
                  ...prev,
                  type: e.target.value as "stdio" | "http",
                }))
              }
              className="w-full p-2 border rounded-md bg-background cursor-pointer"
            >
              <option value="stdio">STDIO</option>
              <option value="http">HTTP</option>
            </select>
          </div>

          {serverFormData.type === "stdio" ? (
            <>
              <div>
                <label className="block text-sm font-medium mb-1">
                  Command
                </label>
                <Input
                  value={serverFormData.command}
                  onChange={(e) =>
                    setServerFormData((prev) => ({
                      ...prev,
                      command: e.target.value,
                    }))
                  }
                  placeholder="npx"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">
                  Arguments
                </label>
                <Input
                  value={serverFormData.args?.join(" ") || ""}
                  onChange={(e) => handleArgsChange(e.target.value)}
                  placeholder="-y @modelcontextprotocol/server-filesystem /path/to/directory"
                />
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium mb-1">URL</label>
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
                />
              </div>

              <div className="space-y-3 p-4 border rounded-lg bg-muted/50">
                <div className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    id="useOAuth"
                    checked={serverFormData.useOAuth}
                    onChange={(e) =>
                      setServerFormData((prev) => ({
                        ...prev,
                        useOAuth: e.target.checked,
                      }))
                    }
                    className="w-4 h-4 cursor-pointer"
                  />
                  <label
                    htmlFor="useOAuth"
                    className="text-sm font-medium cursor-pointer"
                  >
                    Use OAuth 2.1 Authentication
                  </label>
                </div>

                {serverFormData.useOAuth && (
                  <div>
                    <label className="block text-sm font-medium mb-1">
                      OAuth Scopes
                    </label>
                    <Input
                      value={serverFormData.oauthScopes?.join(" ") || ""}
                      onChange={(e) =>
                        setServerFormData((prev) => ({
                          ...prev,
                          oauthScopes: e.target.value
                            .split(" ")
                            .filter((s) => s.trim()),
                        }))
                      }
                      placeholder="mcp:* mcp:tools mcp:resources"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Space-separated OAuth scopes. Use &apos;mcp:*&apos; for
                      full access.
                    </p>
                  </div>
                )}
              </div>
            </>
          )}

          <div className="flex gap-2 pt-4">
            <Button type="submit" className="cursor-pointer">
              Connect Server
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleClose}
              className="cursor-pointer"
            >
              Cancel
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

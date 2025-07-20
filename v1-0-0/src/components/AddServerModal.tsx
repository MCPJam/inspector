"use client";

import { useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
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
  const [commandInput, setCommandInput] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (serverFormData.name) {
      let finalFormData = { ...serverFormData };

      if (serverFormData.type === "stdio" && commandInput) {
        const parts = commandInput.split(" ").filter((part) => part.trim());
        const command = parts[0] || "";
        const args = parts.slice(1);
        finalFormData = { ...finalFormData, command, args };
      }

      onConnect(finalFormData);
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
      setCommandInput("");
      onClose();
    }
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
    setCommandInput("");
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-md sm:max-w-lg">
        <DialogHeader className="space-y-2">
          <DialogTitle className="text-xl font-semibold">
            Add MCP Server
          </DialogTitle>
          <p className="text-sm text-muted-foreground">
            Configure a new MCP server connection
          </p>
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

          {serverFormData.type === "http" && (
            <div className="space-y-4 p-4 border rounded-lg bg-muted/30 border-border/50">
              <div className="flex items-center space-x-3">
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
                  className="w-4 h-4 cursor-pointer rounded border-border"
                />
                <label
                  htmlFor="useOAuth"
                  className="text-sm font-medium cursor-pointer text-foreground"
                >
                  Use OAuth 2.1 Authentication
                </label>
              </div>

              {serverFormData.useOAuth && (
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-foreground">
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
                    className="h-10"
                  />
                  <p className="text-xs text-muted-foreground">
                    Space-separated OAuth scopes. Use &apos;mcp:*&apos; for full
                    access.
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

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ServerWithName } from "@/hooks/use-app-state";
import {
  listTools,
  type ListToolsResultWithMetadata,
} from "@/lib/mcp-tools-api";
import { Loader2, X } from "lucide-react";
import { toast } from "sonner";

interface ServerDetailModalProps {
  server: ServerWithName | null;
  isOpen: boolean;
  onClose: () => void;
}

export function ServerDetailModal({
  server,
  isOpen,
  onClose,
}: ServerDetailModalProps) {
  const [tools, setTools] = useState<ListToolsResultWithMetadata | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && server) {
      loadTools();
    }
  }, [isOpen, server]);

  const loadTools = async () => {
    if (!server) return;

    setIsLoading(true);
    setError(null);
    try {
      const result = await listTools(server.name);
      setTools(result);
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to load tools";
      setError(errorMessage);
      toast.error(`Failed to load tools: ${errorMessage}`);
    } finally {
      setIsLoading(false);
    }
  };

  if (!server) return null;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle className="text-xl font-semibold flex items-center gap-3">
              <div className="h-12 w-12 rounded-lg bg-gradient-to-br from-pink-500 to-rose-600 flex items-center justify-center text-white text-xl font-bold">
                {server.name[0]?.toUpperCase() || "S"}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  {server.name}
                  {server.config && "url" in server.config}
                </div>
              </div>
            </DialogTitle>
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="h-8 w-8 p-0"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </DialogHeader>

        <div className="space-y-6 mt-4">
          {/* Actions Section */}
          <div>
            <div className="mb-3">
              <h3 className="text-lg font-semibold">Actions</h3>
            </div>

            {isLoading && !tools ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : error ? (
              <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800/30 rounded-lg p-4 text-sm text-red-600 dark:text-red-400">
                {error}
              </div>
            ) : tools && tools.tools.length > 0 ? (
              (() => {
                // Filter tools that have metadata
                const toolsWithMetadata = tools.tools.filter(
                  (tool) => tools.toolsMetadata?.[tool.name],
                );

                if (toolsWithMetadata.length === 0) {
                  return (
                    <div className="bg-muted/30 rounded-lg p-8 text-center">
                      <p className="text-sm text-muted-foreground">
                        No widget metadata
                      </p>
                    </div>
                  );
                }

                return (
                  <div className="space-y-3">
                    {toolsWithMetadata.map((tool) => {
                      const metadata = tools.toolsMetadata?.[tool.name];

                      return (
                        <div
                          key={tool.name}
                          className="bg-muted/30 rounded-lg p-4 space-y-2 hover:bg-muted/50 transition-colors"
                        >
                          <div className="flex items-start justify-between">
                            <div className="flex-1">
                              <div className="flex items-center gap-2">
                                <h4 className="font-medium text-sm">
                                  {tool.name}
                                </h4>
                                {metadata.write !== undefined && (
                                  <span className="text-xs px-2 py-0.5 bg-primary/10 text-primary rounded-md uppercase">
                                    {metadata.write ? "WRITE" : "READ"}
                                  </span>
                                )}
                              </div>
                              <p className="text-sm text-muted-foreground mt-1">
                                {tool.description || "No description available"}
                              </p>
                            </div>
                          </div>

                          {/* Metadata Section - Show all metadata fields */}
                          <div className="mt-3 pt-3 border-t border-border/50">
                            <div className="text-xs text-muted-foreground font-medium mb-2">
                              METADATA
                            </div>

                            {Object.entries(metadata).map(([key, value]) => {
                              // Skip the 'write' field as it's already shown as a badge
                              if (key === "write") return null;

                              return (
                                <div key={key} className="space-y-1 mt-2">
                                  <div className="text-xs text-muted-foreground">
                                    {key.replace(/([A-Z])/g, " $1").trim()}
                                  </div>
                                  <div
                                    className={`text-xs rounded px-2 py-1 ${
                                      typeof value === "string" &&
                                      value.includes("://")
                                        ? "font-mono bg-muted/50"
                                        : "bg-muted/50"
                                    }`}
                                  >
                                    {typeof value === "object"
                                      ? JSON.stringify(value, null, 2)
                                      : String(value)}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()
            ) : (
              <div className="bg-muted/30 rounded-lg p-8 text-center">
                <p className="text-sm text-muted-foreground">
                  No actions available for this server
                </p>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

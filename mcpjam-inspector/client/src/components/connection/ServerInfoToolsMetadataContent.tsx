import type { ListToolsResultWithMetadata } from "@/lib/apis/mcp-tools-api";
import { JsonEditor } from "@/components/ui/json-editor";
import { Tool } from "@modelcontextprotocol/sdk/types.js";

interface ServerInfoToolsMetadataContentProps {
  toolsData: ListToolsResultWithMetadata | null;
}

export function ServerInfoToolsMetadataContent({
  toolsData,
}: ServerInfoToolsMetadataContentProps) {
  const hasToolMetadata = (toolsData?.tools ?? []).some(
    (tool) => (tool as Tool)?._meta || toolsData?.toolsMetadata?.[tool.name],
  );

  if (!hasToolMetadata) {
    return (
      <div className="text-sm text-muted-foreground text-center py-8">
        No tool metadata available
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {(toolsData?.tools ?? [])
        .map((tool: Tool) => {
          const metadata = tool._meta ?? toolsData?.toolsMetadata?.[tool.name];
          const annotations = tool.annotations;

          if (!metadata) return null;
          return (
            <div
              key={tool.name}
              className="bg-muted/30 rounded-lg p-4 space-y-3"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <h4 className="font-medium text-sm">{tool.name}</h4>
                    {metadata?.write !== undefined && (
                      <span className="text-xs px-2 py-0.5 bg-primary/10 text-primary rounded uppercase">
                        {metadata?.write ? "WRITE" : "READ"}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">
                    {tool.description || "No description available"}
                  </p>
                </div>
              </div>

              {/* Metadata Section */}
              {metadata && (
                <div className="pt-3 border-t border-border/50">
                  <div className="text-xs text-muted-foreground font-medium mb-3">
                    METADATA
                  </div>

                  {Object.entries(metadata ?? {}).map(([key, value]) => {
                    if (key === "write") return null;

                    return (
                      <div key={key} className="space-y-1 mt-2">
                        <div className="text-xs text-muted-foreground">
                          {key.replace(/([A-Z])/g, " $1").trim()}
                        </div>
                        <div
                          className={`text-xs rounded px-2 py-1 ${
                            typeof value === "string" && value.includes("://")
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
              )}

              {annotations && (
                <div className="pt-3 border-t border-border/50">
                  <div className="text-xs text-muted-foreground font-medium mb-3">
                    ANNOTATIONS
                  </div>
                  <JsonEditor
                    showLineNumbers={false}
                    height="100%"
                    value={annotations}
                    viewOnly
                  />
                </div>
              )}
            </div>
          );
        })
        .filter(Boolean)}
    </div>
  );
}

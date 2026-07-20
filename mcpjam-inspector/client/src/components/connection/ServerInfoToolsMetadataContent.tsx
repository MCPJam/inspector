import type { ListToolsResultWithMetadata } from "@/lib/apis/mcp-tools-api";
import { ScrollableJsonView } from "@/components/ui/json-editor";
import type { Tool } from "@modelcontextprotocol/client";

interface ServerInfoToolsMetadataContentProps {
  toolsData: ListToolsResultWithMetadata | null;
}

export function ServerInfoToolsMetadataContent({
  toolsData,
}: ServerInfoToolsMetadataContentProps) {
  const tools = toolsData?.tools ?? [];

  // The tab is labelled "Tools", so always list the server's tools — most MCP
  // servers ship tools without `_meta`, and gating the whole list on metadata
  // made a normal server's tools tab read "No tools" (#125K4kNJ). Metadata and
  // annotations are surfaced per-tool below only when they exist.
  if (tools.length === 0) {
    return (
      <div className="text-sm text-muted-foreground text-center py-8">
        No tools available
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {tools
        .map((tool: Tool) => {
          const metadata = tool._meta ?? toolsData?.toolsMetadata?.[tool.name];
          const annotations = tool.annotations;

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
                  <ScrollableJsonView
                    value={annotations}
                    showLineNumbers={false}
                    containerClassName="max-h-96 rounded-lg"
                  />
                </div>
              )}
            </div>
          );
        })}
    </div>
  );
}

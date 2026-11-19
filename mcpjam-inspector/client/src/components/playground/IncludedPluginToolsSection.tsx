import { Button } from "@mcpjam/design-system/button";
import { useExtensionWorkspaceState, type IncludedPluginToolScope } from "@/components/host-workspace/ExtensionWorkspaceProvider";
import { SchemaViewer } from "@/components/ui/schema-viewer";
import { useEnvironmentTools } from "@/hooks/use-environment-tools";
import { getToolVisibility } from "@/lib/mcp-ui/mcp-apps-utils";
import { ToolSourceHeader } from "./ToolSourceHeader";

/** The hidden environment lists its own plugin servers, not device connections. */
export function IncludedPluginToolsSection() {
  const target = useExtensionWorkspaceState(
    (state) => state.includedPluginTools,
  );
  if (!target || !target.serverIds.length) return null;
  return <PluginCatalog key={JSON.stringify([target.ownerKey, target.environmentId])} target={target} />;
}

function PluginCatalog({ target }: { target: IncludedPluginToolScope }) {
  const { servers, isLoading, error, refresh } = useEnvironmentTools(target.projectId, target.environmentId);
  const included = (servers ?? [])
    .filter((server) => target.serverIds.includes(server.serverId))
    .map((server) => ({
      ...server,
      tools: server.tools.filter(
        (tool) =>
          target.includeAppOnly ||
          getToolVisibility(tool._meta).includes("model"),
      ),
    }))
    .filter((server) => server.error || server.tools.length > 0);
  return (
    <section
      aria-label="Plugin tools in this chat"
      className="max-h-[45%] shrink-0 overflow-y-auto border-t border-border px-2 py-2"
    >
      <div className="flex items-center justify-between gap-2 px-3 pb-1">
        <h2 className="text-xs font-medium">Plugin tools in this chat</h2>
        <Button variant="ghost" size="sm" onClick={refresh}>
          Refresh
        </Button>
      </div>
      <p className="px-3 pb-2 text-xs text-muted-foreground">
        These tools are available to the agent. Ask in chat to run them.
      </p>
      {error ? (
        <p role="alert" className="px-3 text-xs text-destructive">
          Couldn&apos;t load plugin tools. Try Refresh.
        </p>
      ) : isLoading && !servers ? (
        <p role="status" className="px-3 text-xs text-muted-foreground">
          Loading plugin tools...
        </p>
      ) : included.length === 0 ? (
        <p className="px-3 text-xs text-muted-foreground">
          No plugin tools are available for this chat.
        </p>
      ) : (
        included.map((server) => (
          <ToolSourceHeader
            key={server.serverId}
            title={server.name}
            chip="Plugin"
          >
            {server.error ? (
              <p role="alert" className="px-3 text-xs text-destructive">
                Couldn&apos;t load these tools. Try Refresh.
              </p>
            ) : (
              server.tools.map((tool) => (
                <details
                  key={tool.name}
                  className="rounded-md px-3 py-1 text-xs"
                >
                  <summary className="cursor-pointer font-mono">
                    {tool.name}
                  </summary>
                  {tool.description ? (
                    <p className="py-1 text-muted-foreground">
                      {tool.description}
                    </p>
                  ) : null}
                  <SchemaViewer schema={tool.inputSchema} />
                </details>
              ))
            )}
          </ToolSourceHeader>
        ))
      )}
    </section>
  );
}

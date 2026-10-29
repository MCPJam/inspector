import { Badge } from "@mcpjam/design-system/badge";
import { cn } from "@mcpjam/design-system/cn";
import { ToolSourceHeader } from "./ToolSourceHeader";
import type { AppPaneGroup } from "./app-pane-tools";
import { useAppPaneTools } from "./use-app-pane-tools";

const droppedCopy = {
  entry_cap:
    "The model can't see this tool. Only the first 64 app tools are sent.",
  schema_too_large:
    "The model can't see this tool. Its input schema is over 8 KiB.",
  schema_unserializable:
    "The model can't see this tool. Its input schema can't be read.",
};

export function AppToolsSection({
  searchQuery,
  selectedKey,
  onSelect,
  previewedHarnessId,
  groups: suppliedGroups,
}: {
  searchQuery: string;
  selectedKey?: string | null;
  onSelect: (key: string) => void;
  previewedHarnessId?: string | null;
  groups?: AppPaneGroup[];
}) {
  const liveGroups = useAppPaneTools();
  const query = searchQuery.trim().toLowerCase();
  const groups = (suppliedGroups ?? liveGroups)
    .map((group) => ({
      ...group,
      tools: group.tools.filter((tool) =>
        `${group.appName} ${group.serverId} ${tool.rawName} ${tool.description ?? ""}`
          .toLowerCase()
          .includes(query),
      ),
    }))
    .filter((group) => group.tools.length);
  if (!groups.length) return null;
  const harnessName =
    previewedHarnessId === "claude-code"
      ? "Claude Code"
      : previewedHarnessId === "codex"
        ? "Codex"
        : previewedHarnessId;
  return (
    <ToolSourceHeader title="App tools">
      <div className="space-y-3" data-testid="app-tools-section">
        {groups.map((group) => (
          <ToolSourceHeader
            key={group.key}
            title={group.appName}
            chip={group.serverId}
          >
            {group.tools.map((tool) => (
              <button
                type="button"
                key={tool.key}
                onClick={() => onSelect(tool.key)}
                className={cn(
                  "w-full rounded-md px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selectedKey === tool.key
                    ? "bg-primary/10"
                    : "hover:bg-muted/50",
                )}
              >
                <div className="flex items-center gap-1.5">
                  <code className="min-w-0 flex-1 truncate text-xs font-medium">
                    {tool.rawName}
                  </code>
                  {tool.readOnly ? (
                    <Badge
                      variant="outline"
                      title="The app claims this tool only reads. MCPJam doesn't enforce it."
                    >
                      app says read-only
                    </Badge>
                  ) : null}
                </div>
                {tool.description ? (
                  <p className="mt-1 text-[10px] text-muted-foreground line-clamp-2">
                    {tool.description}
                  </p>
                ) : null}
                {!previewedHarnessId && tool.availability !== "offered" ? (
                  <p className="mt-1 text-[10px] text-warning">
                    {droppedCopy[tool.availability]}
                  </p>
                ) : null}
              </button>
            ))}
          </ToolSourceHeader>
        ))}
        <p className="px-3 text-[10px] text-muted-foreground">
          {harnessName
            ? `${harnessName} can't call app tools. Run still calls them in the app.`
            : "Available to the model on its next request. They go away when the app closes."}
        </p>
      </div>
    </ToolSourceHeader>
  );
}

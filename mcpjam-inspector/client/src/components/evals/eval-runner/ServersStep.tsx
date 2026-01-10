import { Button } from "@/components/ui/button";
import { ServerSelectionCard } from "../ServerSelectionCard";
import type { ServerWithName } from "@/state/app-types";

interface ServersStepProps {
  connectedServers: Array<[string, ServerWithName]>;
  selectedServers: string[];
  onToggleServer: (name: string) => void;
}

export function ServersStep({
  connectedServers,
  selectedServers,
  onToggleServer,
}: ServersStepProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg pb-2">Select servers to test</h3>
          <p className="text-sm text-muted-foreground pb-2">
            Choose at least one connected MCP server. You can evaluate multiple
            servers in the same run.
          </p>
        </div>
      </div>

      {connectedServers.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {connectedServers.map(([name, server]) => {
            const isSelected = selectedServers.includes(name);
            return (
              <ServerSelectionCard
                key={name}
                server={server}
                selected={isSelected}
                onToggle={onToggleServer}
              />
            );
          })}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">
            No connected servers yet
          </p>
          <p className="mt-2">
            Launch a server from the Workspaces tab to make it available here.
            Once connected, it will appear instantly.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-4"
            onClick={() => {
              window.location.hash = "servers";
            }}
          >
            Go to Workspaces tab
          </Button>
        </div>
      )}
    </div>
  );
}

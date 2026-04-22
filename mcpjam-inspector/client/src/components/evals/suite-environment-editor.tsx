import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Loader2, PlugZap, Server, Unplug } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import type { EvalSuite } from "./types";
import {
  buildSuiteEnvironmentOptions,
  filterServerBindings,
  normalizeServerNames,
  type WorkspaceServerRecord,
} from "./suite-environment-utils";

type SuiteEnvironmentEditorProps = {
  suite: Pick<EvalSuite, "_id" | "environment">;
  workspaceServers: WorkspaceServerRecord[];
  connectedServerNames: ReadonlySet<string>;
  onSave: (environment: EvalSuite["environment"]) => Promise<void>;
};

export function SuiteEnvironmentEditor({
  suite,
  workspaceServers,
  connectedServerNames,
  onSave,
}: SuiteEnvironmentEditorProps) {
  const configuredServers = useMemo(
    () => normalizeServerNames(suite.environment?.servers),
    [suite.environment?.servers],
  );
  const [selectedServers, setSelectedServers] =
    useState<string[]>(configuredServers);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setSelectedServers(configuredServers);
  }, [configuredServers]);

  const options = useMemo(
    () =>
      buildSuiteEnvironmentOptions({
        configuredServers,
        workspaceServers,
        connectedServerNames,
      }),
    [configuredServers, workspaceServers, connectedServerNames],
  );

  const isDirty =
    JSON.stringify(selectedServers) !== JSON.stringify(configuredServers);

  const toggleServer = (serverName: string, checked: boolean) => {
    setSelectedServers((current) => {
      if (checked) {
        return current.includes(serverName) ? current : [...current, serverName];
      }
      return current.filter((candidate) => candidate !== serverName);
    });
  };

  const handleReset = () => {
    setSelectedServers(configuredServers);
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSave({
        servers: selectedServers,
        serverBindings: filterServerBindings(
          suite.environment?.serverBindings,
          selectedServers,
        ),
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold text-foreground">Servers</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Configure the MCP servers this suite uses for generation, runs, and
          SDK export.
        </p>
      </div>

      {options.length === 0 ? (
        <div className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
          No workspace servers are available yet. Add servers in the workspace
          first, then return here to attach them to this suite.
        </div>
      ) : (
        <div className="space-y-2 rounded-xl border bg-card/60 p-3">
          {options.map((option) => {
            const isSelected = selectedServers.includes(option.name);
            const isUnavailable = !option.isInWorkspace;

            return (
              <label
                key={option.name}
                className="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-3 transition-colors hover:bg-accent/35"
              >
                <Checkbox
                  checked={isSelected}
                  onCheckedChange={(checked) =>
                    toggleServer(option.name, checked === true)
                  }
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {option.name}
                    </span>
                    {option.isConnected ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">
                        <CheckCircle2 className="h-3 w-3" />
                        Connected
                      </span>
                    ) : option.isInWorkspace ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                        <Unplug className="h-3 w-3" />
                        Disconnected
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">
                        <PlugZap className="h-3 w-3" />
                        Not in workspace
                      </span>
                    )}
                    {option.isConfigured && !isSelected ? (
                      <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                        Currently configured
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {isUnavailable
                      ? "This server is still referenced by the suite but no longer exists in the workspace server list."
                      : option.isConnected
                        ? "Ready to use right now."
                        : "Saved on the suite, but not currently connected in the playground."}
                  </p>
                </div>
              </label>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <Server className="h-3.5 w-3.5" />
          <span>
            {selectedServers.length === 0
              ? "No servers configured"
              : `${selectedServers.length} server${
                  selectedServers.length === 1 ? "" : "s"
                } configured`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleReset}
            disabled={!isDirty || isSaving}
          >
            Reset
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void handleSave()}
            disabled={!isDirty || isSaving}
          >
            {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save servers
          </Button>
        </div>
      </div>
    </section>
  );
}

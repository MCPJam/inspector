import { useMemo } from "react";
import { toast } from "sonner";
import { AlertTriangle, RefreshCcw, Save } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Card } from "@mcpjam/design-system/card";
import { Badge } from "@mcpjam/design-system/badge";
import { JsonEditor } from "@/components/ui/json-editor";
import type { Workspace } from "@/state/app-types";
import {
  getEffectiveServerClientCapabilities,
  workspaceClientCapabilitiesNeedReconnect,
  type WorkspaceClientConfig,
} from "@/lib/client-config";
import { useClientConfigStore } from "@/stores/client-config-store";

interface ClientConfigTabProps {
  activeWorkspaceId: string;
  workspace?: Workspace;
  onSaveClientConfig: (
    workspaceId: string,
    clientConfig: WorkspaceClientConfig | undefined,
  ) => Promise<void>;
}

export function ClientConfigTab({
  activeWorkspaceId,
  workspace,
  onSaveClientConfig,
}: ClientConfigTabProps) {
  const draftConfig = useClientConfigStore((s) => s.draftConfig);
  const clientCapabilitiesText = useClientConfigStore(
    (s) => s.clientCapabilitiesText,
  );
  const hostContextText = useClientConfigStore((s) => s.hostContextText);
  const clientCapabilitiesError = useClientConfigStore(
    (s) => s.clientCapabilitiesError,
  );
  const hostContextError = useClientConfigStore((s) => s.hostContextError);
  const isDirty = useClientConfigStore((s) => s.isDirty);
  const isSaving = useClientConfigStore((s) => s.isSaving);
  const setSectionText = useClientConfigStore((s) => s.setSectionText);
  const resetSectionToDefault = useClientConfigStore(
    (s) => s.resetSectionToDefault,
  );
  const resetToBaseline = useClientConfigStore((s) => s.resetToBaseline);
  const failSave = useClientConfigStore((s) => s.failSave);

  const reconnectServers = useMemo(() => {
    if (!workspace) {
      return [];
    }

    return Object.values(workspace.servers).filter((server) => {
      if (server.connectionStatus !== "connected") {
        return false;
      }

      return workspaceClientCapabilitiesNeedReconnect({
        desiredCapabilities: getEffectiveServerClientCapabilities({
          workspaceClientConfig: workspace.clientConfig,
          serverCapabilities: server.config.capabilities as
            | Record<string, unknown>
            | undefined,
        }),
        initializedCapabilities: server.initializationInfo
          ?.clientCapabilities as Record<string, unknown> | undefined,
      });
    });
  }, [workspace]);

  const handleSave = async () => {
    if (!draftConfig) {
      return;
    }
    if (clientCapabilitiesError || hostContextError) {
      toast.error("Fix JSON validation errors before saving.");
      return;
    }

    try {
      await onSaveClientConfig(activeWorkspaceId, draftConfig);
      toast.success("Workspace client profile saved.");
    } catch {
      failSave();
    }
  };

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-6">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">
                Client Config
              </h1>
              <p className="text-sm text-muted-foreground">
                Applies to the active workspace only.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {isDirty ? (
                <Badge variant="secondary">Unsaved changes</Badge>
              ) : (
                <Badge variant="outline">Saved</Badge>
              )}
              <Button
                variant="outline"
                onClick={resetToBaseline}
                disabled={isSaving || !isDirty}
              >
                <RefreshCcw className="mr-2 h-4 w-4" />
                Reset
              </Button>
              <Button onClick={handleSave} disabled={isSaving || !isDirty}>
                <Save className="mr-2 h-4 w-4" />
                {isSaving ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>

          {reconnectServers.length > 0 ? (
            <Card className="border-amber-500/30 bg-amber-500/5 p-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-600" />
                <div className="space-y-1">
                  <div className="text-sm font-medium">Needs reconnect</div>
                  <p className="text-sm text-muted-foreground">
                    Saved client capabilities differ from the last initialize
                    payload for:{" "}
                    {reconnectServers.map((server) => server.name).join(", ")}.
                  </p>
                </div>
              </div>
            </Card>
          ) : null}
        </div>

        <div className="grid gap-6 xl:grid-cols-2">
          <Card className="flex min-h-[620px] flex-col p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">clientCapabilities</div>
                <p className="text-sm text-muted-foreground">
                  Sent on the next connect or reconnect.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => resetSectionToDefault("clientCapabilities")}
              >
                Reset to default
              </Button>
            </div>
            {clientCapabilitiesError ? (
              <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {clientCapabilitiesError}
              </div>
            ) : null}
            <div className="min-h-0 flex-1">
              <JsonEditor
                rawContent={clientCapabilitiesText}
                onRawChange={(value) =>
                  setSectionText("clientCapabilities", value)
                }
                mode="edit"
                readOnly={isSaving}
                showModeToggle={false}
                className="h-full border"
                height="100%"
                wrapLongLinesInEdit={false}
                showLineNumbers
              />
            </div>
          </Card>

          <Card className="flex min-h-[620px] flex-col p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">hostContext</div>
                <p className="text-sm text-muted-foreground">
                  Applied live to mounted MCP Apps widgets.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => resetSectionToDefault("hostContext")}
              >
                Reset to default
              </Button>
            </div>
            {hostContextError ? (
              <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {hostContextError}
              </div>
            ) : null}
            <div className="min-h-0 flex-1">
              <JsonEditor
                rawContent={hostContextText}
                onRawChange={(value) => setSectionText("hostContext", value)}
                mode="edit"
                readOnly={isSaving}
                showModeToggle={false}
                className="h-full border"
                height="100%"
                wrapLongLinesInEdit={false}
                showLineNumbers
              />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

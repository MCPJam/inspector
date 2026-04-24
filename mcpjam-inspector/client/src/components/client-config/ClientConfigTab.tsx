import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Globe,
  Puzzle,
  AppWindow,
  RefreshCcw,
  Save,
  RotateCcw,
} from "lucide-react";
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

/** Toolbar + status bar; textarea uses leading-5 and p-3. */
const JSON_EDITOR_TOOLBAR_STATUS_PX = 72;
const JSON_LINE_PX = 20;
const JSON_TEXTAREA_VERTICAL_PAD_PX = 24;

function useContentSizedJsonHeight(
  text: string,
  minRem: number,
  maxRem: number,
  maxViewportFraction: number,
): string {
  const [vh, setVh] = useState(
    () =>
      (typeof globalThis !== "undefined" && "innerHeight" in globalThis
        ? (globalThis as Window).innerHeight
        : 900),
  );
  useEffect(() => {
    const win = globalThis as Window & typeof globalThis;
    if (!("addEventListener" in win) || !("innerHeight" in win)) {
      return;
    }
    const onResize = () => setVh(win.innerHeight);
    win.addEventListener("resize", onResize);
    return () => win.removeEventListener("resize", onResize);
  }, []);

  return useMemo(() => {
    const lines = Math.max(1, text.split("\n").length);
    const contentPx =
      JSON_EDITOR_TOOLBAR_STATUS_PX +
      JSON_TEXTAREA_VERTICAL_PAD_PX +
      lines * JSON_LINE_PX;
    const minPx = minRem * 16;
    const capPx = Math.min(maxRem * 16, vh * maxViewportFraction);
    return `${Math.min(capPx, Math.max(minPx, contentPx))}px`;
  }, [text, vh, minRem, maxRem, maxViewportFraction]);
}

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
  const connectionDefaultsText = useClientConfigStore(
    (s) => s.connectionDefaultsText,
  );
  const clientCapabilitiesText = useClientConfigStore(
    (s) => s.clientCapabilitiesText,
  );
  const hostContextText = useClientConfigStore((s) => s.hostContextText);
  const connectionDefaultsError = useClientConfigStore(
    (s) => s.connectionDefaultsError,
  );
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

  const connectionDefaultsHeight = useContentSizedJsonHeight(
    connectionDefaultsText,
    7.5,
    32,
    0.45,
  );
  const clientCapabilitiesHeight = useContentSizedJsonHeight(
    clientCapabilitiesText,
    7.5,
    36,
    0.5,
  );
  const hostContextHeight = useContentSizedJsonHeight(
    hostContextText,
    7.5,
    32,
    0.45,
  );

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
    if (
      connectionDefaultsError ||
      clientCapabilitiesError ||
      hostContextError
    ) {
      toast.error("Fix JSON validation errors before saving.");
      return;
    }

    try {
      await onSaveClientConfig(activeWorkspaceId, draftConfig);
      toast.success("Workspace connection settings saved.");
    } catch {
      failSave();
    }
  };

  const sections = [
    {
      key: "connectionDefaults" as const,
      icon: Globe,
      title: "Connection defaults",
      code: "connectionDefaults",
      description:
        "Default HTTP headers and request timeout. Servers can override.",
      text: connectionDefaultsText,
      error: connectionDefaultsError,
      height: connectionDefaultsHeight,
    },
    {
      key: "clientCapabilities" as const,
      icon: Puzzle,
      title: "Client capabilities",
      code: "clientCapabilities",
      description:
        "Initialize payload. Sent the next time a server connects or reconnects.",
      text: clientCapabilitiesText,
      error: clientCapabilitiesError,
      height: clientCapabilitiesHeight,
    },
    {
      key: "hostContext" as const,
      icon: AppWindow,
      title: "Host context",
      code: "hostContext",
      description:
        "Passed to mounted MCP App widgets. Updates apply live in the app surface.",
      text: hostContextText,
      error: hostContextError,
      height: hostContextHeight,
    },
  ];

  return (
    <div className="h-full overflow-auto">
      <div className="flex w-full min-w-0 flex-col gap-5 px-4 py-4 sm:px-6 sm:py-5">
        {/* Header */}
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div className="min-w-0">
              <h1 className="text-balance text-xl font-semibold tracking-tight sm:text-2xl">
                Connection Settings
              </h1>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                Workspace-scoped JSON: defaults for HTTP,{" "}
                <span className="whitespace-nowrap">MCP capabilities</span>, and
                app host context.
              </p>
            </div>
            <div className="flex flex-shrink-0 flex-wrap items-center gap-2 sm:justify-end">
              {isDirty ? (
                <Badge
                  variant="secondary"
                  className="border border-primary/20 bg-primary/10 text-primary"
                >
                  Unsaved changes
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="border-border/60 text-muted-foreground"
                >
                  Saved
                </Badge>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={resetToBaseline}
                disabled={isSaving || !isDirty}
              >
                <RefreshCcw className="mr-1.5 h-3.5 w-3.5" />
                Reset
              </Button>
              <Button
                size="sm"
                onClick={handleSave}
                disabled={isSaving || !isDirty}
              >
                <Save className="mr-1.5 h-3.5 w-3.5" />
                {isSaving ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>

          {reconnectServers.length > 0 && (
            <Card className="border-amber-500/30 bg-amber-500/5 p-3.5">
              <div className="flex items-start gap-3">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-500/15">
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                </div>
                <div className="space-y-0.5">
                  <div className="text-sm font-medium">Needs reconnect</div>
                  <p className="text-[13px] leading-relaxed text-muted-foreground">
                    Saved client capabilities differ from the last initialize
                    payload for:{" "}
                    {reconnectServers.map((server) => server.name).join(", ")}.
                  </p>
                </div>
              </div>
            </Card>
          )}
        </div>

        {/* Sections */}
        <div className="flex min-w-0 flex-col gap-4">
          {sections.map((section) => {
            const Icon = section.icon;
            return (
              <section key={section.key} className="min-w-0">
                <div className="overflow-hidden rounded-xl border border-border/60 bg-card shadow-sm transition-shadow hover:shadow-md">
                  {/* Section header */}
                  <div className="flex items-start justify-between gap-3 border-b border-border/50 bg-muted/30 px-4 py-3">
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                        <Icon className="h-3.5 w-3.5 text-primary" />
                      </div>
                      <div className="min-w-0 space-y-0.5">
                        <div className="flex items-center gap-2">
                          <h2 className="text-sm font-semibold text-foreground">
                            {section.title}
                          </h2>
                          <code className="rounded bg-muted/80 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground [font-family:var(--font-code,ui-monospace,monospace)]">
                            {section.code}
                          </code>
                        </div>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          {section.description}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 shrink-0 gap-1.5 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                      onClick={() => resetSectionToDefault(section.key)}
                    >
                      <RotateCcw className="h-3 w-3" />
                      Reset
                    </Button>
                  </div>

                  {/* Editor area */}
                  <div className="min-w-0 p-2">
                    {section.error && (
                      <div className="mb-2 flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                        <AlertTriangle className="h-3 w-3 shrink-0" />
                        {section.error}
                      </div>
                    )}
                    <div className="min-w-0 overflow-hidden rounded-lg border border-border/50 bg-background">
                      <JsonEditor
                        rawContent={section.text}
                        onRawChange={(value) =>
                          setSectionText(section.key, value)
                        }
                        mode="edit"
                        readOnly={isSaving}
                        showModeToggle={false}
                        className="border-0 bg-background"
                        height={section.height}
                        wrapLongLinesInEdit={false}
                        showLineNumbers
                      />
                    </div>
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

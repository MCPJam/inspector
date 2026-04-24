import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, RotateCcw, Save } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { JsonEditor } from "@/components/ui/json-editor";
import type { Workspace } from "@/state/app-types";
import {
  getEffectiveServerClientCapabilities,
  workspaceClientCapabilitiesNeedReconnect,
  type WorkspaceClientConfig,
} from "@/lib/client-config";
import { useClientConfigStore } from "@/stores/client-config-store";

/** Toolbar (~34px) + status bar (~28px) + a bit of breathing room. */
const JSON_EDITOR_TOOLBAR_STATUS_PX = 72;
const JSON_LINE_PX = 20;
/** Extra vertical padding so the last line isn't hidden behind the status bar. */
const JSON_TEXTAREA_VERTICAL_PAD_PX = 44;

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
      title: "Connection defaults",
      text: connectionDefaultsText,
      error: connectionDefaultsError,
      height: connectionDefaultsHeight,
    },
    {
      key: "clientCapabilities" as const,
      title: "Client capabilities",
      text: clientCapabilitiesText,
      error: clientCapabilitiesError,
      height: clientCapabilitiesHeight,
    },
    {
      key: "hostContext" as const,
      title: "Host context",
      text: hostContextText,
      error: hostContextError,
      height: hostContextHeight,
    },
  ];

  return (
    <div className="h-full overflow-auto">
      <div className="flex w-full min-w-0 flex-col gap-4 px-4 py-3 sm:px-5 sm:py-4">
        {/* Header — pr-8 keeps buttons clear of the dialog close ✕ */}
        <div className="flex items-center justify-between gap-4 pr-8">
          <h1 className="text-lg font-semibold tracking-tight">
            Connection Settings
          </h1>
          <div className="flex shrink-0 items-center gap-2">
            {isDirty && (
              <span className="text-xs text-muted-foreground">Unsaved</span>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={resetToBaseline}
              disabled={isSaving || !isDirty}
              className="h-7 text-xs"
            >
              Reset
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={isSaving || !isDirty}
              className="h-7 text-xs"
            >
              <Save className="mr-1.5 h-3 w-3" />
              {isSaving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>

        {reconnectServers.length > 0 && (
          <div className="flex items-center gap-2 rounded border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-3 w-3 shrink-0" />
            Capabilities changed for{" "}
            {reconnectServers.map((s) => s.name).join(", ")} — reconnect to
            apply.
          </div>
        )}

        {/* Sections */}
        <div className="flex min-w-0 flex-col gap-3">
          {sections.map((section) => (
            <section key={section.key} className="min-w-0">
              <div className="mb-1.5 flex items-center justify-between">
                <label className="text-xs font-medium text-foreground">
                  {section.title}
                </label>
                <button
                  type="button"
                  className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => resetSectionToDefault(section.key)}
                >
                  <RotateCcw className="h-2.5 w-2.5" />
                  Reset
                </button>
              </div>
              {section.error && (
                <div className="mb-1.5 flex items-center gap-1.5 text-xs text-destructive">
                  <AlertTriangle className="h-3 w-3 shrink-0" />
                  {section.error}
                </div>
              )}
              <div className="min-w-0 overflow-hidden rounded-md border border-border/70 bg-background">
                <JsonEditor
                  rawContent={section.text}
                  onRawChange={(value) => setSectionText(section.key, value)}
                  mode="edit"
                  readOnly={isSaving}
                  showModeToggle={false}
                  className="border-0 bg-background"
                  height={section.height}
                  wrapLongLinesInEdit={false}
                  showLineNumbers
                />
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

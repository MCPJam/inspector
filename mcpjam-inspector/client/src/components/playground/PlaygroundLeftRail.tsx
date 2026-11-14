import { useCallback, useState } from "react";
import { Hammer, History, PanelLeftClose } from "lucide-react";
import { track } from "@/lib/analytics";
import { ChatHistoryRail } from "@/components/chat-v2/history/ChatHistoryRail";
import { PlaygroundServerConnectButton } from "./PlaygroundServerConnectButton";
import { usePlaygroundStateContext } from "@/components/ui-playground/hooks/use-playground-state";
import { PlaygroundLeft } from "@/components/ui-playground/PlaygroundLeft";
import type { HarnessBuiltinToolInfo } from "@/hooks/useHarnessBuiltinTools";
import { useHarnessBuiltinTools } from "@/hooks/useHarnessBuiltinTools";
import {
  useBrowserTools,
  type BrowserToolsState,
} from "@/hooks/useBrowserTools";
import { usePreviewedEnvironmentId } from "@/hooks/use-previewed-environment-id";
import { useProjectEnvironmentsEnabled } from "@/hooks/useProjectEnvironmentsEnabled";
import { EnvironmentToolsPane } from "./panes/EnvironmentToolsPane";
import { MultiServerToolsPaneInner } from "./panes/MultiServerToolsPane";
import { usePlaygroundChatHistoryBridge } from "./playground-chat-history-bridge";
import { useLocalHarnessRunsHere } from "@/hooks/useLocalHarnessTarget";
import { PlaygroundAppsSection } from "./PlaygroundAppsSection";
import { IncludedPluginToolsSection } from "./IncludedPluginToolsSection";
import { ComparePaneSelect } from "./ComparePaneSelect";
import {
  useSelectedComparePane,
  type ComparePaneOption,
} from "@/stores/compare-pane-store";
import { cn } from "@/lib/utils";

type LeftRailTab = "sessions" | "tools";

/**
 * Playground left rail — Sessions (`ChatHistoryRail`) and Tools tabs in a
 * single collapsible panel, matching the chat-v2 rail pattern. Active tab is
 * local state (not persisted per view); rail visibility is owned by
 * `PlaygroundTab`.
 */
export function PlaygroundLeftRail({
  previewedHostId,
  projectId,
  onClose,
}: {
  /** Resolved previewed host (from PlaygroundTab) — used to surface a harness
   *  host's native built-in tools in the Tools list. */
  previewedHostId?: string | null;
  /** Project scope, for the environment-mode Tools body (see `ToolsBody`). */
  projectId?: string | null;
  /** Shows a Collapse panel control, as the right rail has (phone layout). */
  onClose?: () => void;
}) {
  const [activeTab, setActiveTab] = useState<LeftRailTab>("tools");
  // While Compare runs clients, the tools are the selected pane's.
  const comparePane = useSelectedComparePane();

  const handleTabClick = useCallback(
    (next: LeftRailTab) => {
      if (next === activeTab) return;
      track("playground_left_rail_tab_changed", {
        location: "playground_left_rail",
        from: activeTab,
        to: next,
      });
      setActiveTab(next);
    },
    [activeTab],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Global plugin Apps (nothing when extensions are off). */}
      <PlaygroundAppsSection />
      <div className="flex shrink-0 items-center gap-0.5 border-b border-border px-2 py-1">
        <TabButton
          icon={Hammer}
          label="Tools"
          isActive={activeTab === "tools"}
          onClick={() => handleTabClick("tools")}
        />
        <TabButton
          icon={History}
          label="Sessions"
          isActive={activeTab === "sessions"}
          onClick={() => handleTabClick("sessions")}
        />
        {onClose ? (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={onClose}
              aria-label="Collapse panel"
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
      </div>
      <div className="flex-1 min-h-0">
        {activeTab === "sessions" ? (
          <SessionsBody />
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            {comparePane ? <ComparePaneSelect selected={comparePane} /> : null}
            <div className="min-h-0 flex-1">
              <ToolsBody
                previewedHostId={
                  comparePane ? comparePane.hostId : (previewedHostId ?? null)
                }
                serverNames={comparePane?.serverNames ?? null}
                comparePane={comparePane}
                projectId={projectId ?? null}
              />
            </div>
            <IncludedPluginToolsSection />
          </div>
        )}
      </div>
    </div>
  );
}

function TabButton({
  icon: Icon,
  label,
  isActive,
  onClick,
}: {
  icon: typeof History;
  label: string;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors",
        isActive
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
      aria-pressed={isActive}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function SessionsBody() {
  const bridge = usePlaygroundChatHistoryBridge();
  if (!bridge) {
    return (
      <div className="flex h-full items-center justify-center p-3 text-center text-xs text-muted-foreground">
        Loading chat history…
      </div>
    );
  }
  return (
    <ChatHistoryRail
      activeSessionId={bridge.activeSessionId}
      hostStyle={bridge.hostStyle}
      isAuthenticated={bridge.isAuthenticated}
      isStreaming={bridge.isStreaming}
      projectId={bridge.projectId}
      enabled={bridge.enabled}
      refreshSignal={bridge.refreshSignal}
      onSelectThread={bridge.onSelectThread}
      onPrefetchThread={bridge.onPrefetchThread}
      onNewChat={(options) => {
        void bridge.onNewChat(options);
      }}
      beforeResetChatAfterArchiveAll={bridge.beforeResetChatAfterArchiveAll}
      onArchiveAllComplete={bridge.onArchiveAllComplete}
      onArchiveAllSettled={bridge.onArchiveAllSettled}
      onSessionAction={bridge.onSessionAction}
    />
  );
}

function ToolsBody({
  previewedHostId,
  serverNames,
  comparePane,
  projectId,
}: {
  previewedHostId: string | null;
  /** A Compare pane's own servers, or null for every active server. */
  serverNames: string[] | null;
  /** The selected Compare pane, whose environment (or none) the rail shows. */
  comparePane: ComparePaneOption | null;
  projectId: string | null;
}) {
  const state = usePlaygroundStateContext();
  const [pendingScope, setPendingScope] = useState<string | null>(null);
  const scope = `${projectId ?? state.activeProjectId}:${comparePane?.paneId}:${previewedHostId}`;
  const handlePendingChange = useCallback(
    (pending: boolean) => {
      setPendingScope((current) =>
        pending ? scope : current === scope ? null : current,
      );
    },
    [scope],
  );
  const activeServerNames = serverNames
    ? serverNames.filter((name) => {
        const status = state.servers[name]?.connectionStatus;
        return status === "connected" || status === "connecting";
      })
    : state.activeServerNames;
  // The agent browser the previewed host attaches, if any: the six `browser_*`
  // tools plus whatever the page it has open offers. Resolved HERE, beside the
  // harness built-ins, and fed into both panes below for the same reason they
  // are — the zero-server pane is exactly where a browser-only host lands, and
  // that is the case where the panel used to say "No server connected yet"
  // about a host driving a real Chromium.
  const browserTools = useBrowserTools({
    projectId,
    hostId: previewedHostId,
  });
  // When the previewed host runs a harness (e.g. Claude Code), surface its
  // native built-in tools so the panel isn't empty/tool-less. Resolved once
  // here and fed into BOTH the multi-server pane and the zero-server fallback.
  const { tools: harnessBuiltinTools, harnessId: previewedHarnessId } =
    useHarnessBuiltinTools(previewedHostId);
  // Whether those built-ins execute on the USER'S machine rather than in a
  // cloud sandbox — the label the panel puts on them, and the one claim about
  // containment the product must never get wrong.
  const builtinToolsRunLocally = useLocalHarnessRunsHere({
    projectId,
    harnessId: previewedHarnessId,
  });
  // ENVIRONMENT MODE: the panes below read the browser's own connections,
  // which environment turns never create (the backend connects per message) —
  // so they'd report "No tools found" while tools execute fine in chat. Read
  // the SAME selected-environment signal the Playground itself uses (the
  // persisted previewed id, fail-closed behind the flag exactly like
  // `usePlaygroundEnvironment`) and show the environment's server-listed
  // tools instead.
  const environmentsEnabled = useProjectEnvironmentsEnabled();
  const [storedEnvironmentId] = usePreviewedEnvironmentId(projectId);
  // While comparing, the selected pane's environment and its narrowing; the
  // page's own environment rests until single chat.
  const environmentId = !environmentsEnabled
    ? null
    : comparePane
      ? comparePane.environmentId
      : storedEnvironmentId;
  if (environmentId && projectId) {
    return (
      <EnvironmentToolsPane
        projectId={projectId}
        environmentId={environmentId}
        environmentOverrides={comparePane?.environmentOverrides}
      />
    );
  }
  // The Playground is multi-server by nature: its active set mirrors the
  // connected servers. Aggregate tools across ALL active servers whenever
  // there's at least one — not only when there's more than one. Using `> 1`
  // meant disconnecting down to a single server fell back to the single-
  // server pane (keyed on the stale `serverName` pointer), so the remaining
  // server's tools vanished. Only the zero-server case falls back to
  // PlaygroundLeft for its empty/onboarding state.
  if (activeServerNames.length >= 1 && pendingScope !== scope) {
    return (
      <MultiServerToolsPaneInner
        previewedHarnessId={previewedHarnessId}
        activeServerNames={activeServerNames}
        builtinTools={harnessBuiltinTools}
        builtinToolsRunLocally={builtinToolsRunLocally}
        browserTools={browserTools}
      />
    );
  }

  // Zero-server → reuse the existing PlaygroundLeft (empty/onboarding state),
  // but suppress its inline LoggerView since the logger lives in the right rail.
  return (
    <ZeroServerToolsBody
      key={scope}
      previewedHarnessId={previewedHarnessId}
      builtinTools={harnessBuiltinTools}
      builtinToolsRunLocally={builtinToolsRunLocally}
      browserTools={browserTools}
      onChooseServer={comparePane?.onServerChosen}
      onPendingChange={handlePendingChange}
    />
  );
}

/**
 * Evals without a connect handler retain the Servers navigation fallback.
 */
function ZeroServerToolsBody({
  previewedHarnessId,
  builtinTools,
  builtinToolsRunLocally,
  browserTools,
  onChooseServer,
  onPendingChange,
}: {
  previewedHarnessId?: string | null;
  builtinTools: HarnessBuiltinToolInfo[];
  builtinToolsRunLocally: boolean;
  browserTools: BrowserToolsState;
  onChooseServer?: (name: string) => (() => void) | undefined;
  onPendingChange: (pending: boolean) => void;
}) {
  const state = usePlaygroundStateContext();
  const { onConnect } = state;

  return (
    <>
      <PlaygroundLeft
        previewedHarnessId={previewedHarnessId}
        tools={state.tools}
        selectedToolName={state.selectedTool}
        fetchingTools={state.fetchingTools}
        onRefresh={state.fetchTools}
        onSelectTool={state.setSelectedTool}
        formFields={state.formFields}
        onFieldChange={state.updateFormField}
        onToggleField={state.updateFormFieldIsSet}
        isExecuting={state.isExecuting}
        onExecute={state.executeTool}
        onSave={state.savedRequestsHook.openSaveDialog}
        savedRequests={state.savedRequestsHook.savedRequests}
        highlightedRequestId={state.savedRequestsHook.highlightedRequestId}
        onLoadRequest={state.savedRequestsHook.handleLoadRequest}
        onRenameRequest={state.savedRequestsHook.handleRenameRequest}
        onDuplicateRequest={state.savedRequestsHook.handleDuplicateRequest}
        onDeleteRequest={state.savedRequestsHook.handleDeleteRequest}
        showLogger={false}
        builtinTools={builtinTools}
        builtinToolsRunLocally={builtinToolsRunLocally}
        browserTools={browserTools}
        hasConnectedServer={false}
        connectServerControl={
          onConnect ? (
            <PlaygroundServerConnectButton
              servers={state.servers}
              catalogKnown={state.areServersHydrated}
              onAddServer={onConnect}
              ensureServersReady={state.ensureServersReady}
              onChooseServer={onChooseServer}
              onConnected={(name) => {
                if (onChooseServer) return;
                const selected = state.selectedServerNames?.length
                  ? state.selectedServerNames
                  : state.activeServerNames;
                if (!state.selectedServerNames?.includes(name)) {
                  state.onSelectMultipleServers?.([
                    ...new Set([...selected, name]),
                  ]);
                }
              }}
              onPendingChange={onPendingChange}
            />
          ) : undefined
        }
      />
    </>
  );
}

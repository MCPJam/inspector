import { useCallback, useEffect, useState } from "react";
import { Hammer, History } from "lucide-react";
import { useFeatureFlagEnabled, usePostHog } from "posthog-js/react";
import { standardEventProps } from "@/lib/PosthogUtils";
import { ChatHistoryRail } from "@/components/chat-v2/history/ChatHistoryRail";
import { usePlaygroundStateContext } from "@/components/ui-playground/hooks/use-playground-state";
import { PlaygroundLeft } from "@/components/ui-playground/PlaygroundLeft";
import { MultiServerToolsPaneInner } from "./panes/MultiServerToolsPane";
import { usePlaygroundChatHistoryBridge } from "./playground-chat-history-bridge";
import { cn } from "@/lib/utils";

type LeftRailTab = "sessions" | "tools";

/**
 * Playground left rail — Sessions (`ChatHistoryRail`) and Tools tabs in a
 * single collapsible panel, matching the chat-v2 rail pattern. Active tab is
 * local state (not persisted per view); rail visibility is owned by
 * `PlaygroundTab`.
 */
export function PlaygroundLeftRail() {
  const sessionsTabEnabled =
    useFeatureFlagEnabled("playground-sessions-enabled") === true;
  const [activeTab, setActiveTab] = useState<LeftRailTab>("tools");

  useEffect(() => {
    if (!sessionsTabEnabled && activeTab === "sessions") {
      setActiveTab("tools");
    }
  }, [sessionsTabEnabled, activeTab]);

  const posthog = usePostHog();
  const handleTabClick = useCallback(
    (next: LeftRailTab) => {
      if (next === activeTab) return;
      posthog?.capture("playground_left_rail_tab_changed", {
        ...standardEventProps("playground_left_rail"),
        from: activeTab,
        to: next,
      });
      setActiveTab(next);
    },
    [activeTab, posthog],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-0.5 border-b border-border px-2 py-1">
        <TabButton
          icon={Hammer}
          label="Tools"
          isActive={activeTab === "tools"}
          onClick={() => handleTabClick("tools")}
        />
        {sessionsTabEnabled ? (
          <TabButton
            icon={History}
            label="Sessions"
            isActive={activeTab === "sessions"}
            onClick={() => handleTabClick("sessions")}
          />
        ) : null}
      </div>
      <div className="flex-1 min-h-0">
        {activeTab === "sessions" && sessionsTabEnabled ? (
          <SessionsBody />
        ) : (
          <ToolsBody />
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
      sharedThreadsEnabled={bridge.sharedThreadsEnabled}
      projectId={bridge.projectId}
      enabled={bridge.enabled}
      refreshSignal={bridge.refreshSignal}
      onSelectThread={bridge.onSelectThread}
      onPrefetchThread={bridge.onPrefetchThread}
      onNewChat={bridge.onNewChat}
      beforeResetChatAfterArchiveAll={bridge.beforeResetChatAfterArchiveAll}
      onArchiveAllComplete={bridge.onArchiveAllComplete}
      onSessionAction={bridge.onSessionAction}
    />
  );
}

function ToolsBody() {
  const state = usePlaygroundStateContext();
  // The Playground is multi-server by nature: its active set mirrors the
  // connected servers. Aggregate tools across ALL active servers whenever
  // there's at least one — not only when there's more than one. Using `> 1`
  // meant disconnecting down to a single server fell back to the single-
  // server pane (keyed on the stale `serverName` pointer), so the remaining
  // server's tools vanished. Only the zero-server case falls back to
  // PlaygroundLeft for its empty/onboarding state.
  if (state.activeServerNames.length >= 1) {
    return (
      <MultiServerToolsPaneInner activeServerNames={state.activeServerNames} />
    );
  }

  // Zero-server → reuse the existing PlaygroundLeft (empty/onboarding state),
  // but suppress its inline LoggerView since the logger lives in the right rail.
  return (
    <PlaygroundLeft
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
    />
  );
}

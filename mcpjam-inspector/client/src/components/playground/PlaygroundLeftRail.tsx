import { useState } from "react";
import { Hammer, History } from "lucide-react";
import { ChatHistoryRail } from "@/components/chat-v2/history/ChatHistoryRail";
import { useAppBuilderStateContext } from "@/components/ui-playground/hooks/use-app-builder-state";
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
  const [activeTab, setActiveTab] = useState<LeftRailTab>("sessions");

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-0.5 border-b border-border px-2 py-1">
        <TabButton
          icon={History}
          label="Sessions"
          isActive={activeTab === "sessions"}
          onClick={() => setActiveTab("sessions")}
        />
        <TabButton
          icon={Hammer}
          label="Tools"
          isActive={activeTab === "tools"}
          onClick={() => setActiveTab("tools")}
        />
      </div>
      <div className="flex-1 min-h-0">
        {activeTab === "sessions" ? <SessionsBody /> : <ToolsBody />}
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
  const state = useAppBuilderStateContext();
  const isMulti = state.activeServerNames.length > 1;

  if (isMulti) {
    return (
      <MultiServerToolsPaneInner activeServerNames={state.activeServerNames} />
    );
  }

  // Single-server (and zero-server) → reuse the existing PlaygroundLeft, but
  // suppress its inline LoggerView since the logger lives in the right rail.
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

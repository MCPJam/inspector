/**
 * PlaygroundCenter
 *
 * Center pane of the Playground IDE shell. Consumes `useAppBuilderState`
 * via context (PlaygroundTab owns the single hook call so the docked tools
 * pane and the center share state). Renders `PlaygroundMain` directly — the
 * tools sidebar UI lives in the docked `tools` pane instead.
 */
import { Wrench } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { AppBuilderSkeleton } from "@/components/app-builder/AppBuilderSkeleton";
import { PlaygroundMain } from "@/components/ui-playground/PlaygroundMain";
import SaveRequestDialog from "@/components/tools/SaveRequestDialog";
import {
  APP_BUILDER_FIRST_RUN_PROMPT,
  useAppBuilderStateContext,
} from "@/components/ui-playground/hooks/use-app-builder-state";
import type { PlaygroundServerSelectorProps } from "@/components/ActiveServerSelector";
import type { ProjectHostContextDraft } from "@/lib/client-config";
import type { EnsureServersReadyResult } from "@/hooks/use-app-state";
import type { EvalChatHandoff } from "@/lib/eval-chat-handoff";

interface PlaygroundCenterProps {
  activeProjectId?: string | null;
  serverName?: string;
  enableMultiModelChat: boolean;
  /** Phase 4 (multi-host plan): defaults false; Phase 5 flips on. */
  enableMultiHostChat?: boolean;
  onSaveHostContext?: (
    projectId: string,
    hostContext: ProjectHostContextDraft,
  ) => Promise<void>;
  ensureServersReady?: (
    serverNames: string[],
  ) => Promise<EnsureServersReadyResult>;
  playgroundServerSelectorProps?: PlaygroundServerSelectorProps;
  evalChatHandoff?: EvalChatHandoff | null;
  onEvalChatHandoffConsumed?: (id: string) => void;
}

export function PlaygroundCenter({
  activeProjectId = null,
  serverName,
  enableMultiModelChat,
  enableMultiHostChat = false,
  onSaveHostContext,
  ensureServersReady,
  playgroundServerSelectorProps,
  evalChatHandoff = null,
  onEvalChatHandoffConsumed,
}: PlaygroundCenterProps) {
  const state = useAppBuilderStateContext();

  if (state.loadingState.kind === "skeleton") {
    return (
      <div className="h-full flex flex-col overflow-hidden relative">
        <AppBuilderSkeleton />
      </div>
    );
  }

  if (state.loadingState.kind === "sync-timed-out") {
    return (
      <EmptyState
        icon={Wrench}
        title="Still syncing…"
        description="This is taking longer than expected. Try reloading the page."
      />
    );
  }

  // Intentionally no `no-server` empty state: the Playground falls through to
  // PlaygroundMain so the user sees the chat composer + starter chips and can
  // connect a server from the ClientPicker in the header (mirrors the legacy
  // Chat tab behavior). PlaygroundMain already guards server-dependent calls
  // behind `serverName && servers[serverName]?.connectionStatus === "connected"`.

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <PlaygroundMain
        activeProjectId={activeProjectId}
        serverName={serverName || ""}
        onSaveHostContext={onSaveHostContext}
        enableMultiModelChat={enableMultiModelChat}
        enableMultiHostChat={enableMultiHostChat}
        isExecuting={state.isExecuting}
        executingToolName={state.selectedTool}
        invokingMessage={state.invokingMessage}
        pendingExecution={state.pendingExecution}
        onExecutionInjected={state.handleExecutionInjected}
        onWidgetStateChange={(_toolCallId, widgetState) =>
          state.setWidgetState(widgetState)
        }
        deviceType={state.deviceType}
        onDeviceTypeChange={state.setDeviceType}
        playgroundServerSelectorProps={playgroundServerSelectorProps}
        initialInput={
          state.firstRunComposerSeed
            ? APP_BUILDER_FIRST_RUN_PROMPT
            : undefined
        }
        initialInputTypewriter={state.firstRunComposerSeed}
        blockSubmitUntilServerConnected={state.firstRunComposerSeed}
        ensureServersReady={ensureServersReady}
        pulseSubmit={state.firstRunComposerSeed}
        showPostConnectGuide={false}
        onFirstMessageSent={
          state.onboarding.isGuidedPostConnect
            ? () => {
                state.onboarding.completeOnboarding();
              }
            : undefined
        }
        evalChatHandoff={evalChatHandoff}
        onEvalChatHandoffConsumed={onEvalChatHandoffConsumed}
      />

      <SaveRequestDialog
        open={state.savedRequestsHook.saveDialogState.isOpen}
        defaultTitle={state.savedRequestsHook.saveDialogState.defaults.title}
        defaultDescription={
          state.savedRequestsHook.saveDialogState.defaults.description
        }
        onCancel={state.savedRequestsHook.closeSaveDialog}
        onSave={state.savedRequestsHook.handleSaveDialogSubmit}
      />
    </div>
  );
}

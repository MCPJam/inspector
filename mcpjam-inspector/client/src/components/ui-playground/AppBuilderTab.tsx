/**
 * AppBuilderTab
 *
 * Thin presentational shell around `useAppBuilderState`. Owns nothing beyond
 * JSX composition + early-return branching on `loadingState`. All orchestration
 * lives in the hook so `PlaygroundTab` can render its own composition over the
 * same state.
 */

import { Wrench } from "lucide-react";
import {
  ResizablePanel,
  ResizablePanelGroup,
  ResizableHandle,
} from "../ui/resizable";
import { EmptyState } from "../ui/empty-state";
import { CollapsedPanelStrip } from "../ui/collapsed-panel-strip";
import { PlaygroundLeft } from "./PlaygroundLeft";
import { PlaygroundMain } from "./PlaygroundMain";
import SaveRequestDialog from "../tools/SaveRequestDialog";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";
import type { ProjectHostContextDraft } from "@/lib/client-config";
import { motion } from "framer-motion";

import { PANEL_SIZES } from "./constants";
import { AppBuilderSkeleton } from "@/components/app-builder/AppBuilderSkeleton";
import type { ServerFormData } from "@/shared/types.js";
import type {
  EnsureServersReadyResult,
  ServerWithName,
} from "@/hooks/use-app-state";
import { getLoadingIndicatorVariantForHostStyle } from "@/components/chat-v2/shared/loading-indicator-content";
import type { PlaygroundServerSelectorProps } from "@/components/ActiveServerSelector";
import {
  APP_BUILDER_FIRST_RUN_PROMPT,
  useAppBuilderState,
} from "./hooks/use-app-builder-state";

interface AppBuilderTabProps {
  activeProjectId?: string | null;
  serverConfig?: MCPServerConfig;
  serverName?: string;
  servers?: Record<string, ServerWithName>;
  /** WorkOS sign-in state only; Convex guest auth must not skip NUX. */
  isSignedInWithWorkOs?: boolean;
  isWorkOsAuthLoading?: boolean;
  isConvexAuthenticated?: boolean;
  isProjectProvisioned?: boolean;
  hasSeenFirstRunOnboarding?: boolean;
  /**
   * True while the currently selected server exists in runtime state but has
   * not yet appeared in the persisted project servers (Convex round-trip
   * pending). Used to show a loading skeleton instead of the "No Server
   * Selected" empty state during the sync window.
   */
  isServerSyncing?: boolean;
  onConnect?: (formData: ServerFormData) => void;
  onSaveHostContext?: (
    projectId: string,
    hostContext: ProjectHostContextDraft,
  ) => Promise<void>;
  ensureServersReady?: (
    serverNames: string[],
  ) => Promise<EnsureServersReadyResult>;
  onOnboardingChange?: (isOnboarding: boolean) => void;
  playgroundServerSelectorProps?: PlaygroundServerSelectorProps;
  enableMultiModelChat?: boolean;
}

const SIDEBAR_EASE: [number, number, number, number] = [0.4, 0, 0.2, 1];

export function AppBuilderTab({
  activeProjectId = null,
  serverConfig,
  serverName,
  servers = {},
  isSignedInWithWorkOs = false,
  isWorkOsAuthLoading = false,
  isConvexAuthenticated = false,
  isProjectProvisioned = true,
  hasSeenFirstRunOnboarding,
  isServerSyncing = false,
  onConnect,
  onSaveHostContext,
  ensureServersReady,
  onOnboardingChange,
  playgroundServerSelectorProps,
  enableMultiModelChat = false,
}: AppBuilderTabProps) {
  const state = useAppBuilderState({
    activeProjectId,
    serverConfig,
    serverName,
    servers,
    isSignedInWithWorkOs,
    isWorkOsAuthLoading,
    isConvexAuthenticated,
    isProjectProvisioned,
    hasSeenFirstRunOnboarding,
    isServerSyncing,
    onConnect,
    onSaveHostContext,
    ensureServersReady,
    onOnboardingChange,
  });

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

  if (state.loadingState.kind === "no-server") {
    return (
      <EmptyState
        icon={Wrench}
        title="No Server Selected"
        description="Connect to an MCP server to use the App Builder."
      />
    );
  }

  const sidebarMotionProps = state.prefersReducedMotion
    ? {
        initial: false as const,
        animate: { opacity: 1 },
        transition: { duration: 0 },
      }
    : {
        initial: { opacity: 0, x: -12 },
        animate: { opacity: 1, x: 0 },
        transition: { duration: 0.22, ease: SIDEBAR_EASE },
      };

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
        {/* Left Panel - Tools Sidebar */}
        {state.isSidebarVisible ? (
          <>
            <ResizablePanel
              id="playground-left"
              order={1}
              defaultSize={PANEL_SIZES.LEFT.DEFAULT}
              minSize={PANEL_SIZES.LEFT.MIN}
              maxSize={PANEL_SIZES.LEFT.MAX}
              collapsible
              collapsedSize={0}
              onCollapse={() => state.setSidebarVisible(false)}
            >
              <motion.div className="h-full min-w-0" {...sidebarMotionProps}>
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
                  highlightedRequestId={
                    state.savedRequestsHook.highlightedRequestId
                  }
                  onLoadRequest={state.savedRequestsHook.handleLoadRequest}
                  onRenameRequest={state.savedRequestsHook.handleRenameRequest}
                  onDuplicateRequest={
                    state.savedRequestsHook.handleDuplicateRequest
                  }
                  onDeleteRequest={state.savedRequestsHook.handleDeleteRequest}
                  onClose={state.toggleSidebar}
                />
              </motion.div>
            </ResizablePanel>
            <ResizableHandle withHandle />
          </>
        ) : (
          <motion.div
            className="flex h-full min-w-0 shrink-0"
            {...sidebarMotionProps}
          >
            <CollapsedPanelStrip
              side="left"
              onOpen={state.toggleSidebar}
              tooltipText="Show tools sidebar"
            />
          </motion.div>
        )}

        {/* Center Panel - Chat Thread */}
        <ResizablePanel
          id="playground-center"
          order={2}
          defaultSize={state.centerPanelDefaultSize}
          minSize={PANEL_SIZES.CENTER.MIN}
          className="min-h-0 min-w-0 overflow-hidden"
        >
          <PlaygroundMain
            activeProjectId={activeProjectId}
            serverName={serverName || ""}
            onSaveHostContext={onSaveHostContext}
            enableMultiModelChat={enableMultiModelChat}
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
            loadingIndicatorVariant={getLoadingIndicatorVariantForHostStyle(
              state.hostStyle,
            )}
            ensureServersReady={ensureServersReady}
            pulseSubmit={state.firstRunComposerSeed}
            showPostConnectGuide={false}
            onFirstMessageSent={
              state.onboarding.isGuidedPostConnect
                ? () => {
                    state.setSidebarVisible(true);
                    state.onboarding.completeOnboarding();
                  }
                : undefined
            }
          />
        </ResizablePanel>
      </ResizablePanelGroup>

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

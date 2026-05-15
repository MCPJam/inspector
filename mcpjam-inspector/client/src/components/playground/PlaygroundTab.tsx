import { useRef, useState } from "react";
import {
  AppBuilderStateProvider,
  useAppBuilderState,
} from "@/components/ui-playground/hooks/use-app-builder-state";
import {
  ChatboxHostStyleProvider,
  ChatboxHostThemeProvider,
} from "@/contexts/chatbox-host-style-context";
import { ChatboxHostCapabilitiesOverrideProvider } from "@/contexts/chatbox-host-capabilities-override-context";
import { getChatboxShellStyle } from "@/lib/chatbox-host-style";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import type { ImperativePanelHandle } from "react-resizable-panels";
import { CollapsedPanelStrip } from "@/components/ui/collapsed-panel-strip";
import { LoggerView } from "@/components/logger-view";
import { PlaygroundCenter } from "./PlaygroundCenter";
import { PlaygroundPreviewedHostSync } from "./PlaygroundPreviewedHostSync";
import { PlaygroundLeftRail } from "./PlaygroundLeftRail";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";
import type { ProjectHostContextDraft } from "@/lib/client-config";
import type { ServerFormData } from "@/shared/types.js";
import type {
  EnsureServersReadyResult,
  ServerWithName,
} from "@/hooks/use-app-state";
import type { PlaygroundServerSelectorProps } from "@/components/ActiveServerSelector";
import type { EvalChatHandoff } from "@/lib/eval-chat-handoff";

interface PlaygroundTabProps {
  activeProjectId?: string | null;
  serverConfig?: MCPServerConfig;
  serverName?: string;
  servers?: Record<string, ServerWithName>;
  isSignedInWithWorkOs?: boolean;
  isWorkOsAuthLoading?: boolean;
  isConvexAuthenticated?: boolean;
  isProjectProvisioned?: boolean;
  hasSeenFirstRunOnboarding?: boolean;
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
  evalChatHandoff?: EvalChatHandoff | null;
  onEvalChatHandoffConsumed?: (id: string) => void;
}

/**
 * Playground tab — replacement for Chat + App Builder.
 *
 * Layout mirrors `ChatTabV2`:
 *   left rail (Sessions/Tools, collapsible)  │  center (chat)  │  right rail (logger, collapsible)
 *
 * Rail visibility is local React state — we don't persist it per saved view
 * in v2. Chat-v2 also keeps these local, and matching that behavior keeps the
 * mental model simple ("rails are workspace chrome, not part of a view").
 *
 * Owns the single `useAppBuilderState()` call for the surface; the
 * `AppBuilderStateProvider` exposes it to both the left rail's Tools tab and
 * the center pane.
 */
export function PlaygroundTab(props: PlaygroundTabProps) {
  const themeMode = usePreferencesStore((state) => state.themeMode);
  const hostStyle = usePreferencesStore((state) => state.hostStyle);
  const hostCapabilitiesOverride = usePreferencesStore(
    (state) => state.hostCapabilitiesOverride,
  );
  const shellStyle = getChatboxShellStyle(hostStyle, themeMode);

  const appBuilderState = useAppBuilderState({
    activeProjectId: props.activeProjectId,
    serverConfig: props.serverConfig,
    serverName: props.serverName,
    servers: props.servers,
    isSignedInWithWorkOs: props.isSignedInWithWorkOs,
    isWorkOsAuthLoading: props.isWorkOsAuthLoading,
    isConvexAuthenticated: props.isConvexAuthenticated,
    isProjectProvisioned: props.isProjectProvisioned,
    hasSeenFirstRunOnboarding: props.hasSeenFirstRunOnboarding,
    isServerSyncing: props.isServerSyncing,
    onConnect: props.onConnect,
    onSaveHostContext: props.onSaveHostContext,
    ensureServersReady: props.ensureServersReady,
    onOnboardingChange: props.onOnboardingChange,
    surface: "playground",
    // Playground supports multi-server tool selection — pass the active
    // multi-server set through so the docked tools pane aggregates across
    // all of them and execution routes to the right server per tool.
    selectedServerNames:
      props.playgroundServerSelectorProps?.isMultiSelectEnabled
        ? props.playgroundServerSelectorProps?.selectedMultipleServers
        : undefined,
  });

  // Rail collapse state — local to the workspace; not persisted per view.
  // Defaults match the previous flag-on behavior (left rail showing tools,
  // right rail collapsed).
  const [isLeftRailVisible, setIsLeftRailVisible] = useState(true);
  const [isRightRailVisible, setIsRightRailVisible] = useState(false);

  // Panel handles let us programmatically expand a collapsed rail when the
  // user clicks the corresponding `CollapsedPanelStrip` peek button.
  const leftPanelRef = useRef<ImperativePanelHandle | null>(null);
  const rightPanelRef = useRef<ImperativePanelHandle | null>(null);

  return (
    <AppBuilderStateProvider value={appBuilderState}>
        <ChatboxHostStyleProvider value={hostStyle}>
          <ChatboxHostCapabilitiesOverrideProvider
            value={hostCapabilitiesOverride}
          >
            <ChatboxHostThemeProvider value={themeMode}>
              <div
                className={cn(
                  "chatbox-host-shell app-theme-scope flex h-full min-h-0 flex-1 flex-col overflow-hidden",
                  themeMode === "dark" && "dark",
                )}
                data-host-style={hostStyle}
                style={shellStyle}
              >
                {/* Watches the project's previewed-host id (the named-host
                    dropdown in the global header) and re-snapshots its
                    persisted config into the chip stores when it changes.
                    Renders nothing. */}
                <PlaygroundPreviewedHostSync
                  projectId={props.activeProjectId ?? null}
                />
                <ResizablePanelGroup
                  direction="horizontal"
                  className="min-h-0 flex-1"
                >
                  {isLeftRailVisible ? (
                    <>
                      <ResizablePanel
                        ref={leftPanelRef}
                        id="playground-left"
                        order={1}
                        defaultSize={22}
                        minSize={15}
                        maxSize={35}
                        collapsible
                        collapsedSize={0}
                        onCollapse={() => setIsLeftRailVisible(false)}
                        className="min-h-0 min-w-0 overflow-hidden"
                      >
                        <PlaygroundLeftRail />
                      </ResizablePanel>
                      <ResizableHandle withHandle />
                    </>
                  ) : (
                    <CollapsedPanelStrip
                      side="left"
                      onOpen={() => {
                        setIsLeftRailVisible(true);
                        // The panel only remounts on the next paint; expand
                        // imperatively once it has a ref to honor the click.
                        requestAnimationFrame(() =>
                          leftPanelRef.current?.expand(),
                        );
                      }}
                      tooltipText="Show sessions"
                    />
                  )}
                  <ResizablePanel
                    id="playground-center"
                    order={2}
                    minSize={40}
                    className="min-h-0 min-w-0 overflow-hidden"
                  >
                    <PlaygroundCenter
                      activeProjectId={props.activeProjectId}
                      serverName={props.serverName}
                      enableMultiModelChat={true}
                      onSaveHostContext={props.onSaveHostContext}
                      ensureServersReady={props.ensureServersReady}
                      playgroundServerSelectorProps={
                        props.playgroundServerSelectorProps
                      }
                      evalChatHandoff={props.evalChatHandoff}
                      onEvalChatHandoffConsumed={
                        props.onEvalChatHandoffConsumed
                      }
                    />
                  </ResizablePanel>
                  {isRightRailVisible ? (
                    <>
                      <ResizableHandle withHandle />
                      <ResizablePanel
                        ref={rightPanelRef}
                        id="playground-right"
                        order={3}
                        defaultSize={30}
                        minSize={4}
                        maxSize={50}
                        collapsible
                        collapsedSize={0}
                        onCollapse={() => setIsRightRailVisible(false)}
                        className="min-h-0 overflow-hidden"
                      >
                        <div className="h-full min-h-0 overflow-hidden">
                          <LoggerView
                            onClose={() => setIsRightRailVisible(false)}
                          />
                        </div>
                      </ResizablePanel>
                    </>
                  ) : (
                    <CollapsedPanelStrip
                      side="right"
                      onOpen={() => {
                        setIsRightRailVisible(true);
                        requestAnimationFrame(() =>
                          rightPanelRef.current?.expand(),
                        );
                      }}
                      tooltipText="Show logs"
                    />
                  )}
                </ResizablePanelGroup>
              </div>
            </ChatboxHostThemeProvider>
          </ChatboxHostCapabilitiesOverrideProvider>
        </ChatboxHostStyleProvider>
      </AppBuilderStateProvider>
  );
}

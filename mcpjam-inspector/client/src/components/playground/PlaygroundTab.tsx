import { useEffect, useMemo, useRef, useState } from "react";
import { useConvexAuth } from "convex/react";
import { usePostHog } from "posthog-js/react";
import { standardEventProps } from "@/lib/PosthogUtils";
import {
  AppBuilderStateProvider,
  useAppBuilderState,
} from "@/components/ui-playground/hooks/use-app-builder-state";
import {
  ChatboxChatUiOverrideProvider,
  ChatboxHostStyleProvider,
  ChatboxHostThemeProvider,
} from "@/contexts/chatbox-client-style-context";
import { ChatboxHostCapabilitiesOverrideProvider } from "@/contexts/chatbox-client-capabilities-override-context";
import { ActiveMcpProfileProvider } from "@/contexts/active-mcp-profile-context";
import { ActiveHostCapsResolverScope } from "@/contexts/active-host-client-capabilities-context";
import { getChatboxShellStyle } from "@/lib/chatbox-client-style";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { useHost } from "@/hooks/useClients";
import { usePreviewedHostId } from "@/hooks/use-previewed-client-id";
import { useAutoConnectProjectServers } from "@/hooks/useAutoConnectProjectServers";
import { useProjectServers } from "@/hooks/useViews";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import type { ImperativePanelHandle } from "react-resizable-panels";
import { CollapsedPanelStrip } from "@/components/ui/collapsed-panel-strip";
import { LoggerView } from "@/components/logger-view";
import { PlaygroundCenter } from "./PlaygroundCenter";
import { PlaygroundPreviewedClientSync } from "./PlaygroundPreviewedClientSync";
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
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";

interface PlaygroundTabProps {
  activeProjectId?: string | null;
  /**
   * Shared (Convex) project id for the active project, when synced. Used as
   * the canonical previewed-host storage scope so this tab agrees with the
   * global host bar and ClientsTab. Falls back to `activeProjectId` for
   * CLI / no-cloud-sync flows.
   */
  sharedProjectId?: string | null;
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
    hostContext: ProjectHostContextDraft
  ) => Promise<void>;
  ensureServersReady?: (
    serverNames: string[]
  ) => Promise<EnsureServersReadyResult>;
  onOnboardingChange?: (isOnboarding: boolean) => void;
  playgroundServerSelectorProps?: PlaygroundServerSelectorProps;
  /**
   * Resolved active host from `useAppState` — the project default unless
   * the user explicitly previewed a different host. Used as the host
   * fallback when nothing is selected in the preview picker so the
   * render gate agrees with what `initialize` is using server-side.
   * Preview mode (when set) still wins over this fallback.
   */
  activeHost?: HostConfigDtoV2 | null;
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

  const posthog = usePostHog();
  useEffect(() => {
    posthog?.capture("playground_tab_viewed", {
      ...standardEventProps("playground_tab"),
      has_active_project: !!props.activeProjectId,
      has_shared_project: !!props.sharedProjectId,
      is_signed_in: !!props.isSignedInWithWorkOs,
    });
    // Fire once per mount; deps intentionally limited to posthog so the
    // event isn't refired when project ids hydrate after auth.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posthog]);

  // Resolve the previewed host once at the tab root so the host-config-
  // derived providers (Active MCP Profile, hostStyle, capabilities override,
  // chatUiOverride) share a single Convex subscription with
  // PlaygroundPreviewedClientSync below. `useHost` short-circuits on null
  // hostId, so this is cheap when no host is picked yet.
  const { isAuthenticated: isConvexAuthenticated } = useConvexAuth();
  const [previewedHostId] = usePreviewedHostId(
    props.sharedProjectId ?? props.activeProjectId ?? null
  );
  const { host: previewedHost } = useHost({
    isAuthenticated: isConvexAuthenticated,
    hostId: previewedHostId,
  });
  const activeMcpProfile = previewedHost?.config.mcpProfile;

  // Host-derived widget runtime values. The preferences store is the
  // editing surface for ad-hoc previews; once a host is selected its
  // persisted fields win so "select a host" actually means "operate under
  // its properties" everywhere.
  const prefHostStyle = usePreferencesStore((state) => state.hostStyle);
  const prefHostCapabilitiesOverride = usePreferencesStore(
    (state) => state.hostCapabilitiesOverride
  );
  const prefChatUiOverride = usePreferencesStore(
    (state) => state.chatUiOverride
  );
  const hostStyle = previewedHost?.config.hostStyle ?? prefHostStyle;
  const hostCapabilitiesOverride =
    previewedHost?.config.hostCapabilitiesOverride ??
    prefHostCapabilitiesOverride;
  const chatUiOverride =
    previewedHost?.config.chatUiOverride ?? prefChatUiOverride;
  const shellStyle = getChatboxShellStyle(hostStyle, themeMode);

  // Auto-connect the previewed host's REQUIRED servers once per session.
  // No previewed host = no auto-connect. Optional servers stay
  // disconnected until the user manually toggles them in the Servers tab.
  const { servers: projectServersList } = useProjectServers({
    projectId: props.sharedProjectId ?? null,
    isAuthenticated: isConvexAuthenticated,
  });
  const previewedHostRequiredNames = useMemo(() => {
    const requiredIds = previewedHost?.config?.serverIds ?? [];
    if (requiredIds.length === 0 || !projectServersList) return [];
    const byId = new Map(
      projectServersList.map((s) => [s._id, s.name] as const)
    );
    return requiredIds
      .map((id) => byId.get(id))
      .filter((name): name is string => !!name);
  }, [previewedHost?.config?.serverIds, projectServersList]);
  useAutoConnectProjectServers({
    projectId: props.activeProjectId ?? null,
    hostScopeKey: previewedHostId,
    requiredServerNames: previewedHostRequiredNames,
  });

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
    selectedServerNames: props.playgroundServerSelectorProps
      ?.isMultiSelectEnabled
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
      <ActiveMcpProfileProvider value={activeMcpProfile}>
        <ActiveHostCapsResolverScope
          // Preview-mode (explicit picker selection) wins; otherwise fall
          // back to the resolved project-default `activeHost` from
          // `useAppState` so the render gate agrees with what
          // `initialize` was called with. Without this fallback, a
          // project whose default is Codex would render widgets in
          // Playground while connect knows the server was init'd as
          // Codex.
          activeHost={previewedHost?.config ?? props.activeHost ?? null}
          hostStyle={hostStyle}
        >
          <ChatboxHostStyleProvider value={hostStyle}>
            <ChatboxHostCapabilitiesOverrideProvider
              value={hostCapabilitiesOverride}
            >
              <ChatboxChatUiOverrideProvider value={chatUiOverride}>
                <ChatboxHostThemeProvider value={themeMode}>
                  <div
                    className={cn(
                      "chatbox-host-shell app-theme-scope flex h-full min-h-0 flex-1 flex-col overflow-hidden",
                      themeMode === "dark" && "dark"
                    )}
                    data-host-style={hostStyle}
                    style={shellStyle}
                  >
                    {/* Watches the project's previewed-host id (the named-host
                    dropdown in the global header) and re-snapshots its
                    persisted config into the chip stores when it changes.
                    Renders nothing. */}
                    <PlaygroundPreviewedClientSync
                      projectId={
                        props.sharedProjectId ?? props.activeProjectId ?? null
                      }
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
                              leftPanelRef.current?.expand()
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
                              rightPanelRef.current?.expand()
                            );
                          }}
                          tooltipText="Show logs"
                        />
                      )}
                    </ResizablePanelGroup>
                  </div>
                </ChatboxHostThemeProvider>
              </ChatboxChatUiOverrideProvider>
            </ChatboxHostCapabilitiesOverrideProvider>
          </ChatboxHostStyleProvider>
        </ActiveHostCapsResolverScope>
      </ActiveMcpProfileProvider>
    </AppBuilderStateProvider>
  );
}

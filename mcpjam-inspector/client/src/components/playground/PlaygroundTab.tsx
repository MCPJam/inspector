import { useCallback, useEffect } from "react";
import { setPlaygroundDirty } from "@/lib/playground-navigation-guard";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
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
import { useViewState, ViewStateProvider } from "@/hooks/use-view-state";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { PaneSlot } from "./panes/PaneSlot";
import { PlaygroundHeader } from "./PlaygroundHeader";
import { PlaygroundCenter } from "./PlaygroundCenter";
import type { ProjectId } from "@/hooks/use-playground-views";
import type { PaneId, PaneSide } from "./panes/types";
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
 * Playground tab — IDE-style replacement for Chat + App Builder.
 *
 * Owns the single `useAppBuilderState()` call for the surface (Provider
 * exposes it to both the docked tools pane and the center pane). The docked
 * `tools` pane renders the legacy `PlaygroundLeft` via that context; the
 * center renders `<PlaygroundMain/>` directly. `AppBuilderTab` is no longer
 * embedded here — flag-on Playground composes from primitives.
 *
 * The single `DndContext` orchestrates pane drag across left and right slots.
 */
export function PlaygroundTab(props: PlaygroundTabProps) {
  const themeMode = usePreferencesStore((state) => state.themeMode);
  const hostStyle = usePreferencesStore((state) => state.hostStyle);
  const hostCapabilitiesOverride = usePreferencesStore(
    (state) => state.hostCapabilitiesOverride,
  );
  const shellStyle = getChatboxShellStyle(hostStyle, themeMode);

  const viewState = useViewState();
  const { payload, setPayload, isDirty } = viewState;
  const { layout } = payload;

  // Mirror dirty state out to a module-level ref so `applyNavigation`
  // (App.tsx, outside this subtree) can prompt before leaving #playground.
  useEffect(() => {
    setPlaygroundDirty(isDirty);
    return () => setPlaygroundDirty(false);
  }, [isDirty]);

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
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleClosePane = useCallback(
    (paneId: PaneId) => {
      setPayload((current) => ({
        ...current,
        layout: {
          ...current.layout,
          leftPanes: current.layout.leftPanes.filter((id) => id !== paneId),
          rightPanes: current.layout.rightPanes.filter((id) => id !== paneId),
        },
      }));
    },
    [setPayload],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over) return;

      const activeId = active.id as PaneId;
      const overId = over.id as PaneId;

      setPayload((current) => {
        const fromSide = locatePane(current.layout, activeId);
        if (!fromSide) return current;

        // Determine target side: prefer the over pane's slot; else infer
        // from the SortableContext id encoded into `over.data.current`.
        const toSide =
          locatePane(current.layout, overId) ??
          (over.data.current?.sortable?.containerId ===
          "playground-pane-slot-right"
            ? "right"
            : "left");

        if (activeId === overId && fromSide === toSide) return current;

        const fromList = [...current.layout[sideKey(fromSide)]];
        const toList =
          fromSide === toSide ? fromList : [...current.layout[sideKey(toSide)]];

        const fromIndex = fromList.indexOf(activeId);
        if (fromIndex === -1) return current;
        fromList.splice(fromIndex, 1);

        const toIndex = toList.indexOf(overId);
        const insertAt = toIndex === -1 ? toList.length : toIndex;
        toList.splice(insertAt, 0, activeId);

        if (fromSide === toSide) {
          // arrayMove preserves ordering semantics from dnd-kit examples.
          const reordered = arrayMove(
            current.layout[sideKey(fromSide)],
            current.layout[sideKey(fromSide)].indexOf(activeId),
            insertAt,
          );
          return {
            ...current,
            layout: { ...current.layout, [sideKey(fromSide)]: reordered },
          };
        }

        return {
          ...current,
          layout: {
            ...current.layout,
            [sideKey(fromSide)]: fromList,
            [sideKey(toSide)]: toList,
          },
        };
      });
    },
    [setPayload],
  );

  const hasLeftPanes = layout.leftPanes.length > 0;
  const hasRightPanes = layout.rightPanes.length > 0;

  return (
    <ViewStateProvider value={viewState}>
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
                <PlaygroundHeader
                  projectId={
                    (props.activeProjectId as unknown as
                      | ProjectId
                      | undefined) ?? undefined
                  }
                />
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleDragEnd}
                >
                  <ResizablePanelGroup
                    direction="horizontal"
                    className="min-h-0 flex-1"
                  >
                    {hasLeftPanes ? (
                      <>
                        <ResizablePanel
                          id="playground-left"
                          order={1}
                          defaultSize={layout.leftWidth || 25}
                          minSize={15}
                          maxSize={40}
                        >
                          <PaneSlot
                            side="left"
                            paneIds={layout.leftPanes}
                            onClosePane={handleClosePane}
                          />
                        </ResizablePanel>
                        <ResizableHandle withHandle />
                      </>
                    ) : null}
                    <ResizablePanel
                      id="playground-center"
                      order={2}
                      defaultSize={
                        100 -
                        (hasLeftPanes ? 25 : 0) -
                        (hasRightPanes ? 25 : 0)
                      }
                      className="min-h-0 min-w-0 overflow-hidden"
                    >
                      <PlaygroundCenter
                        activeProjectId={props.activeProjectId}
                        serverName={props.serverName}
                        enableMultiModelChat={
                          payload.chat.enableMultiModelChat
                        }
                        onSaveHostContext={props.onSaveHostContext}
                        ensureServersReady={props.ensureServersReady}
                        playgroundServerSelectorProps={
                          props.playgroundServerSelectorProps
                        }
                        servers={props.servers}
                        evalChatHandoff={props.evalChatHandoff}
                        onEvalChatHandoffConsumed={
                          props.onEvalChatHandoffConsumed
                        }
                      />
                    </ResizablePanel>
                    {hasRightPanes ? (
                      <>
                        <ResizableHandle withHandle />
                        <ResizablePanel
                          id="playground-right"
                          order={3}
                          defaultSize={layout.rightWidth || 25}
                          minSize={15}
                          maxSize={40}
                        >
                          <PaneSlot
                            side="right"
                            paneIds={layout.rightPanes}
                            onClosePane={handleClosePane}
                          />
                        </ResizablePanel>
                      </>
                    ) : null}
                  </ResizablePanelGroup>
                </DndContext>
              </div>
            </ChatboxHostThemeProvider>
          </ChatboxHostCapabilitiesOverrideProvider>
        </ChatboxHostStyleProvider>
      </AppBuilderStateProvider>
    </ViewStateProvider>
  );
}

function sideKey(side: PaneSide): "leftPanes" | "rightPanes" {
  return side === "left" ? "leftPanes" : "rightPanes";
}

function locatePane(
  layout: { leftPanes: PaneId[]; rightPanes: PaneId[] },
  paneId: PaneId,
): PaneSide | null {
  if (layout.leftPanes.includes(paneId)) return "left";
  if (layout.rightPanes.includes(paneId)) return "right";
  return null;
}

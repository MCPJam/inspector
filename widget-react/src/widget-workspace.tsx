import {
  Fragment,
  useContext,
  useEffect,
  useRef,
  useState,
  type ContextType,
  type ReactNode,
} from "react";
import {
  createAppToolsRegistry,
  createAppToolInvocationLog,
} from "./app-tools-registry";
import {
  createWidgetSurfaceStore,
  useWidgetSurfaceAdmissionError,
  useWidgetSurfaceStore,
  type WidgetSurfaceRecord,
} from "./widget-surface-store";
import { WidgetWorkspaceContext } from "./widget-workspace-context";
import { WidgetHostProvider } from "./widget-host-context";
import {
  MCPAppsRendererSurface,
  type MCPAppsRendererProps,
} from "./mcp-apps-renderer";

/** One owner per workspace/lane. Key this provider when its binding changes. */
export function WidgetWorkspaceProvider({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: ReactNode;
}) {
  const [value] = useState(() => ({
    workspaceId,
    surfaces: createWidgetSurfaceStore({ retainInstances: true }),
    registry: createAppToolsRegistry({ maxInstances: 64 }),
    invocations: createAppToolInvocationLog(),
  }));
  if (value.workspaceId !== workspaceId)
    throw new Error(
      "A widget workspace must be remounted when its identity changes"
    );
  const cleanupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (cleanupTimer.current !== null) clearTimeout(cleanupTimer.current);
    cleanupTimer.current = null;
    value.registry.getState().setEnabled(true);
    value.invocations.getState().setEnabled(true);
    value.surfaces.getState().setEnabled(true);
    return () => {
      // Admission and cancellation stop synchronously, even before final cleanup.
      value.registry.getState().setEnabled(false);
      value.invocations.getState().setEnabled(false);
      value.surfaces.getState().setEnabled(false);
      // React's development effect replay immediately reattaches this owner.
      cleanupTimer.current = setTimeout(() => {
        value.registry.getState().dispose();
        value.invocations.getState().dispose();
        value.surfaces.getState().dispose();
      }, 0);
    };
  }, [value]);
  return (
    <WidgetWorkspaceContext.Provider value={value}>
      {children}
    </WidgetWorkspaceContext.Provider>
  );
}

export function useOptionalWidgetWorkspace() {
  return useContext(WidgetWorkspaceContext);
}

export function useWidgetWorkspace() {
  const workspace = useOptionalWidgetWorkspace();
  if (!workspace) throw new Error("WidgetWorkspaceProvider is required");
  return workspace;
}

/** Explicit destruction owns registry cancellation; row cleanup never calls it. */
export function closeWorkspaceSurface(
  workspace: NonNullable<ContextType<typeof WidgetWorkspaceContext>>,
  surfaceId: string
) {
  const surface = workspace.surfaces.getState().surfaces.get(surfaceId);
  if (!surface) return;
  const toolCallIds = new Set([
    surface.initialToolCallId,
    surface.latestToolCallId,
    ...surface.registrations.keys(),
  ]);
  // Drop presentation first so a synchronous registry observer cannot reuse it.
  workspace.surfaces.getState().destroySurface(surfaceId);
  for (const instance of workspace.registry
    .getState()
    .instancesByBridgeId.values()) {
    if (
      toolCallIds.has(instance.parentToolCallId) &&
      instance.chatSessionId === surface.chatSessionId &&
      instance.serverId === surface.retainedProps.serverId
    )
      workspace.registry.getState().unregisterInstance(instance.bridgeId);
  }
}

function renderLiveSurface(props: MCPAppsRendererProps) {
  return <MCPAppsRendererSurface {...props} />;
}

/**
 * Every app's DOM parent is permanent. Selection only toggles presentation;
 * nothing is portaled/reparented into a transcript row or a different panel.
 */
export function WidgetWorkspaceSurfaceHost({
  activeSurfaceId,
  renderSurface = renderLiveSurface,
  renderContainer,
}: {
  activeSurfaceId: string | null;
  renderSurface?: (props: MCPAppsRendererProps) => ReactNode;
  /** Chrome is chosen by the immutable presentation slot, never by selection. */
  renderContainer?: (input: {
    surface: WidgetSurfaceRecord;
    active: boolean;
    children: ReactNode;
  }) => ReactNode;
}) {
  useWidgetWorkspace();
  const surfaces = useWidgetSurfaceStore((state) => state.surfaces);
  const refusal = useWidgetSurfaceAdmissionError(
    activeSurfaceId !== null && !surfaces.has(activeSurfaceId)
      ? activeSurfaceId
      : null
  );
  return (
    <div data-mcp-app-workspace-surfaces>
      {refusal ? (
        <p role="alert" data-mcp-app-workspace-refused={activeSurfaceId}>
          {refusal.message}
        </p>
      ) : null}
      {Array.from(surfaces.values()).map((surface) => {
        const props = {
          ...surface.retainedProps,
          persistentSurfaceInitialToolCallId: surface.initialToolCallId,
          persistentSurfaceId: surface.surfaceId,
        };
        const content =
          renderSurface === renderLiveSurface && !surface.host ? (
            <p role="status">App host unavailable</p>
          ) : (
            renderSurface(props)
          );
        const children = surface.host ? (
          <WidgetHostProvider value={surface.host}>
            {content}
          </WidgetHostProvider>
        ) : (
          content
        );
        const active = surface.surfaceId === activeSurfaceId;
        return (
          <Fragment key={surface.surfaceId}>
            {renderContainer ? (
              renderContainer({ surface, active, children })
            ) : (
              <div
                data-mcp-app-workspace-instance={surface.surfaceId}
                hidden={!active}
              >
                {children}
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

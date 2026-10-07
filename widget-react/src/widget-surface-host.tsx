import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { WidgetHostProvider } from "./widget-host-context";
import type { WidgetHost } from "./widget-host";
import { WidgetWorkspaceContext } from "./widget-workspace-context";
import { createPortal } from "react-dom";
import {
  MCPAppsRendererSurface,
  type MCPAppsRendererProps,
} from "./mcp-apps-renderer";
import {
  getRenderableSurfaceEntries,
  useWidgetSurfaceStore,
  useWidgetSurfaceStoreApi,
  type WidgetSurfaceId,
} from "./widget-surface-store";
export { WidgetSurfaceHostProvider } from "./widget-surface-context";

function createSurfaceContainer(surfaceId: WidgetSurfaceId) {
  const container = document.createElement("div");
  container.dataset.mcpAppSurfaceContainer = surfaceId;
  container.style.display = "contents";
  return container;
}

function WidgetSurfacePortal({
  anchorElement,
  initialToolCallId,
  parkingElement,
  props,
  surfaceId,
  host,
}: {
  anchorElement: HTMLDivElement | null;
  initialToolCallId: string;
  parkingElement: HTMLDivElement | null;
  props: MCPAppsRendererProps;
  surfaceId: WidgetSurfaceId;
  host?: WidgetHost;
}) {
  const [container] = useState(() => createSurfaceContainer(surfaceId));
  const targetElement = anchorElement ?? parkingElement;

  useLayoutEffect(() => {
    if (!targetElement) return;
    if (container.parentElement !== targetElement) {
      targetElement.appendChild(container);
    }
  }, [container, targetElement]);

  useEffect(() => {
    return () => {
      container.remove();
    };
  }, [container]);

  const renderer = (
    <MCPAppsRendererSurface
      {...props}
      persistentSurfaceInitialToolCallId={initialToolCallId}
      persistentSurfaceId={surfaceId}
    />
  );
  return createPortal(
    host ? (
      <WidgetHostProvider value={host}>{renderer}</WidgetHostProvider>
    ) : (
      renderer
    ),
    container,
    surfaceId
  );
}

export function WidgetSurfaceHost({
  chatSessionId,
}: {
  chatSessionId?: string;
}) {
  const workspace = useContext(WidgetWorkspaceContext);
  const surfaceStore = useWidgetSurfaceStoreApi();
  const [parkingElement, setParkingElement] = useState<HTMLDivElement | null>(
    null
  );
  const surfaces = useWidgetSurfaceStore((state) => state.surfaces);
  const entries = useMemo(
    () => getRenderableSurfaceEntries(surfaces, chatSessionId),
    [chatSessionId, surfaces]
  );

  useEffect(() => {
    return () => {
      surfaceStore.getState().clearChatSession(chatSessionId);
    };
  }, [chatSessionId, surfaceStore]);

  // A workspace owns the permanent render parents; Thread owns registrations only.
  if (workspace) return null;

  return (
    <>
      <div
        ref={setParkingElement}
        data-mcp-app-surface-parking
        style={{
          height: 0,
          overflow: "hidden",
          pointerEvents: "none",
          position: "absolute",
          width: 0,
        }}
      />
      {entries.map(
        ({ surfaceId, anchorElement, initialToolCallId, props, host }) => (
          <WidgetSurfacePortal
            key={surfaceId}
            anchorElement={anchorElement}
            initialToolCallId={initialToolCallId}
            parkingElement={parkingElement}
            props={props}
            host={host}
            surfaceId={surfaceId}
          />
        )
      )}
    </>
  );
}

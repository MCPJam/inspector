import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  MCPAppsRendererSurface,
  type MCPAppsRendererProps,
} from "./mcp-apps-renderer";
import {
  getRenderableSurfaceEntries,
  useWidgetSurfaceStore,
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
}: {
  anchorElement: HTMLDivElement | null;
  initialToolCallId: string;
  parkingElement: HTMLDivElement | null;
  props: MCPAppsRendererProps;
  surfaceId: WidgetSurfaceId;
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

  return createPortal(
    <MCPAppsRendererSurface
      {...props}
      persistentSurfaceInitialToolCallId={initialToolCallId}
      persistentSurfaceId={surfaceId}
    />,
    container,
    surfaceId
  );
}

export function WidgetSurfaceHost({
  chatSessionId,
}: {
  chatSessionId?: string;
}) {
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
      useWidgetSurfaceStore.getState().clearChatSession(chatSessionId);
    };
  }, [chatSessionId]);

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
      {entries.map(({ surfaceId, anchorElement, initialToolCallId, props }) => (
        <WidgetSurfacePortal
          key={surfaceId}
          anchorElement={anchorElement}
          initialToolCallId={initialToolCallId}
          parkingElement={parkingElement}
          props={props}
          surfaceId={surfaceId}
        />
      ))}
    </>
  );
}

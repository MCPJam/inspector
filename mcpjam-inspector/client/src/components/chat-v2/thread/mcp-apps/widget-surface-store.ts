import { create } from "zustand";
import type { MCPAppsRendererProps } from "./mcp-apps-renderer";

export type WidgetSurfaceId = string;

interface WidgetSurfaceRegistration {
  toolCallId: string;
  order: number;
  props: MCPAppsRendererProps;
  anchorElement: HTMLDivElement | null;
}

export interface WidgetSurfaceRecord {
  surfaceId: WidgetSurfaceId;
  chatSessionId?: string;
  initialToolCallId: string;
  latestToolCallId: string;
  registrations: Map<string, WidgetSurfaceRegistration>;
}

interface WidgetSurfaceStoreState {
  surfaces: Map<WidgetSurfaceId, WidgetSurfaceRecord>;
  nextOrder: number;
  upsertRegistration: (
    surfaceId: WidgetSurfaceId,
    toolCallId: string,
    props: MCPAppsRendererProps
  ) => void;
  setAnchor: (
    surfaceId: WidgetSurfaceId,
    toolCallId: string,
    anchorElement: HTMLDivElement | null
  ) => void;
  releaseRegistration: (surfaceId: WidgetSurfaceId, toolCallId: string) => void;
  clearChatSession: (chatSessionId?: string) => void;
}

export const useWidgetSurfaceStore = create<WidgetSurfaceStoreState>((set) => ({
  surfaces: new Map(),
  nextOrder: 0,

  upsertRegistration: (surfaceId, toolCallId, props) => {
    set((state) => {
      const surfaces = new Map(state.surfaces);
      const existing = surfaces.get(surfaceId);
      const registrations = new Map(existing?.registrations);
      const currentRegistration = registrations.get(toolCallId);
      const isNewRegistration = !currentRegistration;
      const order = currentRegistration?.order ?? state.nextOrder;

      registrations.set(toolCallId, {
        toolCallId,
        order,
        props,
        anchorElement: currentRegistration?.anchorElement ?? null,
      });

      surfaces.set(surfaceId, {
        surfaceId,
        chatSessionId: props.chatSessionId,
        initialToolCallId: existing?.initialToolCallId ?? toolCallId,
        latestToolCallId: toolCallId,
        registrations,
      });

      return {
        surfaces,
        nextOrder: isNewRegistration ? state.nextOrder + 1 : state.nextOrder,
      };
    });
  },

  setAnchor: (surfaceId, toolCallId, anchorElement) => {
    set((state) => {
      const existing = state.surfaces.get(surfaceId);
      const registration = existing?.registrations.get(toolCallId);
      if (!existing || !registration) return {};
      if (registration.anchorElement === anchorElement) return {};

      const registrations = new Map(existing.registrations);
      registrations.set(toolCallId, {
        ...registration,
        anchorElement,
      });
      const surfaces = new Map(state.surfaces);
      surfaces.set(surfaceId, {
        ...existing,
        registrations,
      });
      return { surfaces };
    });
  },

  releaseRegistration: (surfaceId, toolCallId) => {
    set((state) => {
      const existing = state.surfaces.get(surfaceId);
      if (!existing || !existing.registrations.has(toolCallId)) return {};

      const surfaces = new Map(state.surfaces);
      const registrations = new Map(existing.registrations);
      registrations.delete(toolCallId);

      if (registrations.size === 0) {
        surfaces.delete(surfaceId);
        return { surfaces };
      }

      let latestRegistration: WidgetSurfaceRegistration | null = null;
      for (const registration of registrations.values()) {
        if (
          latestRegistration === null ||
          registration.order > latestRegistration.order
        ) {
          latestRegistration = registration;
        }
      }

      surfaces.set(surfaceId, {
        ...existing,
        latestToolCallId:
          existing.latestToolCallId === toolCallId
            ? latestRegistration?.toolCallId ?? existing.latestToolCallId
            : existing.latestToolCallId,
        registrations,
      });
      return { surfaces };
    });
  },

  clearChatSession: (chatSessionId) => {
    set((state) => {
      // Skip the Map allocation + subscriber notification when no surface
      // belongs to this session (the common case on Thread unmount).
      let hasMatch = false;
      for (const surface of state.surfaces.values()) {
        if (surface.chatSessionId === chatSessionId) {
          hasMatch = true;
          break;
        }
      }
      if (!hasMatch) return {};

      const surfaces = new Map(state.surfaces);
      for (const [surfaceId, surface] of state.surfaces) {
        if (surface.chatSessionId === chatSessionId) {
          surfaces.delete(surfaceId);
        }
      }
      return { surfaces };
    });
  },
}));

export function getRenderableSurfaceEntries(
  surfaces: Map<WidgetSurfaceId, WidgetSurfaceRecord>,
  chatSessionId?: string
) {
  const entries: Array<{
    surfaceId: WidgetSurfaceId;
    anchorElement: HTMLDivElement | null;
    initialToolCallId: string;
    props: MCPAppsRendererProps;
  }> = [];

  for (const surface of surfaces.values()) {
    if (surface.chatSessionId !== chatSessionId) continue;
    const latestRegistration = surface.registrations.get(
      surface.latestToolCallId
    );
    if (!latestRegistration) continue;
    // Keep the mounted iframe under its original row. Reparenting a live
    // iframe can reload its browsing context in real browsers, which wipes
    // in-memory app state for stateful widgets like games.
    const initialRegistration = surface.registrations.get(
      surface.initialToolCallId
    );
    const fallbackAnchor =
      Array.from(surface.registrations.values()).find(
        (registration) => registration.anchorElement !== null
      )?.anchorElement ?? null;

    entries.push({
      surfaceId: surface.surfaceId,
      anchorElement: initialRegistration?.anchorElement ?? fallbackAnchor,
      initialToolCallId: surface.initialToolCallId,
      props: latestRegistration.props,
    });
  }

  return entries;
}

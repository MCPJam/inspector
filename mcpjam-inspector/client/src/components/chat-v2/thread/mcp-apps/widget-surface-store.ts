import { create } from "zustand";
import type { MCPAppsRendererProps } from "./mcp-apps-renderer";

export type WidgetSurfaceId = string;

export interface WidgetSurfaceRecord {
  surfaceId: WidgetSurfaceId;
  chatSessionId?: string;
  toolCallId: string;
  props: MCPAppsRendererProps;
  anchorElement: HTMLDivElement | null;
}

interface WidgetSurfaceStoreState {
  surfaces: Map<WidgetSurfaceId, WidgetSurfaceRecord>;
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

  upsertRegistration: (surfaceId, toolCallId, props) => {
    set((state) => {
      const surfaces = new Map(state.surfaces);
      const existing = surfaces.get(surfaceId);

      surfaces.set(surfaceId, {
        surfaceId,
        chatSessionId: props.chatSessionId,
        toolCallId,
        props,
        anchorElement: existing?.anchorElement ?? null,
      });

      return { surfaces };
    });
  },

  setAnchor: (surfaceId, toolCallId, anchorElement) => {
    set((state) => {
      const existing = state.surfaces.get(surfaceId);
      if (!existing || existing.toolCallId !== toolCallId) return {};
      if (existing.anchorElement === anchorElement) return {};

      const surfaces = new Map(state.surfaces);
      surfaces.set(surfaceId, {
        ...existing,
        anchorElement,
      });
      return { surfaces };
    });
  },

  releaseRegistration: (surfaceId, toolCallId) => {
    set((state) => {
      const existing = state.surfaces.get(surfaceId);
      if (!existing || existing.toolCallId !== toolCallId) return {};

      const surfaces = new Map(state.surfaces);
      surfaces.delete(surfaceId);
      return { surfaces };
    });
  },

  clearChatSession: (chatSessionId) => {
    set((state) => {
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
    props: MCPAppsRendererProps;
  }> = [];

  for (const surface of surfaces.values()) {
    if (surface.chatSessionId !== chatSessionId) continue;
    entries.push({
      surfaceId: surface.surfaceId,
      anchorElement: surface.anchorElement,
      props: surface.props,
    });
  }

  return entries;
}

import { create, useStore } from "zustand";
import { useContext } from "react";
import { WidgetWorkspaceContext } from "./widget-workspace-context";
import type { MCPAppsRendererProps } from "./mcp-apps-renderer";
import type { WidgetHost } from "./widget-host";

export type WidgetSurfaceId = string;

const MAX_CLOSED_SURFACE_IDS = 2048;

interface WidgetSurfaceRegistration {
  toolCallId: string;
  order: number;
  props: MCPAppsRendererProps;
  anchorElement: HTMLDivElement | null;
}

export interface WidgetSurfaceRecord {
  surfaceId: WidgetSurfaceId;
  /** Chosen before the first render; moving a live iframe resets its context. */
  presentation?: "panel" | "modal";
  chatSessionId?: string;
  initialToolCallId: string;
  latestToolCallId: string;
  registrations: Map<string, WidgetSurfaceRegistration>;
  /** Instance-owned render input survives removal of presentation rows. */
  retainedProps: MCPAppsRendererProps;
  /** Live adapter only; never include services in a recording projection. */
  host?: WidgetHost;
}

/** Why a workspace refused to open an App surface. */
export interface WidgetSurfaceAdmissionError {
  code: "WIDGET_INSTANCE_LIMIT";
  /** Plain-English description, safe to show as-is. */
  message: string;
  limit: number;
}

export interface WidgetSurfaceStoreState {
  surfaces: Map<WidgetSurfaceId, WidgetSurfaceRecord>;
  /**
   * Surfaces a retaining workspace refused because it already holds its
   * maximum number of live Apps. Cleared when the surface is admitted later
   * or destroyed. Refusing (instead of throwing from a layout effect) keeps
   * the rest of the workspace rendering.
   */
  refused: Map<WidgetSurfaceId, WidgetSurfaceAdmissionError>;
  nextOrder: number;
  upsertRegistration: (
    surfaceId: WidgetSurfaceId,
    toolCallId: string,
    props: MCPAppsRendererProps,
    host?: WidgetHost,
    presentation?: WidgetSurfaceRecord["presentation"]
  ) => void;
  setAnchor: (
    surfaceId: WidgetSurfaceId,
    toolCallId: string,
    anchorElement: HTMLDivElement | null
  ) => void;
  releaseRegistration: (surfaceId: WidgetSurfaceId, toolCallId: string) => void;
  clearChatSession: (chatSessionId?: string) => void;
  destroySurface: (surfaceId: WidgetSurfaceId) => void;
  dispose: () => void;
  setEnabled: (enabled: boolean) => void;
}

export function createWidgetSurfaceStore(
  options: { retainInstances?: boolean; maxInstances?: number } = {}
) {
  // Destroyed surfaces stay closed against a late upsert from a row that is
  // still unmounting. Bounded so a long session can't grow it forever: by the
  // time an id ages out, nothing can still be registering it.
  const closed = new Set<string>();
  const closeSurfaceId = (surfaceId: string) => {
    closed.delete(surfaceId);
    closed.add(surfaceId);
    while (closed.size > MAX_CLOSED_SURFACE_IDS) {
      closed.delete(closed.values().next().value as string);
    }
  };
  let disposed = false;
  let enabled = true;
  const maxInstances = options.maxInstances ?? 64;
  if (
    !Number.isSafeInteger(maxInstances) ||
    maxInstances < 1 ||
    maxInstances > 64
  )
    throw new Error("Invalid widget instance limit");
  return create<WidgetSurfaceStoreState>((set) => ({
    surfaces: new Map(),
    refused: new Map(),
    nextOrder: 0,

    upsertRegistration: (surfaceId, toolCallId, props, host, presentation) => {
      set((state) => {
        const surfaces = new Map(state.surfaces);
        const existing = surfaces.get(surfaceId);
        if (disposed || !enabled || closed.has(surfaceId)) return {};
        if (
          presentation !== undefined &&
          ((presentation !== "panel" && presentation !== "modal") ||
            (existing && (existing.presentation ?? "panel") !== presentation))
        )
          throw new Error(
            "Widget presentation cannot change during its lifetime"
          );
        // The limit counts LIVE Apps (closed ones free their slot), and a
        // refusal is recorded rather than thrown: this runs from a layout
        // effect, where a throw takes down the whole workspace.
        if (
          options.retainInstances &&
          !existing &&
          surfaces.size >= maxInstances
        ) {
          if (state.refused.has(surfaceId)) return {};
          const refused = new Map(state.refused);
          refused.set(surfaceId, {
            code: "WIDGET_INSTANCE_LIMIT",
            message: `Too many Apps are open (${maxInstances}). Close an App to open this one.`,
            limit: maxInstances,
          });
          while (refused.size > maxInstances) {
            refused.delete(refused.keys().next().value as string);
          }
          return { refused };
        }
        const registrations = new Map(existing?.registrations);
        const currentRegistration = registrations.get(toolCallId);
        const isNewRegistration = !currentRegistration;
        const order = currentRegistration?.order ?? state.nextOrder;
        const latestRegistration = existing?.registrations.get(
          existing.latestToolCallId
        );
        const shouldBecomeLatest =
          !existing ||
          !latestRegistration ||
          (isNewRegistration && order > latestRegistration.order);

        registrations.set(toolCallId, {
          toolCallId,
          order,
          props,
          anchorElement: currentRegistration?.anchorElement ?? null,
        });

        surfaces.set(surfaceId, {
          surfaceId,
          presentation: existing?.presentation ?? presentation ?? "panel",
          chatSessionId: props.chatSessionId,
          initialToolCallId: existing?.initialToolCallId ?? toolCallId,
          latestToolCallId: shouldBecomeLatest
            ? toolCallId
            : existing.latestToolCallId,
          registrations,
          retainedProps:
            shouldBecomeLatest || existing.latestToolCallId === toolCallId
              ? props
              : existing.retainedProps,
          host:
            shouldBecomeLatest || existing.latestToolCallId === toolCallId
              ? host ?? existing?.host
              : existing.host,
        });

        let refused = state.refused;
        if (refused.has(surfaceId)) {
          refused = new Map(refused);
          refused.delete(surfaceId);
        }
        return {
          surfaces,
          refused,
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

        if (registrations.size === 0 && !options.retainInstances) {
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
      if (options.retainInstances) return;
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
    destroySurface: (surfaceId) => {
      closeSurfaceId(surfaceId);
      set((state) => {
        const hasSurface = state.surfaces.has(surfaceId);
        const hasRefusal = state.refused.has(surfaceId);
        if (!hasSurface && !hasRefusal) return {};
        const next: Partial<WidgetSurfaceStoreState> = {};
        if (hasSurface) {
          const surfaces = new Map(state.surfaces);
          surfaces.delete(surfaceId);
          next.surfaces = surfaces;
        }
        if (hasRefusal) {
          const refused = new Map(state.refused);
          refused.delete(surfaceId);
          next.refused = refused;
        }
        return next;
      });
    },
    setEnabled: (value) => {
      enabled = value;
    },
    dispose: () => {
      disposed = true;
      closed.clear();
      set({ surfaces: new Map(), refused: new Map() });
    },
  }));
}

export type WidgetSurfaceStore = ReturnType<typeof createWidgetSurfaceStore>;

/** Why the current workspace refused `surfaceId`, or null. */
export function useWidgetSurfaceAdmissionError(
  surfaceId: WidgetSurfaceId | null | undefined
): WidgetSurfaceAdmissionError | null {
  return useStore(useWidgetSurfaceStoreApi(), (state) =>
    surfaceId ? state.refused.get(surfaceId) ?? null : null
  );
}
const legacySurfaceStore = createWidgetSurfaceStore();
export function useWidgetSurfaceStoreApi(): WidgetSurfaceStore {
  return useContext(WidgetWorkspaceContext)?.surfaces ?? legacySurfaceStore;
}
/** Static methods retain legacy compatibility; workspace callbacks use the API hook. */
export const useWidgetSurfaceStore = Object.assign(
  <T = WidgetSurfaceStoreState>(
    selector: (state: WidgetSurfaceStoreState) => T = (state) =>
      state as unknown as T
  ) => useStore(useWidgetSurfaceStoreApi(), selector),
  legacySurfaceStore
);

export function getRenderableSurfaceEntries(
  surfaces: Map<WidgetSurfaceId, WidgetSurfaceRecord>,
  chatSessionId?: string
) {
  const entries: Array<{
    surfaceId: WidgetSurfaceId;
    anchorElement: HTMLDivElement | null;
    initialToolCallId: string;
    props: MCPAppsRendererProps;
    host?: WidgetHost;
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
      host: surface.host,
    });
  }

  return entries;
}

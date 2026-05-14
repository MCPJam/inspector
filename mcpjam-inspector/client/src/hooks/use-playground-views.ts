import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useConvexAuth } from "convex/react";
import {
  PLAYGROUND_VIEW_PAYLOAD_VERSION,
  parsePlaygroundViewPayload,
  type PlaygroundViewPayloadV1,
} from "@/shared/playground-view";
import { useViewStateContext } from "./use-view-state";

// Convex IDs are opaque strings — the backend's `_generated/api.d.ts` lives in
// a separate repo, so the inspector references queries/mutations by name
// (matches the convention in `ProfileTab.tsx:17-23`).
export type PlaygroundViewId = string & { __brand: "playgroundViewId" };
export type ProjectId = string & { __brand: "projectId" };

export interface PlaygroundViewSummary {
  _id: PlaygroundViewId;
  name: string;
  description?: string;
  projectId?: ProjectId;
  payloadVersion: number;
  payload: unknown;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface UsePlaygroundViewsResult {
  /** All views the user owns, optionally filtered by `projectId`. */
  views: PlaygroundViewSummary[];
  /** True while the first Convex query round-trip is in flight. */
  isLoading: boolean;
  /** The currently-active view (the one whose payload was loaded). Null = scratch. */
  activeViewId: PlaygroundViewId | null;
  /** Select a view by id; pulls its payload into `useViewState`. */
  selectView: (viewId: PlaygroundViewId | null) => void;
  /** Save current payload to the active view (or fail if scratch). */
  saveActive: () => Promise<void>;
  /** Save current payload under a new name. Becomes the active view. */
  saveAs: (name: string, description?: string) => Promise<PlaygroundViewId>;
  /** Rename a view. */
  rename: (viewId: PlaygroundViewId, name: string) => Promise<void>;
  /** Delete a view. If it was active, fall back to scratch. */
  remove: (viewId: PlaygroundViewId) => Promise<void>;
  /** Mark a view as the user's default for this project scope. */
  setDefault: (viewId: PlaygroundViewId) => Promise<void>;
}

/**
 * Wires `useViewState` to Convex `playgroundViews` queries/mutations. On first
 * load it auto-selects the user's `isDefault` view (or stays in scratch).
 */
export function usePlaygroundViews(
  projectId?: ProjectId,
): UsePlaygroundViewsResult {
  const { isAuthenticated } = useConvexAuth();
  const { payload, reset, markSaved } = useViewStateContext();

  const viewsResult = useQuery(
    "playgroundViews:list" as any,
    isAuthenticated ? ({ projectId } as any) : ("skip" as any),
  );

  const createMutation = useMutation("playgroundViews:create" as any);
  const updateMutation = useMutation("playgroundViews:update" as any);
  const removeMutation = useMutation("playgroundViews:remove" as any);
  const setDefaultMutation = useMutation(
    "playgroundViews:setDefault" as any,
  );

  const views = useMemo<PlaygroundViewSummary[]>(
    () => (viewsResult ?? []) as PlaygroundViewSummary[],
    [viewsResult],
  );

  const [activeViewId, setActiveViewId] = useState<PlaygroundViewId | null>(
    null,
  );

  // Auto-load default view on first authenticated query result. We only auto-
  // select once per session to avoid clobbering a user's in-flight edits if
  // the views list refreshes (e.g. another tab made a change).
  const didInitialSelectionRef = useRef(false);
  useEffect(() => {
    if (didInitialSelectionRef.current) return;
    if (viewsResult === undefined) return;
    didInitialSelectionRef.current = true;
    const defaultView = views.find((v) => v.isDefault);
    if (defaultView) {
      const parsed = parsePlaygroundViewPayload(
        defaultView.payloadVersion,
        defaultView.payload,
      );
      if (parsed) {
        reset(parsed);
        setActiveViewId(defaultView._id);
      }
    }
  }, [views, viewsResult, reset]);

  const selectView = useCallback(
    (viewId: PlaygroundViewId | null) => {
      if (viewId === null) {
        setActiveViewId(null);
        return;
      }
      const view = views.find((v) => v._id === viewId);
      if (!view) return;
      const parsed = parsePlaygroundViewPayload(
        view.payloadVersion,
        view.payload,
      );
      if (!parsed) return;
      reset(parsed);
      setActiveViewId(viewId);
    },
    [views, reset],
  );

  const saveActive = useCallback(async () => {
    if (!activeViewId) {
      throw new Error("No active view to save. Use Save As instead.");
    }
    await updateMutation({
      viewId: activeViewId,
      payloadVersion: PLAYGROUND_VIEW_PAYLOAD_VERSION,
      payload: payload as unknown as Record<string, unknown>,
    } as any);
    markSaved();
  }, [activeViewId, updateMutation, payload, markSaved]);

  const saveAs = useCallback(
    async (name: string, description?: string) => {
      const newViewId = (await createMutation({
        name,
        description,
        projectId,
        payloadVersion: PLAYGROUND_VIEW_PAYLOAD_VERSION,
        payload: payload as unknown as Record<string, unknown>,
        isDefault: views.length === 0, // first-ever view becomes default
      } as any)) as PlaygroundViewId;
      setActiveViewId(newViewId);
      markSaved();
      return newViewId;
    },
    [createMutation, projectId, payload, views.length, markSaved],
  );

  const rename = useCallback(
    async (viewId: PlaygroundViewId, name: string) => {
      await updateMutation({ viewId, name } as any);
    },
    [updateMutation],
  );

  const remove = useCallback(
    async (viewId: PlaygroundViewId) => {
      await removeMutation({ viewId } as any);
      if (activeViewId === viewId) {
        setActiveViewId(null);
      }
    },
    [removeMutation, activeViewId],
  );

  const setDefault = useCallback(
    async (viewId: PlaygroundViewId) => {
      await setDefaultMutation({ viewId } as any);
    },
    [setDefaultMutation],
  );

  return {
    views,
    isLoading: viewsResult === undefined,
    activeViewId,
    selectView,
    saveActive,
    saveAs,
    rename,
    remove,
    setDefault,
  };
}

// Re-export so callers don't need to import from `@/shared` directly.
export type { PlaygroundViewPayloadV1 };

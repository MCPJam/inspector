import { create } from "zustand";
import {
  pickWorkspaceHostContext,
  stableStringifyJson,
  type WorkspaceHostContextDraft,
} from "@/lib/client-config";

interface HostContextStoreState {
  activeWorkspaceId: string | null;
  defaultHostContext: WorkspaceHostContextDraft;
  savedHostContext: WorkspaceHostContextDraft | undefined;
  draftHostContext: WorkspaceHostContextDraft;
  hostContextText: string;
  hostContextError: string | null;
  isSaving: boolean;
  isDirty: boolean;
  pendingWorkspaceId: string | null;
  pendingSavedHostContext: WorkspaceHostContextDraft | undefined;
  isAwaitingRemoteEcho: boolean;
  loadWorkspaceHostContext: (input: {
    workspaceId: string | null;
    defaultHostContext: WorkspaceHostContextDraft;
    savedHostContext?: WorkspaceHostContextDraft;
  }) => void;
  setHostContextText: (text: string) => void;
  patchHostContext: (patch: Record<string, unknown>) => void;
  resetToBaseline: () => void;
  beginSave: (input: {
    workspaceId: string;
    savedHostContext: WorkspaceHostContextDraft | undefined;
    awaitRemoteEcho: boolean;
  }) => void;
  markSaved: (
    savedHostContext: WorkspaceHostContextDraft | undefined,
  ) => void;
  failSave: () => void;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function createInitialState(): Omit<
  HostContextStoreState,
  | "loadWorkspaceHostContext"
  | "setHostContextText"
  | "patchHostContext"
  | "resetToBaseline"
  | "beginSave"
  | "markSaved"
  | "failSave"
> {
  return {
    activeWorkspaceId: null,
    defaultHostContext: {},
    savedHostContext: undefined,
    draftHostContext: {},
    hostContextText: "{}",
    hostContextError: null,
    isSaving: false,
    isDirty: false,
    pendingWorkspaceId: null,
    pendingSavedHostContext: undefined,
    isAwaitingRemoteEcho: false,
  };
}

function computeBaselineHostContext(
  state: Pick<HostContextStoreState, "defaultHostContext" | "savedHostContext">,
) {
  return state.savedHostContext ?? state.defaultHostContext;
}

function computeDirtyState(
  state: Pick<
    HostContextStoreState,
    "defaultHostContext" | "savedHostContext" | "draftHostContext"
  >,
) {
  return (
    stableStringifyJson(state.draftHostContext) !==
    stableStringifyJson(computeBaselineHostContext(state))
  );
}

function resetFromHostContext(
  workspaceId: string | null,
  defaultHostContext: WorkspaceHostContextDraft,
  savedHostContext?: WorkspaceHostContextDraft,
) {
  const normalizedDefaultHostContext = pickWorkspaceHostContext(
    { version: 1, clientCapabilities: {}, hostContext: defaultHostContext },
    {},
  );
  const normalizedSavedHostContext =
    savedHostContext === undefined
      ? undefined
      : pickWorkspaceHostContext(
          { version: 1, clientCapabilities: {}, hostContext: savedHostContext },
          {},
        );
  const baseline = normalizedSavedHostContext ?? normalizedDefaultHostContext;

  return {
    activeWorkspaceId: workspaceId,
    defaultHostContext: normalizedDefaultHostContext,
    savedHostContext: normalizedSavedHostContext,
    draftHostContext: baseline,
    hostContextText: stringifyJson(baseline),
    hostContextError: null,
    pendingWorkspaceId: null,
    pendingSavedHostContext: undefined,
    isAwaitingRemoteEcho: false,
    isSaving: false,
    isDirty: false,
  };
}

function isPendingRemoteEchoMatch(
  state: Pick<
    HostContextStoreState,
    "isAwaitingRemoteEcho" | "pendingWorkspaceId" | "pendingSavedHostContext"
  >,
  workspaceId: string | null,
  savedHostContext?: WorkspaceHostContextDraft,
) {
  return (
    state.isAwaitingRemoteEcho &&
    state.pendingWorkspaceId === workspaceId &&
    stableStringifyJson(state.pendingSavedHostContext) ===
      stableStringifyJson(savedHostContext)
  );
}

function parseRecordJson(text: string): WorkspaceHostContextDraft {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Value must be a JSON object");
  }
  return parsed as WorkspaceHostContextDraft;
}

export const useHostContextStore = create<HostContextStoreState>((set, get) => ({
  ...createInitialState(),

  loadWorkspaceHostContext: ({
    workspaceId,
    defaultHostContext,
    savedHostContext,
  }) => {
    const state = get();
    const normalizedDefaultHostContext = pickWorkspaceHostContext(
      { version: 1, clientCapabilities: {}, hostContext: defaultHostContext },
      {},
    );
    const normalizedSavedHostContext =
      savedHostContext === undefined
        ? undefined
        : pickWorkspaceHostContext(
            { version: 1, clientCapabilities: {}, hostContext: savedHostContext },
            {},
          );
    const shouldApplyPendingRemoteEcho = isPendingRemoteEchoMatch(
      state,
      workspaceId,
      normalizedSavedHostContext,
    );

    if (
      state.isDirty &&
      state.activeWorkspaceId === workspaceId &&
      !shouldApplyPendingRemoteEcho
    ) {
      return;
    }

    const sameWorkspace = state.activeWorkspaceId === workspaceId;
    const sameDefault =
      stableStringifyJson(state.defaultHostContext) ===
      stableStringifyJson(normalizedDefaultHostContext);
    const sameSaved =
      stableStringifyJson(state.savedHostContext) ===
      stableStringifyJson(normalizedSavedHostContext);

    if (
      sameWorkspace &&
      sameDefault &&
      sameSaved &&
      !shouldApplyPendingRemoteEcho
    ) {
      return;
    }

    set(
      resetFromHostContext(
        workspaceId,
        normalizedDefaultHostContext,
        normalizedSavedHostContext,
      ),
    );
  },

  setHostContextText: (text) => {
    set((state) => {
      try {
        const nextHostContext = parseRecordJson(text);
        return {
          draftHostContext: nextHostContext,
          hostContextText: text,
          hostContextError: null,
          isDirty: computeDirtyState({
            defaultHostContext: state.defaultHostContext,
            savedHostContext: state.savedHostContext,
            draftHostContext: nextHostContext,
          }),
        };
      } catch (error) {
        return {
          hostContextText: text,
          hostContextError:
            error instanceof Error ? error.message : "Invalid JSON",
        };
      }
    });
  },

  patchHostContext: (patch) => {
    set((state) => {
      const nextHostContext = {
        ...state.draftHostContext,
        ...patch,
      };
      return {
        draftHostContext: nextHostContext,
        hostContextText: stringifyJson(nextHostContext),
        hostContextError: null,
        isDirty: computeDirtyState({
          defaultHostContext: state.defaultHostContext,
          savedHostContext: state.savedHostContext,
          draftHostContext: nextHostContext,
        }),
      };
    });
  },

  resetToBaseline: () => {
    set((state) =>
      resetFromHostContext(
        state.activeWorkspaceId,
        state.defaultHostContext,
        state.savedHostContext,
      ),
    );
  },

  beginSave: ({ workspaceId, savedHostContext, awaitRemoteEcho }) =>
    set({
      isSaving: true,
      pendingWorkspaceId: awaitRemoteEcho ? workspaceId : null,
      pendingSavedHostContext: awaitRemoteEcho ? savedHostContext : undefined,
      isAwaitingRemoteEcho: awaitRemoteEcho,
    }),

  markSaved: (savedHostContext) =>
    set((state) => ({
      savedHostContext,
      isSaving: false,
      pendingWorkspaceId: null,
      pendingSavedHostContext: undefined,
      isAwaitingRemoteEcho: false,
      isDirty: computeDirtyState({
        defaultHostContext: state.defaultHostContext,
        savedHostContext,
        draftHostContext: state.draftHostContext,
      }),
    })),

  failSave: () =>
    set({
      isSaving: false,
      pendingWorkspaceId: null,
      pendingSavedHostContext: undefined,
      isAwaitingRemoteEcho: false,
    }),
}));

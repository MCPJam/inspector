import { create } from "zustand";
import {
  pickProjectHostContext,
  stableStringifyJson,
  type ProjectHostContextDraft,
} from "@/lib/client-config";

interface HostContextStoreState {
  activeProjectId: string | null;
  defaultHostContext: ProjectHostContextDraft;
  savedHostContext: ProjectHostContextDraft | undefined;
  draftHostContext: ProjectHostContextDraft;
  hostContextText: string;
  hostContextError: string | null;
  isSaving: boolean;
  isDirty: boolean;
  pendingProjectId: string | null;
  pendingSavedHostContext: ProjectHostContextDraft | undefined;
  isAwaitingRemoteEcho: boolean;
  loadProjectHostContext: (input: {
    projectId: string | null;
    defaultHostContext: ProjectHostContextDraft;
    savedHostContext?: ProjectHostContextDraft;
  }) => void;
  setHostContextText: (text: string) => void;
  patchHostContext: (patch: Record<string, unknown>) => void;
  resetToBaseline: () => void;
  beginSave: (input: {
    projectId: string;
    savedHostContext: ProjectHostContextDraft | undefined;
    awaitRemoteEcho: boolean;
  }) => void;
  markSaved: (
    savedHostContext: ProjectHostContextDraft | undefined,
  ) => void;
  failSave: () => void;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function createInitialState(): Omit<
  HostContextStoreState,
  | "loadProjectHostContext"
  | "setHostContextText"
  | "patchHostContext"
  | "resetToBaseline"
  | "beginSave"
  | "markSaved"
  | "failSave"
> {
  return {
    activeProjectId: null,
    defaultHostContext: {},
    savedHostContext: undefined,
    draftHostContext: {},
    hostContextText: "{}",
    hostContextError: null,
    isSaving: false,
    isDirty: false,
    pendingProjectId: null,
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
  projectId: string | null,
  defaultHostContext: ProjectHostContextDraft,
  savedHostContext?: ProjectHostContextDraft,
) {
  const normalizedDefaultHostContext = pickProjectHostContext(
    { version: 1, clientCapabilities: {}, hostContext: defaultHostContext },
    {},
  );
  const normalizedSavedHostContext =
    savedHostContext === undefined
      ? undefined
      : pickProjectHostContext(
          { version: 1, clientCapabilities: {}, hostContext: savedHostContext },
          {},
        );
  const baseline = normalizedSavedHostContext ?? normalizedDefaultHostContext;

  return {
    activeProjectId: projectId,
    defaultHostContext: normalizedDefaultHostContext,
    savedHostContext: normalizedSavedHostContext,
    draftHostContext: baseline,
    hostContextText: stringifyJson(baseline),
    hostContextError: null,
    pendingProjectId: null,
    pendingSavedHostContext: undefined,
    isAwaitingRemoteEcho: false,
    isSaving: false,
    isDirty: false,
  };
}

function isPendingRemoteEchoMatch(
  state: Pick<
    HostContextStoreState,
    "isAwaitingRemoteEcho" | "pendingProjectId" | "pendingSavedHostContext"
  >,
  projectId: string | null,
  savedHostContext?: ProjectHostContextDraft,
) {
  return (
    state.isAwaitingRemoteEcho &&
    state.pendingProjectId === projectId &&
    stableStringifyJson(state.pendingSavedHostContext) ===
      stableStringifyJson(savedHostContext)
  );
}

function parseRecordJson(text: string): ProjectHostContextDraft {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Value must be a JSON object");
  }
  return parsed as ProjectHostContextDraft;
}

export const useHostContextStore = create<HostContextStoreState>((set, get) => ({
  ...createInitialState(),

  loadProjectHostContext: ({
    projectId,
    defaultHostContext,
    savedHostContext,
  }) => {
    const state = get();
    const normalizedDefaultHostContext = pickProjectHostContext(
      { version: 1, clientCapabilities: {}, hostContext: defaultHostContext },
      {},
    );
    const normalizedSavedHostContext =
      savedHostContext === undefined
        ? undefined
        : pickProjectHostContext(
            { version: 1, clientCapabilities: {}, hostContext: savedHostContext },
            {},
          );
    const shouldApplyPendingRemoteEcho = isPendingRemoteEchoMatch(
      state,
      projectId,
      normalizedSavedHostContext,
    );

    if (
      state.isDirty &&
      state.activeProjectId === projectId &&
      !shouldApplyPendingRemoteEcho
    ) {
      return;
    }

    const sameProject = state.activeProjectId === projectId;
    const sameDefault =
      stableStringifyJson(state.defaultHostContext) ===
      stableStringifyJson(normalizedDefaultHostContext);
    const sameSaved =
      stableStringifyJson(state.savedHostContext) ===
      stableStringifyJson(normalizedSavedHostContext);

    if (
      sameProject &&
      sameDefault &&
      sameSaved &&
      !shouldApplyPendingRemoteEcho
    ) {
      return;
    }

    set(
      resetFromHostContext(
        projectId,
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
        state.activeProjectId,
        state.defaultHostContext,
        state.savedHostContext,
      ),
    );
  },

  beginSave: ({ projectId, savedHostContext, awaitRemoteEcho }) =>
    set({
      isSaving: true,
      pendingProjectId: awaitRemoteEcho ? projectId : null,
      pendingSavedHostContext: awaitRemoteEcho ? savedHostContext : undefined,
      isAwaitingRemoteEcho: awaitRemoteEcho,
    }),

  markSaved: (savedHostContext) =>
    set((state) => ({
      savedHostContext,
      isSaving: false,
      pendingProjectId: null,
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
      pendingProjectId: null,
      pendingSavedHostContext: undefined,
      isAwaitingRemoteEcho: false,
    }),
}));

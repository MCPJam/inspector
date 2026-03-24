import { create } from "zustand";
import type { WorkspaceClientConfig } from "@/lib/client-config";

type JsonSection = "clientCapabilities" | "hostContext";

interface ClientConfigStoreState {
  activeWorkspaceId: string | null;
  defaultConfig: WorkspaceClientConfig | null;
  savedConfig: WorkspaceClientConfig | undefined;
  draftConfig: WorkspaceClientConfig | null;
  clientCapabilitiesText: string;
  hostContextText: string;
  clientCapabilitiesError: string | null;
  hostContextError: string | null;
  isSaving: boolean;
  isDirty: boolean;
  loadWorkspaceConfig: (input: {
    workspaceId: string | null;
    defaultConfig: WorkspaceClientConfig | null;
    savedConfig?: WorkspaceClientConfig;
  }) => void;
  setSectionText: (section: JsonSection, text: string) => void;
  patchHostContext: (patch: Record<string, unknown>) => void;
  resetSectionToDefault: (section: JsonSection) => void;
  resetToBaseline: () => void;
  markSaving: (isSaving: boolean) => void;
  markSaved: (savedConfig: WorkspaceClientConfig | undefined) => void;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function createInitialState(): Omit<
  ClientConfigStoreState,
  | "loadWorkspaceConfig"
  | "setSectionText"
  | "patchHostContext"
  | "resetSectionToDefault"
  | "resetToBaseline"
  | "markSaving"
  | "markSaved"
> {
  return {
    activeWorkspaceId: null,
    defaultConfig: null,
    savedConfig: undefined,
    draftConfig: null,
    clientCapabilitiesText: "{}",
    hostContextText: "{}",
    clientCapabilitiesError: null,
    hostContextError: null,
    isSaving: false,
    isDirty: false,
  };
}

function computeBaselineConfig(
  state: Pick<ClientConfigStoreState, "defaultConfig" | "savedConfig">,
) {
  return state.savedConfig ?? state.defaultConfig;
}

function computeDirtyState(
  state: Pick<
    ClientConfigStoreState,
    "defaultConfig" | "savedConfig" | "draftConfig"
  >,
) {
  const baseline = computeBaselineConfig(state);
  if (!baseline || !state.draftConfig) {
    return false;
  }

  return stringifyJson(state.draftConfig) !== stringifyJson(baseline);
}

function resetFromConfig(
  workspaceId: string | null,
  defaultConfig: WorkspaceClientConfig | null,
  savedConfig?: WorkspaceClientConfig,
) {
  const baseline = savedConfig ?? defaultConfig;
  return {
    activeWorkspaceId: workspaceId,
    defaultConfig,
    savedConfig,
    draftConfig: baseline,
    clientCapabilitiesText: stringifyJson(baseline?.clientCapabilities ?? {}),
    hostContextText: stringifyJson(baseline?.hostContext ?? {}),
    clientCapabilitiesError: null,
    hostContextError: null,
    isDirty: false,
  };
}

function parseRecordJson(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Value must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function setSectionValue(
  state: ClientConfigStoreState,
  section: JsonSection,
  nextValue: Record<string, unknown>,
) {
  if (!state.draftConfig) {
    return state;
  }

  const nextDraftConfig: WorkspaceClientConfig = {
    ...state.draftConfig,
    [section]: nextValue,
  };

  return {
    draftConfig: nextDraftConfig,
    isDirty: computeDirtyState({
      defaultConfig: state.defaultConfig,
      savedConfig: state.savedConfig,
      draftConfig: nextDraftConfig,
    }),
  };
}

export const useClientConfigStore = create<ClientConfigStoreState>(
  (set, get) => ({
    ...createInitialState(),

    loadWorkspaceConfig: ({ workspaceId, defaultConfig, savedConfig }) => {
      const state = get();
      const sameWorkspace = state.activeWorkspaceId === workspaceId;
      const sameDefault =
        stringifyJson(state.defaultConfig) === stringifyJson(defaultConfig);
      const sameSaved =
        stringifyJson(state.savedConfig) === stringifyJson(savedConfig);

      if (sameWorkspace && sameDefault && sameSaved) {
        return;
      }

      set(resetFromConfig(workspaceId, defaultConfig, savedConfig));
    },

    setSectionText: (section, text) => {
      set((state) => {
        const textField =
          section === "clientCapabilities"
            ? "clientCapabilitiesText"
            : "hostContextText";
        const errorField =
          section === "clientCapabilities"
            ? "clientCapabilitiesError"
            : "hostContextError";

        try {
          const parsed = parseRecordJson(text);
          return {
            ...setSectionValue(state, section, parsed),
            [textField]: text,
            [errorField]: null,
          };
        } catch (error) {
          return {
            [textField]: text,
            [errorField]:
              error instanceof Error ? error.message : "Invalid JSON",
          };
        }
      });
    },

    patchHostContext: (patch) => {
      set((state) => {
        const currentHostContext = state.draftConfig?.hostContext ?? {};
        const nextHostContext = {
          ...currentHostContext,
          ...patch,
        };
        const nextState = setSectionValue(
          state,
          "hostContext",
          nextHostContext,
        );
        return {
          ...nextState,
          hostContextText: stringifyJson(nextHostContext),
          hostContextError: null,
        };
      });
    },

    resetSectionToDefault: (section) => {
      set((state) => {
        const defaultConfig = state.defaultConfig;
        if (!defaultConfig) {
          return {};
        }

        const nextValue = defaultConfig[section];
        const nextState = setSectionValue(state, section, nextValue);
        return {
          ...nextState,
          ...(section === "clientCapabilities"
            ? {
                clientCapabilitiesText: stringifyJson(nextValue),
                clientCapabilitiesError: null,
              }
            : {
                hostContextText: stringifyJson(nextValue),
                hostContextError: null,
              }),
        };
      });
    },

    resetToBaseline: () => {
      set((state) =>
        resetFromConfig(
          state.activeWorkspaceId,
          state.defaultConfig,
          state.savedConfig,
        ),
      );
    },

    markSaving: (isSaving) => set({ isSaving }),

    markSaved: (savedConfig) =>
      set((state) => ({
        savedConfig,
        isSaving: false,
        isDirty: computeDirtyState({
          defaultConfig: state.defaultConfig,
          savedConfig,
          draftConfig: state.draftConfig,
        }),
      })),
  }),
);

import { create } from "zustand";
import {
  buildDefaultWorkspaceConnectionDefaults,
  stableStringifyJson,
  type WorkspaceClientConfig,
  type WorkspaceConnectionDefaults,
} from "@/lib/client-config";

type JsonSection = "connectionDefaults" | "clientCapabilities" | "hostContext";

interface ClientConfigStoreState {
  activeWorkspaceId: string | null;
  defaultConfig: WorkspaceClientConfig | null;
  savedConfig: WorkspaceClientConfig | undefined;
  draftConfig: WorkspaceClientConfig | null;
  connectionDefaultsText: string;
  clientCapabilitiesText: string;
  hostContextText: string;
  connectionDefaultsError: string | null;
  clientCapabilitiesError: string | null;
  hostContextError: string | null;
  isSaving: boolean;
  isDirty: boolean;
  pendingWorkspaceId: string | null;
  pendingSavedConfig: WorkspaceClientConfig | undefined;
  isAwaitingRemoteEcho: boolean;
  loadWorkspaceConfig: (input: {
    workspaceId: string | null;
    defaultConfig: WorkspaceClientConfig | null;
    savedConfig?: WorkspaceClientConfig;
  }) => void;
  setSectionText: (section: JsonSection, text: string) => void;
  patchHostContext: (patch: Record<string, unknown>) => void;
  resetSectionToDefault: (section: JsonSection) => void;
  resetToBaseline: () => void;
  beginSave: (input: {
    workspaceId: string;
    savedConfig: WorkspaceClientConfig | undefined;
    awaitRemoteEcho: boolean;
  }) => void;
  markSaved: (savedConfig: WorkspaceClientConfig | undefined) => void;
  failSave: () => void;
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
  | "beginSave"
  | "markSaved"
  | "failSave"
> {
  return {
    activeWorkspaceId: null,
    defaultConfig: null,
    savedConfig: undefined,
    draftConfig: null,
    connectionDefaultsText: "{}",
    clientCapabilitiesText: "{}",
    hostContextText: "{}",
    connectionDefaultsError: null,
    clientCapabilitiesError: null,
    hostContextError: null,
    isSaving: false,
    isDirty: false,
    pendingWorkspaceId: null,
    pendingSavedConfig: undefined,
    isAwaitingRemoteEcho: false,
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

  return (
    stableStringifyJson(state.draftConfig) !== stableStringifyJson(baseline)
  );
}

function normalizeConfigForEditing(
  config: WorkspaceClientConfig | null | undefined,
  defaultConfig: WorkspaceClientConfig | null,
): WorkspaceClientConfig | null | undefined {
  if (!config) {
    return config;
  }

  return {
    ...config,
    connectionDefaults:
      config.connectionDefaults ??
      defaultConfig?.connectionDefaults ??
      buildDefaultWorkspaceConnectionDefaults(),
  };
}

function resetFromConfig(
  workspaceId: string | null,
  defaultConfig: WorkspaceClientConfig | null,
  savedConfig?: WorkspaceClientConfig,
) {
  const normalizedDefaultConfig = normalizeConfigForEditing(
    defaultConfig,
    defaultConfig,
  ) ?? null;
  const normalizedSavedConfig = normalizeConfigForEditing(
    savedConfig,
    normalizedDefaultConfig,
  );
  const baseline = normalizedSavedConfig ?? normalizedDefaultConfig;
  return {
    activeWorkspaceId: workspaceId,
    defaultConfig: normalizedDefaultConfig,
    savedConfig: normalizedSavedConfig,
    draftConfig: baseline,
    connectionDefaultsText: stringifyJson(
      baseline?.connectionDefaults ?? buildDefaultWorkspaceConnectionDefaults(),
    ),
    clientCapabilitiesText: stringifyJson(baseline?.clientCapabilities ?? {}),
    hostContextText: stringifyJson(baseline?.hostContext ?? {}),
    connectionDefaultsError: null,
    clientCapabilitiesError: null,
    hostContextError: null,
    pendingWorkspaceId: null,
    pendingSavedConfig: undefined,
    isAwaitingRemoteEcho: false,
    isSaving: false,
    isDirty: false,
  };
}

function isPendingRemoteEchoMatch(
  state: Pick<
    ClientConfigStoreState,
    "isAwaitingRemoteEcho" | "pendingWorkspaceId" | "pendingSavedConfig"
  >,
  workspaceId: string | null,
  savedConfig?: WorkspaceClientConfig,
) {
  return (
    state.isAwaitingRemoteEcho &&
    state.pendingWorkspaceId === workspaceId &&
    stableStringifyJson(state.pendingSavedConfig) ===
      stableStringifyJson(savedConfig)
  );
}

function parseRecordJson(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Value must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function parseConnectionDefaultsJson(text: string): WorkspaceConnectionDefaults {
  const parsed = parseRecordJson(text);
  const requestTimeout = parsed.requestTimeout;
  const headers = parsed.headers;

  if (
    requestTimeout !== undefined &&
    (typeof requestTimeout !== "number" || !Number.isFinite(requestTimeout))
  ) {
    throw new Error("connectionDefaults.requestTimeout must be a number");
  }

  if (headers !== undefined) {
    if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
      throw new Error("connectionDefaults.headers must be a JSON object");
    }

    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === "authorization") {
        throw new Error(
          "connectionDefaults.headers must not include Authorization",
        );
      }

      if (typeof value !== "string") {
        throw new Error(
          `connectionDefaults.headers.${key} must be a string value`,
        );
      }
    }
  }

  return {
    headers: (headers as Record<string, string> | undefined) ?? {},
    requestTimeout:
      typeof requestTimeout === "number"
        ? requestTimeout
        : buildDefaultWorkspaceConnectionDefaults().requestTimeout,
  };
}

function getSectionFieldNames(section: JsonSection) {
  switch (section) {
    case "connectionDefaults":
      return {
        textField: "connectionDefaultsText" as const,
        errorField: "connectionDefaultsError" as const,
      };
    case "clientCapabilities":
      return {
        textField: "clientCapabilitiesText" as const,
        errorField: "clientCapabilitiesError" as const,
      };
    case "hostContext":
      return {
        textField: "hostContextText" as const,
        errorField: "hostContextError" as const,
      };
  }
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
    [section]:
      section === "connectionDefaults"
        ? (nextValue as WorkspaceConnectionDefaults)
        : nextValue,
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
      const normalizedDefaultConfig =
        normalizeConfigForEditing(defaultConfig, defaultConfig) ?? null;
      const normalizedSavedConfig = normalizeConfigForEditing(
        savedConfig,
        normalizedDefaultConfig,
      );
      const shouldApplyPendingRemoteEcho = isPendingRemoteEchoMatch(
        state,
        workspaceId,
        normalizedSavedConfig,
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
        stableStringifyJson(state.defaultConfig) ===
        stableStringifyJson(normalizedDefaultConfig);
      const sameSaved =
        stableStringifyJson(state.savedConfig) ===
        stableStringifyJson(normalizedSavedConfig);

      if (
        sameWorkspace &&
        sameDefault &&
        sameSaved &&
        !shouldApplyPendingRemoteEcho
      ) {
        return;
      }

      set(
        resetFromConfig(
          workspaceId,
          normalizedDefaultConfig,
          normalizedSavedConfig,
        ),
      );
    },

    setSectionText: (section, text) => {
      set((state) => {
        const { textField, errorField } = getSectionFieldNames(section);

        try {
          const parsed =
            section === "connectionDefaults"
              ? parseConnectionDefaultsJson(text)
              : parseRecordJson(text);
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
        const { textField, errorField } = getSectionFieldNames(section);
        return {
          ...nextState,
          [textField]: stringifyJson(nextValue),
          [errorField]: null,
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

    beginSave: ({ workspaceId, savedConfig, awaitRemoteEcho }) =>
      set({
        isSaving: true,
        pendingWorkspaceId: awaitRemoteEcho ? workspaceId : null,
        pendingSavedConfig: awaitRemoteEcho ? savedConfig : undefined,
        isAwaitingRemoteEcho: awaitRemoteEcho,
      }),

    markSaved: (savedConfig) =>
      set((state) => ({
        savedConfig,
        isSaving: false,
        pendingWorkspaceId: null,
        pendingSavedConfig: undefined,
        isAwaitingRemoteEcho: false,
        isDirty: computeDirtyState({
          defaultConfig: state.defaultConfig,
          savedConfig,
          draftConfig: state.draftConfig,
        }),
      })),

    failSave: () =>
      set({
        isSaving: false,
        pendingWorkspaceId: null,
        pendingSavedConfig: undefined,
        isAwaitingRemoteEcho: false,
      }),
  }),
);

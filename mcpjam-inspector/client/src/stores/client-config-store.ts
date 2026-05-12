import { create } from "zustand";
import {
  buildDefaultProjectConnectionConfig,
  buildDefaultProjectConnectionDefaults,
  pickProjectConnectionConfig,
  stableStringifyJson,
  type ProjectConnectionConfigDraft,
  type ProjectConnectionDefaults,
} from "@/lib/client-config";

type JsonSection = "connectionDefaults" | "clientCapabilities";

interface ClientConfigStoreState {
  activeProjectId: string | null;
  defaultConfig: ProjectConnectionConfigDraft | null;
  savedConfig: ProjectConnectionConfigDraft | undefined;
  draftConfig: ProjectConnectionConfigDraft | null;
  connectionDefaultsText: string;
  clientCapabilitiesText: string;
  connectionDefaultsError: string | null;
  clientCapabilitiesError: string | null;
  isSaving: boolean;
  isDirty: boolean;
  pendingProjectId: string | null;
  pendingSavedConfig: ProjectConnectionConfigDraft | undefined;
  isAwaitingRemoteEcho: boolean;
  loadProjectConfig: (input: {
    projectId: string | null;
    defaultConfig: ProjectConnectionConfigDraft | null;
    savedConfig?: ProjectConnectionConfigDraft;
  }) => void;
  setSectionText: (section: JsonSection, text: string) => void;
  resetSectionToDefault: (section: JsonSection) => void;
  resetToBaseline: () => void;
  beginSave: (input: {
    projectId: string;
    savedConfig: ProjectConnectionConfigDraft | undefined;
    awaitRemoteEcho: boolean;
  }) => void;
  markSaved: (savedConfig: ProjectConnectionConfigDraft | undefined) => void;
  failSave: () => void;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function createInitialState(): Omit<
  ClientConfigStoreState,
  | "loadProjectConfig"
  | "setSectionText"
  | "resetSectionToDefault"
  | "resetToBaseline"
  | "beginSave"
  | "markSaved"
  | "failSave"
> {
  return {
    activeProjectId: null,
    defaultConfig: null,
    savedConfig: undefined,
    draftConfig: null,
    connectionDefaultsText: "{}",
    clientCapabilitiesText: "{}",
    connectionDefaultsError: null,
    clientCapabilitiesError: null,
    isSaving: false,
    isDirty: false,
    pendingProjectId: null,
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
  config: ProjectConnectionConfigDraft | null,
): ProjectConnectionConfigDraft | null;
function normalizeConfigForEditing(
  config: ProjectConnectionConfigDraft | undefined,
): ProjectConnectionConfigDraft | undefined;
function normalizeConfigForEditing(
  config: ProjectConnectionConfigDraft | null | undefined,
): ProjectConnectionConfigDraft | null | undefined {
  if (!config) {
    return config;
  }

  return pickProjectConnectionConfig({
    version: 1,
    connectionDefaults: config.connectionDefaults,
    clientCapabilities: config.clientCapabilities,
    hostContext: {},
  });
}

function resetFromConfig(
  projectId: string | null,
  defaultConfig: ProjectConnectionConfigDraft | null,
  savedConfig?: ProjectConnectionConfigDraft,
) {
  const normalizedDefaultConfig = normalizeConfigForEditing(defaultConfig) ?? null;
  const normalizedSavedConfig = normalizeConfigForEditing(savedConfig);
  const baseline = normalizedSavedConfig ?? normalizedDefaultConfig;
  return {
    activeProjectId: projectId,
    defaultConfig: normalizedDefaultConfig,
    savedConfig: normalizedSavedConfig,
    draftConfig: baseline,
    connectionDefaultsText: stringifyJson(
      baseline?.connectionDefaults ?? buildDefaultProjectConnectionDefaults(),
    ),
    clientCapabilitiesText: stringifyJson(baseline?.clientCapabilities ?? {}),
    connectionDefaultsError: null,
    clientCapabilitiesError: null,
    pendingProjectId: null,
    pendingSavedConfig: undefined,
    isAwaitingRemoteEcho: false,
    isSaving: false,
    isDirty: false,
  };
}

function isPendingRemoteEchoMatch(
  state: Pick<
    ClientConfigStoreState,
    "isAwaitingRemoteEcho" | "pendingProjectId" | "pendingSavedConfig"
  >,
  projectId: string | null,
  savedConfig?: ProjectConnectionConfigDraft,
) {
  return (
    state.isAwaitingRemoteEcho &&
    state.pendingProjectId === projectId &&
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

function parseConnectionDefaultsJson(text: string): ProjectConnectionDefaults {
  const parsed = parseRecordJson(text);
  const requestTimeout = parsed.requestTimeout;
  const headers = parsed.headers;

  if (
    requestTimeout !== undefined &&
    (typeof requestTimeout !== "number" ||
      !Number.isFinite(requestTimeout) ||
      requestTimeout <= 0)
  ) {
    throw new Error("connectionDefaults.requestTimeout must be a positive number");
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
        : buildDefaultProjectConnectionDefaults().requestTimeout,
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

  const nextDraftConfig: ProjectConnectionConfigDraft = {
    ...state.draftConfig,
    [section]:
      section === "connectionDefaults"
        ? (nextValue as ProjectConnectionDefaults)
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

    loadProjectConfig: ({ projectId, defaultConfig, savedConfig }) => {
      const state = get();
      const normalizedDefaultConfig = normalizeConfigForEditing(defaultConfig) ?? null;
      const normalizedSavedConfig = normalizeConfigForEditing(savedConfig);
      const shouldApplyPendingRemoteEcho = isPendingRemoteEchoMatch(
        state,
        projectId,
        normalizedSavedConfig,
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
        stableStringifyJson(state.defaultConfig) ===
        stableStringifyJson(normalizedDefaultConfig);
      const sameSaved =
        stableStringifyJson(state.savedConfig) ===
        stableStringifyJson(normalizedSavedConfig);

      if (
        sameProject &&
        sameDefault &&
        sameSaved &&
        !shouldApplyPendingRemoteEcho
      ) {
        return;
      }

      set(
        resetFromConfig(
          projectId,
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

    resetSectionToDefault: (section) => {
      set((state) => {
        const defaultConfig =
          state.defaultConfig ?? buildDefaultProjectConnectionConfig();
        const nextValue = (defaultConfig[section] ?? {}) as Record<
          string,
          unknown
        >;
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
          state.activeProjectId,
          state.defaultConfig,
          state.savedConfig,
        ),
      );
    },

    beginSave: ({ projectId, savedConfig, awaitRemoteEcho }) =>
      set({
        isSaving: true,
        pendingProjectId: awaitRemoteEcho ? projectId : null,
        pendingSavedConfig: awaitRemoteEcho ? savedConfig : undefined,
        isAwaitingRemoteEcho: awaitRemoteEcho,
      }),

    markSaved: (savedConfig) =>
      set((state) => ({
        savedConfig,
        isSaving: false,
        pendingProjectId: null,
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
        pendingProjectId: null,
        pendingSavedConfig: undefined,
        isAwaitingRemoteEcho: false,
      }),
  }),
);

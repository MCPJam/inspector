import type { ClientCapabilityOptions } from "@mcpjam/sdk/browser";
import {
  applyRuntimeClientCapabilities,
  getDefaultClientCapabilities,
  mergeClientCapabilities,
} from "@mcpjam/sdk/browser";

export type WorkspaceClientConfig = {
  version: 1;
  clientCapabilities: Record<string, unknown>;
  hostContext: Record<string, unknown>;
};

export type HostDisplayMode = "inline" | "pip" | "fullscreen";

export type HostDeviceCapabilities = {
  hover: boolean;
  touch: boolean;
};

export type HostSafeAreaInsets = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export const CLIENT_CONFIG_SYNC_PENDING_ERROR_MESSAGE =
  "Workspace client config is still syncing. Try again in a moment.";

export const DEFAULT_HOST_DEVICE_CAPABILITIES: HostDeviceCapabilities = {
  hover: true,
  touch: false,
};

export const DEFAULT_HOST_SAFE_AREA_INSETS: HostSafeAreaInsets = {
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
};

export const DEFAULT_HOST_DISPLAY_MODES: HostDisplayMode[] = [
  "inline",
  "pip",
  "fullscreen",
];

// The inspector server installs a global elicitation callback during app boot,
// so reconnect comparisons should match that on-wire initialize payload.
const INSPECTOR_RUNTIME_CLIENT_CAPABILITIES = {
  elicitation: true,
} as const;

export function buildDefaultHostContext(args: {
  theme: "light" | "dark";
  displayMode: HostDisplayMode;
  locale: string;
  timeZone: string;
  deviceCapabilities: HostDeviceCapabilities;
  safeAreaInsets: HostSafeAreaInsets;
}): Record<string, unknown> {
  return {
    theme: args.theme,
    displayMode: args.displayMode,
    availableDisplayModes: DEFAULT_HOST_DISPLAY_MODES,
    locale: args.locale,
    timeZone: args.timeZone,
    deviceCapabilities: args.deviceCapabilities,
    safeAreaInsets: args.safeAreaInsets,
  };
}

export function buildDefaultWorkspaceClientConfig(args: {
  theme: "light" | "dark";
  displayMode: HostDisplayMode;
  locale: string;
  timeZone: string;
  deviceCapabilities: HostDeviceCapabilities;
  safeAreaInsets: HostSafeAreaInsets;
}): WorkspaceClientConfig {
  return {
    version: 1,
    clientCapabilities: getDefaultClientCapabilities() as Record<
      string,
      unknown
    >,
    hostContext: buildDefaultHostContext(args),
  };
}

export function isWorkspaceClientConfig(
  value: unknown,
): value is WorkspaceClientConfig {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    isRecord(candidate.clientCapabilities) &&
    isRecord(candidate.hostContext)
  );
}

export function sanitizeWorkspaceClientConfig(
  value: unknown,
  fallback: WorkspaceClientConfig,
): WorkspaceClientConfig {
  return isWorkspaceClientConfig(value) ? value : fallback;
}

export function mergeWorkspaceClientCapabilities(
  workspaceCapabilities?: Record<string, unknown>,
  serverCapabilities?: Record<string, unknown>,
): ClientCapabilityOptions {
  return mergeClientCapabilities(
    workspaceCapabilities as ClientCapabilityOptions | undefined,
    serverCapabilities as ClientCapabilityOptions | undefined,
  );
}

export function getEffectiveWorkspaceClientCapabilities(
  workspaceClientConfig?: Pick<
    WorkspaceClientConfig,
    "clientCapabilities"
  > | null,
): ClientCapabilityOptions {
  return normalizeWorkspaceClientCapabilities(
    (workspaceClientConfig?.clientCapabilities as
      | Record<string, unknown>
      | undefined) ??
      (getDefaultClientCapabilities() as Record<string, unknown>),
  );
}

export function getEffectiveServerClientCapabilities(args: {
  workspaceClientConfig?: Pick<
    WorkspaceClientConfig,
    "clientCapabilities"
  > | null;
  workspaceCapabilities?: Record<string, unknown>;
  serverCapabilities?: Record<string, unknown>;
}): ClientCapabilityOptions {
  const workspaceCapabilities =
    args.workspaceCapabilities ??
    getEffectiveWorkspaceClientCapabilities(args.workspaceClientConfig);

  return normalizeWorkspaceClientCapabilities(
    mergeWorkspaceClientCapabilities(
      workspaceCapabilities as Record<string, unknown>,
      args.serverCapabilities,
    ) as Record<string, unknown>,
  );
}

export function normalizeWorkspaceClientCapabilities(
  capabilities?: Record<string, unknown>,
): ClientCapabilityOptions {
  return applyRuntimeClientCapabilities(
    capabilities as ClientCapabilityOptions | undefined,
    INSPECTOR_RUNTIME_CLIENT_CAPABILITIES,
  );
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, canonicalizeJsonValue(nestedValue)]),
    );
  }

  return value;
}

export function stableStringifyJson(value: unknown): string {
  return JSON.stringify(canonicalizeJsonValue(value));
}

export function workspaceClientCapabilitiesNeedReconnect(args: {
  desiredCapabilities?: Record<string, unknown>;
  initializedCapabilities?: Record<string, unknown>;
}): boolean {
  return (
    stableStringifyJson(
      normalizeWorkspaceClientCapabilities(args.desiredCapabilities),
    ) !==
    stableStringifyJson(
      normalizeWorkspaceClientCapabilities(args.initializedCapabilities),
    )
  );
}

export function extractHostDisplayModes(
  hostContext?: Record<string, unknown>,
): HostDisplayMode[] {
  const modes = hostContext?.availableDisplayModes;
  if (!Array.isArray(modes)) {
    return DEFAULT_HOST_DISPLAY_MODES;
  }

  const filtered = modes.filter(isHostDisplayMode);
  return filtered.length > 0 ? filtered : ["inline"];
}

export function extractHostDisplayMode(
  hostContext?: Record<string, unknown>,
): HostDisplayMode | undefined {
  const value = hostContext?.displayMode;
  return isHostDisplayMode(value) ? value : undefined;
}

export function extractEffectiveHostDisplayMode(
  hostContext?: Record<string, unknown>,
): HostDisplayMode {
  return clampDisplayModeToAvailableModes(
    extractHostDisplayMode(hostContext),
    extractHostDisplayModes(hostContext),
  );
}

export function extractHostTheme(
  hostContext?: Record<string, unknown>,
): "light" | "dark" | undefined {
  const value = hostContext?.theme;
  return value === "light" || value === "dark" ? value : undefined;
}

export function extractHostLocale(
  hostContext?: Record<string, unknown>,
  fallback = "en-US",
): string {
  return typeof hostContext?.locale === "string"
    ? hostContext.locale
    : fallback;
}

export function extractHostTimeZone(
  hostContext?: Record<string, unknown>,
  fallback = "UTC",
): string {
  return typeof hostContext?.timeZone === "string"
    ? hostContext.timeZone
    : fallback;
}

export function extractHostDeviceCapabilities(
  hostContext?: Record<string, unknown>,
  fallback: HostDeviceCapabilities = DEFAULT_HOST_DEVICE_CAPABILITIES,
): HostDeviceCapabilities {
  const value = hostContext?.deviceCapabilities;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }

  const capabilities = value as {
    hover?: boolean;
    touch?: boolean;
  };

  return {
    hover: capabilities.hover ?? fallback.hover,
    touch: capabilities.touch ?? fallback.touch,
  };
}

export function extractHostSafeAreaInsets(
  hostContext?: Record<string, unknown>,
  fallback: HostSafeAreaInsets = DEFAULT_HOST_SAFE_AREA_INSETS,
): HostSafeAreaInsets {
  const value = hostContext?.safeAreaInsets;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }

  const insets = value as {
    top?: number;
    right?: number;
    bottom?: number;
    left?: number;
  };

  return {
    top: insets.top ?? fallback.top,
    right: insets.right ?? fallback.right,
    bottom: insets.bottom ?? fallback.bottom,
    left: insets.left ?? fallback.left,
  };
}

export function clampDisplayModeToAvailableModes(
  displayMode: HostDisplayMode | undefined,
  availableDisplayModes: HostDisplayMode[],
): HostDisplayMode {
  if (displayMode && availableDisplayModes.includes(displayMode)) {
    return displayMode;
  }

  return availableDisplayModes[0] ?? "inline";
}

function isHostDisplayMode(value: unknown): value is HostDisplayMode {
  return value === "inline" || value === "pip" || value === "fullscreen";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import type { ClientCapabilityOptions } from "@mcpjam/sdk/browser";
import {
  getDefaultClientCapabilities,
  mergeClientCapabilities,
  normalizeClientCapabilities,
} from "@mcpjam/sdk/browser";

export type WorkspaceClientConfig = {
  version: 1;
  connectionDefaults?: WorkspaceConnectionDefaults;
  clientCapabilities: Record<string, unknown>;
  hostContext: Record<string, unknown>;
};

export type WorkspaceConnectionDefaults = {
  headers: Record<string, string>;
  requestTimeout: number;
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
  "Workspace connection defaults are still syncing. Try again in a moment.";

export const DEFAULT_REQUEST_TIMEOUT_MS = 10000;

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

export function buildDefaultWorkspaceConnectionDefaults(): WorkspaceConnectionDefaults {
  return {
    headers: {},
    requestTimeout: DEFAULT_REQUEST_TIMEOUT_MS,
  };
}

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
    connectionDefaults: buildDefaultWorkspaceConnectionDefaults(),
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
    (candidate.connectionDefaults === undefined ||
      isWorkspaceConnectionDefaults(candidate.connectionDefaults)) &&
    isRecord(candidate.clientCapabilities) &&
    isRecord(candidate.hostContext)
  );
}

export function sanitizeWorkspaceClientConfig(
  value: unknown,
  fallback: WorkspaceClientConfig,
): WorkspaceClientConfig {
  if (!isWorkspaceClientConfig(value)) {
    return fallback;
  }

  return {
    version: 1,
    connectionDefaults: sanitizeWorkspaceConnectionDefaults(
      value.connectionDefaults,
      fallback.connectionDefaults,
    ),
    clientCapabilities: value.clientCapabilities,
    hostContext: value.hostContext,
  };
}

export function sanitizeWorkspaceConnectionDefaults(
  value: unknown,
  fallback: WorkspaceConnectionDefaults = buildDefaultWorkspaceConnectionDefaults(),
): WorkspaceConnectionDefaults {
  if (!isWorkspaceConnectionDefaults(value)) {
    return fallback;
  }

  const headers = normalizeWorkspaceConnectionHeaders(
    value.headers as Record<string, unknown>,
  );
  const requestTimeout = normalizeWorkspaceRequestTimeout(
    value.requestTimeout,
    fallback.requestTimeout,
  );

  return {
    headers,
    requestTimeout,
  };
}

export function getEffectiveWorkspaceConnectionDefaults(
  workspaceClientConfig?: Pick<
    WorkspaceClientConfig,
    "connectionDefaults"
  > | null,
): WorkspaceConnectionDefaults {
  return sanitizeWorkspaceConnectionDefaults(
    workspaceClientConfig?.connectionDefaults,
  );
}

export function mergeWorkspaceConnectionHeaders(
  workspaceHeaders?: Record<string, string>,
  serverHeaders?: Record<string, string>,
): Record<string, string> {
  return {
    ...normalizeWorkspaceConnectionHeaders(
      workspaceHeaders as Record<string, unknown> | undefined,
    ),
    ...normalizeExplicitConnectionHeaders(
      serverHeaders as Record<string, unknown> | undefined,
    ),
  };
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
  return normalizeClientCapabilities(
    capabilities as ClientCapabilityOptions | undefined,
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

function isWorkspaceConnectionDefaults(
  value: unknown,
): value is Partial<WorkspaceConnectionDefaults> {
  if (!isRecord(value)) {
    return false;
  }

  if (value.headers !== undefined && !isRecord(value.headers)) {
    return false;
  }

  return (
    value.requestTimeout === undefined ||
    (typeof value.requestTimeout === "number" &&
      Number.isFinite(value.requestTimeout))
  );
}

function normalizeWorkspaceConnectionHeaders(
  headers?: Record<string, unknown>,
): Record<string, string> {
  if (!headers) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(headers).filter(
      ([key, value]) =>
        key.trim() !== "" &&
        key.toLowerCase() !== "authorization" &&
        typeof value === "string",
    ),
  );
}

function normalizeExplicitConnectionHeaders(
  headers?: Record<string, unknown>,
): Record<string, string> {
  if (!headers) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(headers).filter(
      ([key, value]) => key.trim() !== "" && typeof value === "string",
    ),
  );
}

function normalizeWorkspaceRequestTimeout(
  value: unknown,
  fallback: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0
  ) {
    return fallback;
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

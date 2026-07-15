import type { ClientCapabilityOptions } from "@mcpjam/sdk/browser";
import {
  getDefaultClientCapabilities,
  mergeClientCapabilities,
  normalizeClientCapabilities,
} from "@mcpjam/sdk/browser";
// `stableStringifyJson` relocated to the SDK widget-runtime (Phase 3d-ii);
// imported for internal use and re-exported below so existing import sites stay.
import { stableStringifyJson } from "@mcpjam/sdk/widget-runtime";

export type ProjectClientConfig = {
  version: 1;
  connectionDefaults?: ProjectConnectionDefaults;
  clientCapabilities: Record<string, unknown>;
  hostContext: Record<string, unknown>;
};

export type ProjectConnectionConfigDraft = {
  version: 1;
  connectionDefaults?: ProjectConnectionDefaults;
  clientCapabilities: Record<string, unknown>;
};

export type ProjectHostContextDraft = Record<string, unknown>;

export type ProjectConnectionDefaults = {
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
  "Project connection defaults are still syncing. Try again in a moment.";

export const PROJECT_NOT_PROVISIONED_ERROR_MESSAGE = "Finishing setup.";

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

export function buildDefaultProjectConnectionDefaults(): ProjectConnectionDefaults {
  return {
    headers: {},
    requestTimeout: DEFAULT_REQUEST_TIMEOUT_MS,
  };
}

export function buildDefaultProjectConnectionConfig(): ProjectConnectionConfigDraft {
  return {
    version: 1,
    connectionDefaults: buildDefaultProjectConnectionDefaults(),
    clientCapabilities: getDefaultClientCapabilities() as Record<
      string,
      unknown
    >,
  };
}

export function buildDefaultProjectHostContext(args: {
  theme: "light" | "dark";
  displayMode: HostDisplayMode;
  locale: string;
  timeZone: string;
  deviceCapabilities: HostDeviceCapabilities;
  safeAreaInsets: HostSafeAreaInsets;
}): ProjectHostContextDraft {
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

export const buildDefaultHostContext = buildDefaultProjectHostContext;

export function buildDefaultProjectClientConfig(args: {
  theme: "light" | "dark";
  displayMode: HostDisplayMode;
  locale: string;
  timeZone: string;
  deviceCapabilities: HostDeviceCapabilities;
  safeAreaInsets: HostSafeAreaInsets;
}): ProjectClientConfig {
  return composeProjectClientConfig({
    connectionConfig: buildDefaultProjectConnectionConfig(),
    hostContext: buildDefaultProjectHostContext(args),
  });
}

export function isProjectClientConfig(
  value: unknown,
): value is ProjectClientConfig {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    (candidate.connectionDefaults === undefined ||
      isProjectConnectionDefaults(candidate.connectionDefaults)) &&
    isRecord(candidate.clientCapabilities) &&
    isRecord(candidate.hostContext)
  );
}

export function sanitizeProjectClientConfig(
  value: unknown,
  fallback: ProjectClientConfig,
): ProjectClientConfig {
  if (!isProjectClientConfig(value)) {
    return fallback;
  }

  return composeProjectClientConfig({
    connectionConfig: {
      version: 1,
      connectionDefaults: sanitizeProjectConnectionDefaults(
        value.connectionDefaults,
        fallback.connectionDefaults,
      ),
      clientCapabilities: sanitizeProjectClientCapabilities(
        value.clientCapabilities,
        fallback.clientCapabilities,
      ),
    },
    hostContext: sanitizeProjectHostContext(value.hostContext, fallback.hostContext),
  });
}

export function sanitizeProjectClientCapabilities(
  value: unknown,
  fallback: Record<string, unknown> = getDefaultClientCapabilities() as Record<
    string,
    unknown
  >,
): Record<string, unknown> {
  return isRecord(value) ? value : fallback;
}

export function sanitizeProjectHostContext(
  value: unknown,
  fallback: ProjectHostContextDraft = {},
): ProjectHostContextDraft {
  return isRecord(value) ? value : fallback;
}

export function pickProjectConnectionConfig(
  projectClientConfig?: ProjectClientConfig | null,
): ProjectConnectionConfigDraft {
  return {
    version: 1,
    connectionDefaults: sanitizeProjectConnectionDefaults(
      projectClientConfig?.connectionDefaults,
    ),
    clientCapabilities: sanitizeProjectClientCapabilities(
      projectClientConfig?.clientCapabilities,
    ),
  };
}

export function pickProjectHostContext(
  projectClientConfig?: ProjectClientConfig | null,
  fallback: ProjectHostContextDraft = {},
): ProjectHostContextDraft {
  return sanitizeProjectHostContext(projectClientConfig?.hostContext, fallback);
}

export function composeProjectClientConfig(args: {
  connectionConfig?: ProjectConnectionConfigDraft | null;
  hostContext?: ProjectHostContextDraft | null;
  fallback?: ProjectClientConfig | null;
}): ProjectClientConfig {
  const fallback = args.fallback ?? null;
  const fallbackConnectionConfig = pickProjectConnectionConfig(fallback);
  const fallbackHostContext = pickProjectHostContext(fallback);

  const connectionConfig = args.connectionConfig ?? fallbackConnectionConfig;
  const hostContext = args.hostContext ?? fallbackHostContext;

  return {
    version: 1,
    connectionDefaults: sanitizeProjectConnectionDefaults(
      connectionConfig.connectionDefaults,
      fallbackConnectionConfig.connectionDefaults,
    ),
    clientCapabilities: sanitizeProjectClientCapabilities(
      connectionConfig.clientCapabilities,
      fallbackConnectionConfig.clientCapabilities,
    ),
    hostContext: sanitizeProjectHostContext(hostContext, fallbackHostContext),
  };
}

export function sanitizeProjectConnectionDefaults(
  value: unknown,
  fallback: ProjectConnectionDefaults = buildDefaultProjectConnectionDefaults(),
): ProjectConnectionDefaults {
  if (!isProjectConnectionDefaults(value)) {
    return fallback;
  }

  const headers = normalizeProjectConnectionHeaders(
    value.headers as Record<string, unknown>,
  );
  const requestTimeout = normalizeProjectRequestTimeout(
    value.requestTimeout,
    fallback.requestTimeout,
  );

  return {
    headers,
    requestTimeout,
  };
}

export function getEffectiveProjectConnectionDefaults(
  projectClientConfig?: Pick<
    ProjectClientConfig,
    "connectionDefaults"
  > | null,
): ProjectConnectionDefaults {
  return sanitizeProjectConnectionDefaults(
    projectClientConfig?.connectionDefaults,
  );
}

export function mergeProjectConnectionHeaders(
  projectHeaders?: Record<string, string>,
  serverHeaders?: Record<string, string>,
): Record<string, string> {
  return {
    ...normalizeProjectConnectionHeaders(
      projectHeaders as Record<string, unknown> | undefined,
    ),
    ...normalizeExplicitConnectionHeaders(
      serverHeaders as Record<string, unknown> | undefined,
    ),
  };
}

export function mergeProjectClientCapabilities(
  projectCapabilities?: Record<string, unknown>,
  serverCapabilities?: Record<string, unknown>,
): ClientCapabilityOptions {
  return mergeClientCapabilities(
    projectCapabilities as ClientCapabilityOptions | undefined,
    serverCapabilities as ClientCapabilityOptions | undefined,
  );
}

export function getEffectiveProjectClientCapabilities(
  projectClientConfig?: Pick<
    ProjectClientConfig,
    "clientCapabilities"
  > | null,
): ClientCapabilityOptions {
  return normalizeProjectClientCapabilities(
    (projectClientConfig?.clientCapabilities as
      | Record<string, unknown>
      | undefined) ??
      (getDefaultClientCapabilities() as Record<string, unknown>),
  );
}

export function getEffectiveServerClientCapabilities(args: {
  projectClientConfig?: Pick<
    ProjectClientConfig,
    "clientCapabilities"
  > | null;
  projectCapabilities?: Record<string, unknown>;
  serverCapabilities?: Record<string, unknown>;
}): ClientCapabilityOptions {
  const projectCapabilities =
    args.projectCapabilities ??
    getEffectiveProjectClientCapabilities(args.projectClientConfig);

  return normalizeProjectClientCapabilities(
    mergeProjectClientCapabilities(
      projectCapabilities as Record<string, unknown>,
      args.serverCapabilities,
    ) as Record<string, unknown>,
  );
}

/**
 * @deprecated Use `resolveEffectiveClientCapabilities` from
 * `lib/effective-host.ts` instead. This shim only exists to keep older call
 * sites compiling during the migration; new code MUST go through the host.
 *
 * Behavior is preserved: per-server explicit > project clientConfig (which
 * is itself a shadow-mirror of the project default host).
 */
export function resolveEffectiveServerClientCapabilities(args: {
  serverConfig?: {
    clientCapabilities?: unknown;
    capabilities?: unknown;
  } | null;
  projectClientConfig?: Pick<
    ProjectClientConfig,
    "clientCapabilities"
  > | null;
}): ClientCapabilityOptions {
  const explicit = args.serverConfig?.clientCapabilities as
    | Record<string, unknown>
    | undefined;
  if (explicit) {
    return normalizeProjectClientCapabilities(explicit);
  }
  return getEffectiveServerClientCapabilities({
    projectClientConfig: args.projectClientConfig,
    serverCapabilities: args.serverConfig?.capabilities as
      | Record<string, unknown>
      | undefined,
  });
}

export function normalizeProjectClientCapabilities(
  capabilities?: Record<string, unknown>,
): ClientCapabilityOptions {
  return normalizeClientCapabilities(
    capabilities as ClientCapabilityOptions | undefined,
  );
}

// `stableStringifyJson` (+ its private canonicalizer) relocated to
// @mcpjam/sdk/widget-runtime (Phase 3d-ii); re-exported for back-compat with
// `@/lib/client-config` consumers.
export { stableStringifyJson };

export function projectClientCapabilitiesNeedReconnect(args: {
  desiredCapabilities?: Record<string, unknown>;
  initializedCapabilities?: Record<string, unknown>;
}): boolean {
  return (
    stableStringifyJson(
      normalizeProjectClientCapabilities(args.desiredCapabilities),
    ) !==
    stableStringifyJson(
      normalizeProjectClientCapabilities(args.initializedCapabilities),
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

function isProjectConnectionDefaults(
  value: unknown,
): value is Partial<ProjectConnectionDefaults> {
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

function normalizeProjectConnectionHeaders(
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
  ) as Record<string, string>;
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
  ) as Record<string, string>;
}

function normalizeProjectRequestTimeout(
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

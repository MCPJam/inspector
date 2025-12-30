import {
  PostHog,
  type EventMessage,
  type IdentifyMessage,
  type PostHogOptions,
} from "posthog-node";

const DEFAULT_POSTHOG_HOST = "https://app.posthog.com";
const DEFAULT_DISTINCT_ID = "anonymous";

type TelemetryInitOptions = {
  apiKey?: string;
  host?: string;
  enabled?: boolean;
  defaultDistinctId?: string;
  defaultProperties?: Record<string, unknown>;
  posthogOptions?: Partial<PostHogOptions>;
  onError?: (error: unknown) => void;
};

type TelemetryCaptureOptions = {
  distinctId?: string;
  properties?: Record<string, unknown>;
  groups?: EventMessage["groups"];
  sendFeatureFlags?: EventMessage["sendFeatureFlags"];
  timestamp?: EventMessage["timestamp"];
  disableGeoip?: EventMessage["disableGeoip"];
  uuid?: EventMessage["uuid"];
  immediate?: boolean;
};

type TelemetryIdentifyOptions = {
  properties?: IdentifyMessage["properties"];
  disableGeoip?: IdentifyMessage["disableGeoip"];
  immediate?: boolean;
};

type TelemetryState = {
  client?: PostHog;
  enabled: boolean;
  defaultDistinctId: string;
  defaults: Record<string, unknown>;
  lastIdentifiedId?: string;
  onError?: (error: unknown) => void;
};

const telemetryState: TelemetryState = {
  enabled: false,
  defaultDistinctId: DEFAULT_DISTINCT_ID,
  defaults: {},
};

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  if (TRUTHY.has(trimmed)) {
    return true;
  }
  if (FALSY.has(trimmed)) {
    return false;
  }
  return undefined;
}

function getEnv(name: string): string | undefined {
  if (typeof process === "undefined" || !process.env) {
    return undefined;
  }
  return process.env[name];
}

function readFirstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = getEnv(name);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function sanitizeForState(
  record?: Record<string, unknown>,
): Record<string, unknown> {
  if (!record) {
    return {};
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function sanitizeRecord(
  record?: Record<string | number, unknown>,
): Record<string | number, any> | undefined {
  if (!record) {
    return undefined;
  }
  const filtered: Record<string | number, any> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      filtered[key] = value as any;
    }
  }
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function mergedEventProperties(
  overrides?: Record<string, unknown>,
): Record<string | number, any> | undefined {
  const merged: Record<string, unknown> = {
    ...telemetryState.defaults,
  };
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) {
        delete merged[key];
      } else {
        merged[key] = value;
      }
    }
  }
  return sanitizeRecord(merged);
}

function resolveDistinctId(distinctId?: string): string {
  const candidate =
    distinctId ??
    telemetryState.lastIdentifiedId ??
    telemetryState.defaultDistinctId ??
    DEFAULT_DISTINCT_ID;
  return `${candidate}`;
}

function handleTelemetryError(error: unknown): void {
  if (!error) {
    return;
  }
  if (telemetryState.onError) {
    telemetryState.onError(error);
    return;
  }
  if (
    typeof process !== "undefined" &&
    process.env?.NODE_ENV !== "production"
  ) {
    // eslint-disable-next-line no-console
    console.warn("[mcpjam/sdk] telemetry error", error);
  }
}

export function initTelemetry(options: TelemetryInitOptions = {}): void {
  const envEnabled = parseBoolean(
    readFirstEnv(
      "MCPJAM_TELEMETRY_ENABLED",
      "POSTHOG_ENABLED",
      "ENABLE_POSTHOG",
    ),
  );
  const envDisabled = parseBoolean(
    readFirstEnv(
      "MCPJAM_TELEMETRY_DISABLED",
      "POSTHOG_DISABLED",
      "DISABLE_POSTHOG",
      "MCPJAM_DISABLE_TELEMETRY",
    ),
  );

  let resolvedEnabled = options.enabled;
  if (resolvedEnabled === undefined) {
    if (envEnabled !== undefined) {
      resolvedEnabled = envEnabled;
    } else if (envDisabled !== undefined) {
      resolvedEnabled = !envDisabled;
    } else {
      resolvedEnabled = true;
    }
  }

  const apiKey =
    options.apiKey ??
    readFirstEnv("MCPJAM_POSTHOG_KEY", "POSTHOG_API_KEY", "POSTHOG_API_TOKEN");

  const defaultDistinct =
    options.defaultDistinctId ??
    readFirstEnv(
      "MCPJAM_TELEMETRY_ID",
      "POSTHOG_DISTINCT_ID",
      "TELEMETRY_DISTINCT_ID",
    ) ??
    telemetryState.defaultDistinctId;
  telemetryState.defaultDistinctId = `${defaultDistinct ?? DEFAULT_DISTINCT_ID}`;

  if (hasOwn(options, "defaultProperties")) {
    telemetryState.defaults = sanitizeForState(options.defaultProperties);
  }
  if (hasOwn(options, "onError")) {
    telemetryState.onError = options.onError;
  }

  if (!resolvedEnabled || !apiKey) {
    telemetryState.enabled = false;
    if (telemetryState.client) {
      const previous = telemetryState.client;
      telemetryState.client = undefined;
      previous._shutdown().catch(handleTelemetryError);
    }
    return;
  }

  const host =
    options.host ??
    readFirstEnv("MCPJAM_POSTHOG_HOST", "POSTHOG_HOST") ??
    options.posthogOptions?.host ??
    DEFAULT_POSTHOG_HOST;

  if (telemetryState.client) {
    const previous = telemetryState.client;
    telemetryState.client = undefined;
    previous._shutdown().catch(handleTelemetryError);
  }

  try {
    const posthogOptions: PostHogOptions = {
      ...options.posthogOptions,
      host,
    } as PostHogOptions;
    telemetryState.client = new PostHog(apiKey, posthogOptions);
    telemetryState.enabled = true;
  } catch (error) {
    telemetryState.client = undefined;
    telemetryState.enabled = false;
    handleTelemetryError(error);
  }
}

export function isTelemetryEnabled(): boolean {
  return telemetryState.enabled && Boolean(telemetryState.client);
}

export function captureTelemetry(
  event: string,
  options: TelemetryCaptureOptions = {},
): boolean {
  if (!isTelemetryEnabled() || !telemetryState.client) {
    return false;
  }

  const distinctId = resolveDistinctId(options.distinctId);
  const message: EventMessage = {
    distinctId,
    event,
  };

  const properties = mergedEventProperties(options.properties);
  if (properties) {
    message.properties = properties;
  }
  if (options.groups) {
    message.groups = options.groups;
  }
  if (options.sendFeatureFlags !== undefined) {
    message.sendFeatureFlags = options.sendFeatureFlags;
  }
  if (options.timestamp) {
    message.timestamp = options.timestamp;
  }
  if (options.disableGeoip !== undefined) {
    message.disableGeoip = options.disableGeoip;
  }
  if (options.uuid) {
    message.uuid = options.uuid;
  }

  try {
    if (options.immediate) {
      telemetryState.client
        .captureImmediate(message)
        .catch(handleTelemetryError);
    } else {
      telemetryState.client.capture(message);
    }
    return true;
  } catch (error) {
    handleTelemetryError(error);
    return false;
  }
}

export function identifyTelemetry(
  distinctId: string,
  options: TelemetryIdentifyOptions = {},
): boolean {
  telemetryState.lastIdentifiedId = `${distinctId}`;

  if (!isTelemetryEnabled() || !telemetryState.client) {
    return false;
  }

  const payload: IdentifyMessage = {
    distinctId: telemetryState.lastIdentifiedId,
  };

  const properties = sanitizeRecord(options.properties);
  if (properties) {
    payload.properties = properties;
  }
  if (options.disableGeoip !== undefined) {
    payload.disableGeoip = options.disableGeoip;
  }

  try {
    if (options.immediate) {
      telemetryState.client
        .identifyImmediate(payload)
        .catch(handleTelemetryError);
    } else {
      telemetryState.client.identify(payload);
    }
    return true;
  } catch (error) {
    handleTelemetryError(error);
    return false;
  }
}

export async function shutdownTelemetry(timeoutMs?: number): Promise<void> {
  const client = telemetryState.client;
  telemetryState.client = undefined;
  telemetryState.enabled = false;
  if (!client) {
    return;
  }
  try {
    await client._shutdown(timeoutMs);
  } catch (error) {
    handleTelemetryError(error);
  }
}

export function getTelemetryClient(): PostHog | undefined {
  return telemetryState.client;
}

export function getTelemetryDistinctId(): string {
  return telemetryState.lastIdentifiedId ?? telemetryState.defaultDistinctId;
}

export function mergeTelemetryDefaults(
  properties: Record<string, unknown>,
): void {
  if (!properties) {
    return;
  }
  const sanitized = sanitizeForState(properties);
  telemetryState.defaults = {
    ...telemetryState.defaults,
    ...sanitized,
  };
}

export function setTelemetryDefaults(
  properties: Record<string, unknown>,
): void {
  telemetryState.defaults = sanitizeForState(properties);
}

export function clearTelemetryDefaults(keys?: string[]): void {
  if (!keys) {
    telemetryState.defaults = {};
    return;
  }
  const next = { ...telemetryState.defaults };
  for (const key of keys) {
    delete next[key];
  }
  telemetryState.defaults = next;
}

export function getTelemetryDefaults(): Record<string, unknown> {
  return { ...telemetryState.defaults };
}

export type {
  TelemetryInitOptions,
  TelemetryCaptureOptions,
  TelemetryIdentifyOptions,
};

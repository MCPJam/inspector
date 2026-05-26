/**
 * Effective-host resolution.
 *
 * Single source of truth for "which host config is active for this surface,
 * and what does it imply for MCP `initialize` and widget rendering?".
 *
 * Every project has at least one host (the project default). The selected
 * host wins; absent a selection, the project default is the effective host.
 * There is no `projectClientConfig` fallback — that shape is a shadow-mirror
 * of the project default and the inspector reads through the host instead.
 */

import type { ClientCapabilityOptions } from "@mcpjam/sdk/browser";
import {
  getDefaultClientCapabilities,
  mergeClientCapabilities,
  normalizeClientCapabilities,
} from "@mcpjam/sdk/browser";
import type {
  HostConfigConnectionDefaults,
  HostConfigDtoV2,
  HostConfigMcpProfileV1,
} from "./client-config-v2";
import { resolveServerConnectionSettings } from "./client-connection-resolve";

/**
 * Resolve the effective host for a surface.
 *
 * Precedence: an explicitly-selected host (top-bar picker, chatbox host
 * field, eval suite host field) → the project default host (always present
 * after provisioning).
 *
 * Returns `undefined` only during transient bootstrap (project not yet
 * provisioned, queries still loading). Call sites should gate on
 * `isClientConfigSyncPending` for those windows.
 */
export function resolveEffectiveHost(args: {
  explicitHostConfig?: HostConfigDtoV2 | null;
  projectDefaultHostConfig?: HostConfigDtoV2 | null;
}): HostConfigDtoV2 | undefined {
  return args.explicitHostConfig ?? args.projectDefaultHostConfig ?? undefined;
}

/**
 * Effective MCP `initialize` inputs for a single server within a host.
 *
 * Precedence for `clientCapabilities`:
 *   1. Per-server explicit `clientCapabilities` override (verbatim).
 *   2. Host `clientCapabilities` merged with per-server `capabilities`
 *      (additive declarations, host wins on key conflicts).
 *   3. SDK defaults — only when no host is supplied (transient bootstrap).
 *
 * Precedence for `mcpProfile` and `connectionDefaults`: host-level only.
 * Per-server overrides apply on top of `connectionDefaults` via
 * {@link resolveServerConnectionSettings}.
 */
export function resolveServerInit(args: {
  host?: HostConfigDtoV2 | null;
  serverConfig?: {
    clientCapabilities?: unknown;
    capabilities?: unknown;
    requestInit?: RequestInit;
    timeout?: number;
  } | null;
  serverId?: string;
}): {
  clientCapabilities: ClientCapabilityOptions;
  mcpProfile: HostConfigMcpProfileV1 | undefined;
  connectionDefaults: HostConfigConnectionDefaults | undefined;
  perServerOverride:
    | {
        headersOverride?: Record<string, string>;
        requestTimeoutOverride?: number;
      }
    | undefined;
} {
  const clientCapabilities = resolveEffectiveClientCapabilities({
    host: args.host ?? undefined,
    serverConfig: args.serverConfig ?? undefined,
  });

  const perServerOverride =
    args.serverId && args.host?.serverConnectionOverrides
      ? args.host.serverConnectionOverrides[args.serverId]
      : undefined;

  return {
    clientCapabilities,
    mcpProfile: args.host?.mcpProfile,
    connectionDefaults: args.host?.connectionDefaults,
    perServerOverride,
  };
}

/**
 * Used by both the connect path (to build the `initialize` payload) and the
 * reconnect-drift indicator (to detect when the desired caps no longer match
 * what's running). Both sides MUST call this so the indicator doesn't fire on
 * unchanged servers.
 */
export function resolveEffectiveClientCapabilities(args: {
  host?: Pick<HostConfigDtoV2, "clientCapabilities"> | null;
  serverConfig?: {
    clientCapabilities?: unknown;
    capabilities?: unknown;
  } | null;
}): ClientCapabilityOptions {
  const explicit = args.serverConfig?.clientCapabilities as
    | Record<string, unknown>
    | undefined;
  if (isRecord(explicit)) {
    return normalizeClientCapabilities(
      explicit as ClientCapabilityOptions,
    );
  }

  const hostCaps = isRecord(args.host?.clientCapabilities)
    ? (args.host!.clientCapabilities as Record<string, unknown>)
    : (getDefaultClientCapabilities() as Record<string, unknown>);

  const serverCaps = isRecord(args.serverConfig?.capabilities)
    ? (args.serverConfig!.capabilities as Record<string, unknown>)
    : undefined;

  return normalizeClientCapabilities(
    mergeClientCapabilities(
      hostCaps as ClientCapabilityOptions,
      serverCaps as ClientCapabilityOptions | undefined,
    ) as ClientCapabilityOptions,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

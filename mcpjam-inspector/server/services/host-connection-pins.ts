/**
 * A host config's non-secret CONNECTION settings, as `createAuthorizedManager`
 * takes them.
 *
 * WHY THIS IS SHARED. Two surfaces need the same reading. A swarm run
 * reconnects with the settings its snapshot captured, so the run reproduces the
 * pin rather than whatever the host's current config would negotiate. An eval
 * run needs it for a different reason: the browser sends initialize pins
 * derived from whichever host is ACTIVE in the playground, which is not
 * necessarily the host the run executes under — an environment pins its own.
 * Tool visibility already resolved server-side from the run's host while the
 * protocol version and pagination came from the active one, so a single run
 * could be described two ways. Reading both from the run's host makes them one.
 *
 * SECRETS ARE EXCLUDED, deliberately. Headers and credentials stay live-
 * resolved by the authorize batch — a run must use fresh secrets, never a
 * snapshot's.
 *
 * TOTAL AND NON-THROWING. Callers pass opaque `Record<string, unknown>` blobs
 * (a swarm's pinned snapshot, or whatever `loadSuiteHostConfig` returns), so
 * every field is read defensively: a malformed or absent value falls back to
 * the live default rather than failing a launch.
 *
 * WHAT THIS DOES NOT DO. It does not read the client-conformance knobs
 * (`paginationTraversal`, `mrtrSupport`, …). Those have their own overlay pair
 * in `utils/effective-auth.ts` — `applyHostConformanceKnobs` /
 * `applyHostParamMirroring` — because they are SUPPRESSION switches with no
 * positive state: a host wanting the full behavior has to REMOVE a body pin,
 * not merely fail to set one. Keeping them there means the eval path and the
 * chat path enforce them through one implementation.
 */

import type { McpProtocolVersion } from "@mcpjam/sdk";
import { isKnownProtocolVersion } from "@mcpjam/sdk";

/**
 * The fields this module reads. Structural on purpose: a swarm's
 * `PinnedHostExecutionSpec` and a raw host config from `loadSuiteHostConfig`
 * both satisfy it without either learning about the other.
 */
export interface HostConnectionSource {
  connectionDefaults?: unknown;
  serverConnectionOverrides?: unknown;
  mcpProfile?: unknown;
  clientCapabilities?: unknown;
}

export interface HostConnectionPins {
  timeoutMs: number;
  initializePins?: {
    clientInfo?: { name?: string; version?: string } & Record<string, unknown>;
    supportedProtocolVersions?: string[];
    mcpProtocolVersion?: McpProtocolVersion;
  };
  mcpProtocolVersionsByServerId?: Record<string, McpProtocolVersion>;
  /**
   * Per-server request-timeout pins (ms) from
   * `serverConnectionOverrides[serverId].requestTimeoutOverride`. A server
   * absent from this map uses the host-level `timeoutMs`.
   */
  requestTimeoutByServerId?: Record<string, number>;
}

function coerceTimeoutMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function coerceProtocolVersion(value: unknown): McpProtocolVersion | undefined {
  return typeof value === "string" && isKnownProtocolVersion(value)
    ? value
    : undefined;
}

/**
 * The MCP client capabilities a host advertises on `initialize`.
 *
 * `undefined` means the host declares none, which is NOT the same as declaring
 * an empty set: `createAuthorizedManager` reads absent as "use the SDK
 * defaults", while `{}` would advertise nothing at all.
 */
export function hostClientCapabilities(
  host: HostConnectionSource,
): Record<string, unknown> | undefined {
  const capabilities = asRecord(host.clientCapabilities);
  return capabilities && Object.keys(capabilities).length > 0
    ? capabilities
    : undefined;
}

export function buildHostConnectionPins(
  host: HostConnectionSource,
  fallbackTimeoutMs: number,
): HostConnectionPins {
  const defaults = asRecord(host.connectionDefaults);

  // Timeout: read from the (possibly scrubbed) `connectionDefaults` — on a
  // swarm snapshot the ONLY field the backend retains there is `requestTimeout`
  // (header values are stripped). Accept either wire spelling defensively;
  // require a positive finite number, else fall back to the live default.
  const timeoutMs =
    coerceTimeoutMs(defaults?.timeoutMs ?? defaults?.requestTimeout) ??
    fallbackTimeoutMs;

  // INITIALIZE pins come from `mcpProfile`, NOT `connectionDefaults`. The
  // backend's `materializeHostSpec` copies a host's `mcpProfile` verbatim
  // (`mcpProtocolVersion` + `initialize.{clientInfo,supportedProtocolVersions}`)
  // and scrubs `connectionDefaults` down to just `{ requestTimeout }`, so
  // reading the pins from `connectionDefaults` always found nothing.
  const mcpProfile = asRecord(host.mcpProfile);
  const initializePins: NonNullable<HostConnectionPins["initializePins"]> = {};
  const initialize = asRecord(mcpProfile?.initialize);
  const clientInfo = asRecord(initialize?.clientInfo);
  if (clientInfo) {
    initializePins.clientInfo = clientInfo as {
      name?: string;
      version?: string;
    } & Record<string, unknown>;
  }
  if (Array.isArray(initialize?.supportedProtocolVersions)) {
    const versions = initialize.supportedProtocolVersions.filter(
      // Trimmed-empty entries are dropped, matching the client-side resolver:
      // a blank string is not a version, and it would ride the accept-list
      // onto the wire.
      (v): v is string => typeof v === "string" && v.trim() !== "",
    );
    if (versions.length > 0) {
      initializePins.supportedProtocolVersions = versions;
    }
  }
  const batchProtocol = coerceProtocolVersion(mcpProfile?.mcpProtocolVersion);
  if (batchProtocol) {
    initializePins.mcpProtocolVersion = batchProtocol;
  }

  // Per-server pins from the overrides map. Accept both the resolver key
  // (`mcpProtocolVersion`) and the project-config key
  // (`mcpProtocolVersionOverride`); `createAuthorizedManager` re-validates.
  const overrides = asRecord(host.serverConnectionOverrides);
  let mcpProtocolVersionsByServerId:
    Record<string, McpProtocolVersion> | undefined;
  let requestTimeoutByServerId: Record<string, number> | undefined;
  if (overrides) {
    for (const [serverId, rawOverride] of Object.entries(overrides)) {
      const override = asRecord(rawOverride);
      if (!override) continue;
      const pin = coerceProtocolVersion(
        override.mcpProtocolVersion ?? override.mcpProtocolVersionOverride,
      );
      if (pin) {
        mcpProtocolVersionsByServerId ??= {};
        mcpProtocolVersionsByServerId[serverId] = pin;
      }
      // Accept both the resolver spelling (`requestTimeout`) and the
      // project-config override spelling (`requestTimeoutOverride`); a
      // malformed value is skipped so the server falls back to `timeoutMs`.
      const perServerTimeout = coerceTimeoutMs(
        override.requestTimeoutOverride ?? override.requestTimeout,
      );
      if (perServerTimeout !== undefined) {
        requestTimeoutByServerId ??= {};
        requestTimeoutByServerId[serverId] = perServerTimeout;
      }
    }
  }

  return {
    timeoutMs,
    ...(Object.keys(initializePins).length > 0 ? { initializePins } : {}),
    ...(mcpProtocolVersionsByServerId ? { mcpProtocolVersionsByServerId } : {}),
    ...(requestTimeoutByServerId ? { requestTimeoutByServerId } : {}),
  };
}

/**
 * WHY THERE IS NO MERGE HELPER HERE.
 *
 * When a run's host is resolved, its pins REPLACE the body's rather than
 * merging with them. Every field a browser sends — `clientInfo`, the accept
 * list, the per-server protocol map — is derived from whichever host the
 * playground had ACTIVE, so a per-key merge leaves the drift in place wherever
 * the run's host happens to be silent: a body pin of `2025-11-25` for one
 * server would still beat the run host's `2026-07-28`, which is the exact bug
 * this reading exists to close. Callers therefore pass
 * `buildHostConnectionPins(...)` straight through, and only the conformance
 * overlays in `utils/effective-auth.ts` combine host and body.
 */

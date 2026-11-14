/**
 * Connecting as a subscription's host (MCP Events, background workers). The
 * keeper and the trigger executor take the connection settings an eval run
 * takes from its host (`routes/v1/evals.ts`), through the same readers:
 * identity and protocol pins, advertised capabilities, the conformance
 * switches and the timeout.
 *
 * Not taken: the enterprise-managed authorization policy, which needs the
 * request's XAA issuer that a background run lacks. Event runs keep the OAuth
 * connection the subscription was created with.
 */

import { WEB_CALL_TIMEOUT_MS } from "../../config.js";
import {
  buildHostConnectionPins,
  hostClientCapabilities,
  type HostConnectionSource,
} from "../host-connection-pins.js";
import {
  applyHostConformanceKnobs,
  applyHostParamMirroring,
  conformanceKnobsFromMcpProfile,
  mirrorToolParamHeadersFromMcpProfile,
} from "../../utils/effective-auth.js";
import type { createAuthorizedManager } from "../../routes/web/auth.js";

type ManagerOptions = NonNullable<Parameters<typeof createAuthorizedManager>[7]>;

export interface HostManagerArgs {
  timeoutMs: number;
  clientCapabilities?: Record<string, unknown>;
  options: Pick<
    ManagerOptions,
    "initializePins" | "mcpProtocolVersionsByServerId" | "requestTimeoutByServerId"
  >;
}

/** `createAuthorizedManager`'s host-derived arguments for `host`. */
export function hostManagerArgs(
  host: HostConnectionSource,
  fallbackTimeoutMs = WEB_CALL_TIMEOUT_MS,
): HostManagerArgs {
  const pins = buildHostConnectionPins(host, fallbackTimeoutMs);
  const basePins: ManagerOptions["initializePins"] = pins.initializePins;
  const initializePins = applyHostConformanceKnobs(
    applyHostParamMirroring(basePins, mirrorToolParamHeadersFromMcpProfile(host.mcpProfile)),
    conformanceKnobsFromMcpProfile(host.mcpProfile),
  );
  const clientCapabilities = hostClientCapabilities(host);
  return {
    timeoutMs: pins.timeoutMs,
    ...(clientCapabilities ? { clientCapabilities } : {}),
    options: {
      ...(initializePins ? { initializePins } : {}),
      ...(pins.mcpProtocolVersionsByServerId
        ? { mcpProtocolVersionsByServerId: pins.mcpProtocolVersionsByServerId }
        : {}),
      ...(pins.requestTimeoutByServerId
        ? { requestTimeoutByServerId: pins.requestTimeoutByServerId }
        : {}),
    },
  };
}

/** Why a run or refresh cannot act as its subscription's host. */
export type HostResolutionFailure =
  | "host_missing"
  | "environment_host_changed"
  | "host_changed";

export class HostResolutionError extends Error {
  constructor(readonly reason: HostResolutionFailure) {
    super(reason);
    this.name = "HostResolutionError";
  }
}

/**
 * The host config to act as, or null for MCPJam (built-in). A deleted host
 * (404) is `host_missing`; any other failure is thrown as-is, so the caller
 * retries it like any transient step failure.
 */
export async function loadSubscriptionHostConfig(args: {
  hostId: string | null | undefined;
  bearer: string;
  /** The config id an environment resolved alongside its servers, when any. */
  expectedHostConfigId?: string;
}): Promise<Record<string, unknown> | null> {
  if (!args.hostId) return null;
  const { fetchHostRuntimeConfig } = await import("../../utils/host-runtime-config.js");
  const result = await fetchHostRuntimeConfig({ hostId: args.hostId, bearer: args.bearer });
  if (!result.ok) {
    if (result.status === 404) throw new HostResolutionError("host_missing");
    throw new Error(`host config unavailable (${result.status}): ${result.error}`);
  }
  const config = result.config as Record<string, unknown>;
  // The environment's servers and the host's settings must come from the same
  // host config. A host edited between the two reads is refused rather than
  // mixed.
  if (
    args.expectedHostConfigId &&
    typeof config.hostConfigId === "string" &&
    config.hostConfigId !== args.expectedHostConfigId
  ) {
    throw new HostResolutionError("host_changed");
  }
  return config;
}

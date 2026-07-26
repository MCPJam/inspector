import {
  withEphemeralClient,
  type MCPServerConfig,
  type RetryPolicy,
  type RpcLogger,
} from "@mcpjam/sdk";
import type { HostConnectionProfile } from "@mcpjam/sdk/host-config/internal";
import { applyHostToConfig } from "./host-resolve.js";
import { INTERACTIVE_ELICITATION_CAPABILITY } from "./mrtr-input.js";
import { usageError } from "./output.js";

export interface EphemeralManagerOptions {
  timeout?: number;
  rpcLogger?: RpcLogger;
  retryPolicy?: RetryPolicy;
  /**
   * Connect "as a host" — merge the host's `clientInfo`/`clientCapabilities`/
   * protocol pins onto the config so the `initialize` handshake advertises that
   * host's identity. Resolve via `resolveHostFromOptions` in `host-resolve`.
   */
  host?: HostConnectionProfile;
  /**
   * Runs against the manager BEFORE the initial connect. Used by the
   * interactive verbs to register an MRTR input collector via
   * `setMrtrInputCollector` so `elicitation` is advertised on the connect
   * envelope (a modern server only embeds elicitation when it is).
   */
  beforeConnect?: (
    manager: import("@mcpjam/sdk").MCPClientManager,
    serverId: string,
  ) => void | Promise<void>;
  /**
   * Set by the interactive verbs (`--interactive`). Declares the elicitation
   * modes the terminal collector actually implements on the connect envelope —
   * see {@link applyInteractiveElicitationCapability}.
   */
  interactiveElicitation?: boolean;
}

/**
 * Makes the `initialize` envelope declare the elicitation modes the interactive
 * terminal collector implements (`form` + `url`).
 *
 * Registering an MRTR collector alone only gets the manager to advertise bare
 * `elicitation: {}`, which is **form-only** — so a spec-compliant server would
 * never send the url-mode request the collector handles, and url-mode MRTR
 * could never start. Merged into the legacy `capabilities` bag so manager
 * defaults still apply.
 *
 * `--client-capabilities` / `--host` instead pin an EXACT set: silently
 * injecting into it would break the point of those flags (advertising exactly
 * what a given host advertises), and silently dropping interactivity would make
 * `--interactive` a no-op. So an exact set that omits `elicitation` is a usage
 * error the user resolves explicitly. An exact set that declares `elicitation`
 * is honored verbatim, modes included.
 */
export function applyInteractiveElicitationCapability(
  config: MCPServerConfig,
): MCPServerConfig {
  const exact = (config as { clientCapabilities?: Record<string, unknown> })
    .clientCapabilities;
  if (exact) {
    if (exact.elicitation == null) {
      throw usageError(
        "--interactive requires the advertised client capabilities to include " +
          "`elicitation`, but --client-capabilities/--host pinned an exact set " +
          'without it. Add `"elicitation": { "form": {}, "url": {} }` to the ' +
          "capabilities, or drop --interactive.",
      );
    }
    return config;
  }

  const capabilities = (config.capabilities ?? {}) as Record<string, unknown>;
  return {
    ...config,
    capabilities: {
      ...capabilities,
      elicitation: {
        ...INTERACTIVE_ELICITATION_CAPABILITY,
        ...(isRecord(capabilities.elicitation) ? capabilities.elicitation : {}),
      },
    },
  } as MCPServerConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export async function withEphemeralManager<T>(
  config: MCPServerConfig,
  fn: (
    manager: import("@mcpjam/sdk").MCPClientManager,
    serverId: string,
  ) => Promise<T>,
  options?: EphemeralManagerOptions,
): Promise<T> {
  const hostConfig = options?.host
    ? applyHostToConfig(config, options.host)
    : config;
  // After the host merge: a host profile also pins an exact capability set, so
  // the interactive check has to see the post-merge envelope.
  const resolvedConfig = options?.interactiveElicitation
    ? applyInteractiveElicitationCapability(hostConfig)
    : hostConfig;
  return withEphemeralClient(resolvedConfig, fn, {
    serverId: "__cli__",
    clientName: "mcpjam",
    timeout: options?.timeout ?? 30_000,
    rpcLogger: options?.rpcLogger,
    retryPolicy: options?.retryPolicy,
    beforeConnect: options?.beforeConnect,
  });
}

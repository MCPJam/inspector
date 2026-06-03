/**
 * `Host` — the public, developer-facing host configuration builder.
 *
 * A thin, MCP-vocabulary facade over the internal canonicalizer. You build a
 * host, configure its MCP settings + servers, then serialize:
 *
 * ```ts
 * import { Host } from "@mcpjam/sdk";
 *
 * const host = new Host()
 *   .setMcp({
 *     protocolVersion: "2025-11-25",
 *     initialize: { clientInfo: { name: "my-app", version: "1.0" } },
 *     apps: { sandbox: { csp: { mode: "declared" } } },
 *   })
 *   .addServer("srv_abc");
 *
 * const json = host.toJSON();     // normalized public shape (clean vocab)
 * const fp   = await host.hash(); // sha256 fingerprint
 * ```
 *
 * Setters mutate and return `this` for chaining. The public surface is pure
 * MCP vocabulary — `mcp`, `servers`, `protocolVersion`, `clientInfo`. The
 * storage-row vocabulary (`mcpProfile`, `schemaVersion`, the canonicalizer,
 * the hash function) never crosses this boundary: `toJSON()` projects to the
 * public shape, and `hash()` returns an opaque fingerprint.
 *
 * Backend compatibility: the fingerprint is computed over the internal
 * canonical form (which still uses `mcpProfile` on the wire), so it is
 * byte-identical to what the Convex backend derives from the same host
 * (golden-vector parity). That internal form is simply never surfaced.
 */

import { canonicalizeHostConfigV2 } from "./canonicalize.js";
import { computeHostConfigHashV2 } from "./hash.js";
import type {
  CanonicalHostConfigV2,
  HostConfigInputV2,
  HostConfigMcpProfileV1,
} from "./types.js";
import type {
  HostConnectionDefaults,
  HostInit,
  HostJson,
  HostMcp,
  HostServerOverride,
  HostStyleId,
  ServerId,
} from "./public-types.js";

const DEFAULT_STYLE: HostStyleId = "mcpjam";
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;

/** Map the public `HostMcp` (spec vocab) to the internal `mcpProfile`. */
function hostMcpToProfile(mcp: HostMcp): HostConfigMcpProfileV1 {
  const profile: HostConfigMcpProfileV1 = { profileVersion: 1 };
  if (mcp.protocolVersion !== undefined) {
    profile.mcpProtocolVersion = mcp.protocolVersion;
  }
  if (mcp.initialize !== undefined) profile.initialize = mcp.initialize;
  if (mcp.apps !== undefined) profile.apps = mcp.apps;
  if (mcp.extensions !== undefined) profile.extensions = mcp.extensions;
  return profile;
}

/** Map a public per-server override to the internal field names. */
function serverOverrideToInternal(
  override: HostServerOverride,
): NonNullable<HostConfigInputV2["serverConnectionOverrides"]>[string] {
  const out: NonNullable<
    HostConfigInputV2["serverConnectionOverrides"]
  >[string] = {};
  if (override.headers !== undefined) out.headersOverride = override.headers;
  if (override.requestTimeout !== undefined) {
    out.requestTimeoutOverride = override.requestTimeout;
  }
  if (override.protocolVersion !== undefined) {
    out.mcpProtocolVersionOverride = override.protocolVersion;
  }
  return out;
}

function serverOverridesToInternal(
  overrides?: Record<string, HostServerOverride>,
): HostConfigInputV2["serverConnectionOverrides"] {
  if (!overrides) return undefined;
  const out: NonNullable<HostConfigInputV2["serverConnectionOverrides"]> = {};
  for (const [id, override] of Object.entries(overrides)) {
    out[id] = serverOverrideToInternal(override);
  }
  return out;
}

/** Inverse of {@link hostMcpToProfile} — internal `mcpProfile` → public `mcp`. */
function profileToHostMcp(profile: HostConfigMcpProfileV1): HostMcp {
  const mcp: HostMcp = {};
  if (profile.mcpProtocolVersion !== undefined) {
    mcp.protocolVersion = profile.mcpProtocolVersion;
  }
  if (profile.initialize !== undefined) mcp.initialize = profile.initialize;
  if (profile.apps !== undefined) mcp.apps = profile.apps;
  if (profile.extensions !== undefined) mcp.extensions = profile.extensions;
  return mcp;
}

function serverOverridesToPublic(
  overrides: NonNullable<CanonicalHostConfigV2["serverConnectionOverrides"]>,
): Record<string, HostServerOverride> {
  const out: Record<string, HostServerOverride> = {};
  for (const [id, ov] of Object.entries(overrides)) {
    const pub: HostServerOverride = {};
    if (ov.headersOverride !== undefined) pub.headers = ov.headersOverride;
    if (ov.requestTimeoutOverride !== undefined) {
      pub.requestTimeout = ov.requestTimeoutOverride;
    }
    if (ov.mcpProtocolVersionOverride !== undefined) {
      pub.protocolVersion = ov.mcpProtocolVersionOverride;
    }
    out[id] = pub;
  }
  return out;
}

/**
 * Project the internal canonical form (storage-row vocabulary: `mcpProfile`,
 * `serverIds`, `schemaVersion`, …) onto the public `HostJson` (clean MCP
 * vocabulary). No implementation names cross this boundary.
 */
function canonicalToPublic(c: CanonicalHostConfigV2): HostJson {
  const out: HostJson = {
    style: c.hostStyle,
    model: c.modelId,
    systemPrompt: c.systemPrompt,
    temperature: c.temperature,
    requireToolApproval: c.requireToolApproval,
    servers: c.serverIds,
    optionalServers: c.optionalServerIds,
    connectionDefaults: c.connectionDefaults,
    clientCapabilities: c.clientCapabilities,
    hostContext: c.hostContext,
  };
  if (c.progressiveToolDiscovery !== undefined) {
    out.progressiveToolDiscovery = c.progressiveToolDiscovery;
  }
  if (c.respectToolVisibility !== undefined) {
    out.respectToolVisibility = c.respectToolVisibility;
  }
  if (c.hostCapabilitiesOverride !== undefined) {
    out.hostCapabilitiesOverride = c.hostCapabilitiesOverride;
  }
  if (c.chatUiOverride !== undefined) out.chatUiOverride = c.chatUiOverride;
  if (c.mcpProfile !== undefined) out.mcp = profileToHostMcp(c.mcpProfile);
  if (c.serverConnectionOverrides !== undefined) {
    out.serverOverrides = serverOverridesToPublic(c.serverConnectionOverrides);
  }
  return out;
}

export class Host {
  private input: HostConfigInputV2;

  constructor(init: HostInit = {}) {
    this.input = {
      hostStyle: init.style ?? DEFAULT_STYLE,
      modelId: init.model ?? "",
      systemPrompt: init.systemPrompt ?? "",
      temperature: init.temperature ?? DEFAULT_TEMPERATURE,
      requireToolApproval: init.requireToolApproval ?? false,
      connectionDefaults: {
        headers: init.connectionDefaults?.headers ?? {},
        requestTimeout:
          init.connectionDefaults?.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS,
      },
      clientCapabilities: init.clientCapabilities ?? {},
      hostContext: init.hostContext ?? {},
    };
    if (init.progressiveToolDiscovery !== undefined) {
      this.input.progressiveToolDiscovery = init.progressiveToolDiscovery;
    }
    if (init.respectToolVisibility !== undefined) {
      this.input.respectToolVisibility = init.respectToolVisibility;
    }
    if (init.servers !== undefined) this.input.serverIds = [...init.servers];
    if (init.optionalServers !== undefined) {
      this.input.optionalServerIds = [...init.optionalServers];
    }
    if (init.hostCapabilitiesOverride !== undefined) {
      this.input.hostCapabilitiesOverride = init.hostCapabilitiesOverride;
    }
    if (init.chatUiOverride !== undefined) {
      this.input.chatUiOverride = init.chatUiOverride;
    }
    if (init.mcp !== undefined) {
      this.input.mcpProfile = hostMcpToProfile(init.mcp);
    }
    if (init.serverOverrides !== undefined) {
      this.input.serverConnectionOverrides = serverOverridesToInternal(
        init.serverOverrides,
      );
    }
  }

  /** Host style id (pointer into the host registry). */
  setStyle(style: HostStyleId): this {
    this.input.hostStyle = style;
    return this;
  }

  /** LLM model id, e.g. "anthropic/claude-sonnet-4-6". */
  setModel(model: string): this {
    this.input.modelId = model;
    return this;
  }

  setSystemPrompt(systemPrompt: string): this {
    this.input.systemPrompt = systemPrompt;
    return this;
  }

  setTemperature(temperature: number): this {
    this.input.temperature = temperature;
    return this;
  }

  setRequireToolApproval(require = true): this {
    this.input.requireToolApproval = require;
    return this;
  }

  /** Opt into progressive MCP tool discovery (search/load meta-tools). */
  setProgressiveToolDiscovery(enabled: boolean): this {
    this.input.progressiveToolDiscovery = enabled;
    return this;
  }

  /** SEP-1865 `_meta.ui.visibility` filtering. Omit to use the spec default. */
  setRespectToolVisibility(respect: boolean): this {
    this.input.respectToolVisibility = respect;
    return this;
  }

  /** The host's MCP settings (`protocolVersion`, `initialize`, `apps`). */
  setMcp(mcp: HostMcp): this {
    this.input.mcpProfile = hostMcpToProfile(mcp);
    return this;
  }

  /** Add a required server. */
  addServer(id: ServerId): this {
    (this.input.serverIds ??= []).push(id);
    return this;
  }

  /** Add an optional (auto-connect-if-available) server. */
  addOptionalServer(id: ServerId): this {
    (this.input.optionalServerIds ??= []).push(id);
    return this;
  }

  /** Merge connection defaults (headers and/or request timeout). */
  setConnectionDefaults(defaults: Partial<HostConnectionDefaults>): this {
    if (defaults.headers !== undefined) {
      this.input.connectionDefaults.headers = defaults.headers;
    }
    if (defaults.requestTimeout !== undefined) {
      this.input.connectionDefaults.requestTimeout = defaults.requestTimeout;
    }
    return this;
  }

  setClientCapabilities(capabilities: Record<string, unknown>): this {
    this.input.clientCapabilities = capabilities;
    return this;
  }

  setHostContext(context: Record<string, unknown>): this {
    this.input.hostContext = context;
    return this;
  }

  /** Override the MCP-Apps `hostCapabilities` blob. `{}` = advertise nothing. */
  setHostCapabilitiesOverride(override: Record<string, unknown>): this {
    this.input.hostCapabilitiesOverride = override;
    return this;
  }

  setChatUiOverride(override: Record<string, unknown>): this {
    this.input.chatUiOverride = override;
    return this;
  }

  /** Set a per-server connection override (replaces any existing one). */
  addServerOverride(id: ServerId, override: HostServerOverride): this {
    (this.input.serverConnectionOverrides ??= {})[id] =
      serverOverrideToInternal(override);
    return this;
  }

  /**
   * Serialize to the normalized public `HostJson` shape (clean MCP vocabulary
   * — `mcp`, `servers`, `style`; no `mcpProfile`/`schemaVersion`). Normalized
   * and round-trippable: `new Host(host.toJSON())` reproduces an equivalent
   * host with the same `hash()`. Throws if the configuration is invalid (e.g.
   * a non-finite temperature or a malformed MCP profile).
   */
  toJSON(): HostJson {
    return canonicalToPublic(canonicalizeHostConfigV2(this.input));
  }

  /**
   * sha256 fingerprint — the host's content address. Computed over the
   * internal canonical form (kept stable for backend compatibility), so it is
   * identical to the value the Convex backend derives from the same host.
   */
  async hash(): Promise<string> {
    return computeHostConfigHashV2(this.input);
  }
}

export type {
  HostInit,
  HostJson,
  HostMcp,
  HostServerOverride,
  HostConnectionDefaults,
  HostStyleId,
  McpProtocolVersion,
  ServerId,
} from "./public-types.js";

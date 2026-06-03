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
 * const json = host.toJSON(); // normalized public shape (clean vocab)
 * ```
 *
 * Setters mutate and return `this` for chaining. The public surface is pure
 * MCP vocabulary — `mcp`, `servers`, `protocolVersion`, `clientInfo`. The
 * storage-row vocabulary (`mcpProfile`, `schemaVersion`, the canonicalizer)
 * never crosses this boundary: `toJSON()` projects to the public shape.
 *
 * Content-addressed storage (canonical-form hashing for backend dedupe) is a
 * first-party concern handled at the SDK↔backend boundary via
 * `@mcpjam/sdk/host-config/internal`. Developers building hosts never call it.
 */

import { canonicalizeHostConfigV2 } from "./canonicalize.js";
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

// No default `style` or `model` — both are required to produce a valid host
// and must be supplied by the caller (constructor `init` or `setStyle()` /
// `setModel()`). The SDK deliberately refuses to pick a product-style default
// here: an external agent author who forgets `style` should fail loudly, not
// silently get MCPJam chrome on a Claude-style flow.
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
    // Defensive deep copy: a Host must be deterministic, so a caller mutating
    // the objects they passed in (mcp / capabilities / headers / overrides)
    // must not retroactively change this host's toJSON()/hash(). Arrays were
    // already copied; this snapshots the object-valued inputs too.
    // structuredClone is available across the SDK's targets (browser, Node >=
    // 20, Convex isolate).
    const cfg = structuredClone(init);
    this.input = {
      // `style` and `model` are required for a valid host but kept optional in
      // `HostInit` so the setter pattern (`new Host().setStyle(...).setModel(...)`)
      // works. Empty-string sentinels are caught by `requireConfigured()` at
      // `toJSON()` / `hash()` time with a clear error message.
      hostStyle: cfg.style ?? "",
      modelId: cfg.model ?? "",
      systemPrompt: cfg.systemPrompt ?? "",
      temperature: cfg.temperature ?? DEFAULT_TEMPERATURE,
      requireToolApproval: cfg.requireToolApproval ?? false,
      connectionDefaults: {
        headers: cfg.connectionDefaults?.headers ?? {},
        requestTimeout:
          cfg.connectionDefaults?.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS,
      },
      clientCapabilities: cfg.clientCapabilities ?? {},
      hostContext: cfg.hostContext ?? {},
    };
    if (cfg.progressiveToolDiscovery !== undefined) {
      this.input.progressiveToolDiscovery = cfg.progressiveToolDiscovery;
    }
    if (cfg.respectToolVisibility !== undefined) {
      this.input.respectToolVisibility = cfg.respectToolVisibility;
    }
    if (cfg.servers !== undefined) this.input.serverIds = [...cfg.servers];
    if (cfg.optionalServers !== undefined) {
      this.input.optionalServerIds = [...cfg.optionalServers];
    }
    if (cfg.hostCapabilitiesOverride !== undefined) {
      this.input.hostCapabilitiesOverride = cfg.hostCapabilitiesOverride;
    }
    if (cfg.chatUiOverride !== undefined) {
      this.input.chatUiOverride = cfg.chatUiOverride;
    }
    if (cfg.mcp !== undefined) {
      this.input.mcpProfile = hostMcpToProfile(cfg.mcp);
    }
    if (cfg.serverOverrides !== undefined) {
      this.input.serverConnectionOverrides = serverOverridesToInternal(
        cfg.serverOverrides,
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
    this.input.mcpProfile = hostMcpToProfile(structuredClone(mcp));
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
      this.input.connectionDefaults.headers = structuredClone(defaults.headers);
    }
    if (defaults.requestTimeout !== undefined) {
      this.input.connectionDefaults.requestTimeout = defaults.requestTimeout;
    }
    return this;
  }

  setClientCapabilities(capabilities: Record<string, unknown>): this {
    this.input.clientCapabilities = structuredClone(capabilities);
    return this;
  }

  setHostContext(context: Record<string, unknown>): this {
    this.input.hostContext = structuredClone(context);
    return this;
  }

  /** Override the MCP-Apps `hostCapabilities` blob. `{}` = advertise nothing. */
  setHostCapabilitiesOverride(override: Record<string, unknown>): this {
    this.input.hostCapabilitiesOverride = structuredClone(override);
    return this;
  }

  setChatUiOverride(override: Record<string, unknown>): this {
    this.input.chatUiOverride = structuredClone(override);
    return this;
  }

  /** Set a per-server connection override (replaces any existing one). */
  addServerOverride(id: ServerId, override: HostServerOverride): this {
    (this.input.serverConnectionOverrides ??= {})[id] =
      serverOverrideToInternal(structuredClone(override));
    return this;
  }

  /**
   * Throw a clear error if required fields (`style`, `model`) are still empty.
   * Called from `toJSON()` so the failure lands at the moment of use, not deep
   * inside the canonicalizer with a less obvious message.
   */
  private requireConfigured(): void {
    if (!this.input.hostStyle) {
      throw new Error(
        "Host requires a `style` (e.g. \"mcpjam\", \"claude\", \"chatgpt\"). " +
          "Pass it to the constructor (`new Host({ style: \"...\" })`) or call `.setStyle(...)`.",
      );
    }
    if (!this.input.modelId) {
      throw new Error(
        "Host requires a `model` (e.g. \"anthropic/claude-sonnet-4-6\"). " +
          "Pass it to the constructor (`new Host({ model: \"...\" })`) or call `.setModel(...)`.",
      );
    }
  }

  /**
   * Serialize to the normalized public `HostJson` shape (clean MCP vocabulary
   * — `mcp`, `servers`, `style`; no `mcpProfile`/`schemaVersion`). Normalized
   * and round-trippable: `new Host(host.toJSON())` reproduces an equivalent
   * host. Throws if the configuration is invalid (e.g. `style`/`model` not
   * set, a non-finite temperature, or a malformed MCP profile).
   */
  toJSON(): HostJson {
    this.requireConfigured();
    return canonicalToPublic(canonicalizeHostConfigV2(this.input));
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

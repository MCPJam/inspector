/**
 * `Host` — the public, developer-facing host configuration builder.
 *
 * A thin, MCP-vocabulary facade over the internal canonicalizer. Configure a
 * host by mutating its public properties directly, then serialize:
 *
 * ```ts
 * import { Host } from "@mcpjam/sdk";
 *
 * const host = new Host({ style: "mcpjam", model: "anthropic/claude-sonnet-4-6" });
 * host.mcp.protocolVersion = "2025-11-25";
 * host.mcp.initialize = { clientInfo: { name: "my-app", version: "1.0" } };
 * host.mcp.apps = { sandbox: { csp: { mode: "declared" } } };
 * host.addServer("srv_abc");
 *
 * const json = host.toJSON(); // normalized public shape (clean vocab)
 * ```
 *
 * Public fields are mutable and use MCP vocabulary — `mcp`, `servers`,
 * `clientCapabilities`, … The storage-row vocabulary (`mcpProfile`,
 * `schemaVersion`, the canonicalizer) never crosses this boundary: input is
 * snapshotted at `toJSON()` time and projected through the canonicalizer to
 * the public shape.
 *
 * Convenience methods (`addServer`, `setServerOverride`, `clearMcp`, …) are
 * provided where they read more naturally than raw property mutation and
 * where enforcing invariants (e.g. server-id dedup) is helpful. All methods
 * return `this` for chaining.
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
// and must be supplied by the caller (constructor `init` or by assigning to
// `host.style` / `host.model`). The SDK deliberately refuses to pick a
// product-style default here: an external agent author who forgets `style`
// should fail loudly, not silently get MCPJam chrome on a Claude-style flow.
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

/**
 * True if every top-level `HostMcp` field is unset. Used to collapse the
 * always-defined-but-untouched `host.mcp = {}` default to no `mcpProfile` in
 * canonical, so a freshly-constructed host hashes identically to one that
 * never touched `mcp`. Sub-object emptiness (e.g. `host.mcp.apps = {}`) is
 * NOT collapsed here — the canonicalizer drops empty sub-blocks on its own,
 * but the wrapper profile still appears.
 */
function isEmptyHostMcp(mcp: HostMcp | undefined): boolean {
  if (mcp === undefined) return true;
  return (
    mcp.protocolVersion === undefined &&
    mcp.initialize === undefined &&
    mcp.apps === undefined &&
    mcp.extensions === undefined
  );
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
  overrides: Record<string, HostServerOverride>,
): HostConfigInputV2["serverConnectionOverrides"] {
  if (Object.keys(overrides).length === 0) return undefined;
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

/** Append `id` to `list` if not already present. */
function pushUnique<T>(list: T[], id: T): void {
  if (!list.includes(id)) list.push(id);
}

/** Remove first occurrence of `id` from `list`. */
function removeFrom<T>(list: T[], id: T): void {
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1);
}

/** Order-preserving dedup. */
function dedup<T>(arr: readonly T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const v of arr) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

export class Host {
  /**
   * Host style id (e.g. "mcpjam", "claude", "chatgpt"). **Required** at
   * `toJSON()` time — there is no SDK default, so an external agent author
   * who forgets to set it gets a loud error rather than silently inheriting
   * MCPJam product chrome on a Claude-style flow.
   *
   * Note: `style` is a **product knob**, not part of SEP-1865 / the MCP base
   * spec. It selects which host-style preset (chrome, default capabilities,
   * compat-runtime shims) the inspector applies.
   */
  style: HostStyleId;

  /**
   * LLM model id, e.g. `"anthropic/claude-sonnet-4-6"`. **Required** at
   * `toJSON()` time — no SDK default.
   */
  model: string;

  systemPrompt: string;
  temperature: number;
  requireToolApproval: boolean;

  /** Opt into progressive MCP tool discovery (search/load meta-tools). */
  progressiveToolDiscovery?: boolean;

  /**
   * SEP-1865 `_meta.ui.visibility` filtering. `undefined` → spec default
   * (filter); explicit `false` → show every tool (for hosts that don't
   * implement visibility).
   */
  respectToolVisibility?: boolean;

  /** Required servers. Mutable — `addServer`/`removeServer` are sugar. */
  servers: ServerId[];

  /** Optional (auto-connect-if-available) servers. */
  optionalServers: ServerId[];

  connectionDefaults: HostConnectionDefaults;

  /**
   * MCP `ClientCapabilities` the inspector advertises in `initialize`.
   * Untyped (`Record<string, unknown>`) so future spec additions and host
   * extensions (SEP-1724) can be added without an SDK release. The MCP Apps
   * extension lives at `clientCapabilities.extensions["io.modelcontextprotocol/ui"]`.
   */
  clientCapabilities: Record<string, unknown>;

  /** SEP-1865 `HostContext` (theme, displayMode, …) advertised via `ui/initialize`. */
  hostContext: Record<string, unknown>;

  /**
   * Override the SEP-1865 MCP-Apps `hostCapabilities` blob the inspector
   * advertises in `ui/initialize`.
   *
   * Semantics: `undefined` = "use the host-style preset" (the inspector
   * picks a sensible default per style). `{}` = "advertise nothing"
   * (distinct from `undefined`; hashes distinctly). Use this to *cap* what
   * a host advertises — e.g. force `serverTools: undefined` to block widget
   * → server tool proxying for a hardened host.
   */
  hostCapabilitiesOverride?: Record<string, unknown>;

  /** Override the chat-UI surface (logo, fonts, …). `undefined` vs `{}` semantics match `hostCapabilitiesOverride`. */
  chatUiOverride?: Record<string, unknown>;

  /**
   * The host's MCP settings.
   *
   * Spec-aligned shape (`protocolVersion`, `initialize`, `apps`, `extensions`)
   * is **mutable in place** — assign or mutate any leaf directly:
   *
   * ```ts
   * host.mcp.protocolVersion = "2025-11-25";
   * host.mcp.initialize = { clientInfo: { name: "my-app", version: "1.0" } };
   * host.mcp.apps = { sandbox: { csp: { mode: "declared" } } };
   * ```
   *
   * The SEP-1865 sandbox knobs at `mcp.apps.sandbox.csp` / `.permissions` are
   * **host enforcement caps**, not capability grants to the widget. The
   * widget *declares* what it needs via its resource metadata; the host MAY
   * further restrict but MUST NOT loosen (`restrictTo` intersects the
   * declared set; `mode: "declared"` honors the declared set as-is).
   *
   * A "freshly constructed, untouched" `host.mcp` (all fields undefined)
   * collapses to no `mcpProfile` in canonical, so it hashes identically to
   * `host.mcp = undefined`.
   */
  mcp: HostMcp;

  /** Per-server connection overrides keyed by server id. */
  serverOverrides: Record<string, HostServerOverride>;

  constructor(init: HostInit = {}) {
    // Defensive deep copy: a Host must be deterministic, so a caller mutating
    // the objects they passed in (mcp / capabilities / headers / overrides)
    // must not retroactively change this host's toJSON(). `structuredClone`
    // is available across the SDK's targets (browser, Node >= 20, Convex).
    const cfg = structuredClone(init);

    // `style` and `model` are kept type-optional so users can construct an
    // empty Host and configure it imperatively. Empty-string sentinels are
    // caught by `requireConfigured()` at `toJSON()` time with a clear error.
    this.style = cfg.style ?? "";
    this.model = cfg.model ?? "";

    this.systemPrompt = cfg.systemPrompt ?? "";
    this.temperature = cfg.temperature ?? DEFAULT_TEMPERATURE;
    this.requireToolApproval = cfg.requireToolApproval ?? false;
    this.progressiveToolDiscovery = cfg.progressiveToolDiscovery;
    this.respectToolVisibility = cfg.respectToolVisibility;
    this.servers = cfg.servers ? dedup(cfg.servers) : [];
    this.optionalServers = cfg.optionalServers
      ? dedup(cfg.optionalServers)
      : [];
    this.connectionDefaults = {
      headers: cfg.connectionDefaults?.headers ?? {},
      requestTimeout:
        cfg.connectionDefaults?.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS,
    };
    this.clientCapabilities = cfg.clientCapabilities ?? {};
    this.hostContext = cfg.hostContext ?? {};
    this.hostCapabilitiesOverride = cfg.hostCapabilitiesOverride;
    this.chatUiOverride = cfg.chatUiOverride;
    this.mcp = cfg.mcp ?? {};
    this.serverOverrides = cfg.serverOverrides ?? {};
  }

  // ── Setters kept as fluent-chain conveniences. Direct property assignment
  //    is equivalent (`host.style = "..."`); both are supported. ────────────

  setStyle(style: HostStyleId): this {
    this.style = style;
    return this;
  }

  setModel(model: string): this {
    this.model = model;
    return this;
  }

  setSystemPrompt(systemPrompt: string): this {
    this.systemPrompt = systemPrompt;
    return this;
  }

  setTemperature(temperature: number): this {
    this.temperature = temperature;
    return this;
  }

  setRequireToolApproval(require = true): this {
    this.requireToolApproval = require;
    return this;
  }

  setProgressiveToolDiscovery(enabled: boolean): this {
    this.progressiveToolDiscovery = enabled;
    return this;
  }

  setRespectToolVisibility(respect: boolean): this {
    this.respectToolVisibility = respect;
    return this;
  }

  // ── Server list mutations (deduped). ──────────────────────────────────────

  /** Append a required server; no-op if `id` is already in the list. */
  addServer(id: ServerId): this {
    pushUnique(this.servers, id);
    return this;
  }

  /** Remove a required server; no-op if absent. */
  removeServer(id: ServerId): this {
    removeFrom(this.servers, id);
    return this;
  }

  /** Append an optional (auto-connect-if-available) server; deduped. */
  addOptionalServer(id: ServerId): this {
    pushUnique(this.optionalServers, id);
    return this;
  }

  removeOptionalServer(id: ServerId): this {
    removeFrom(this.optionalServers, id);
    return this;
  }

  // ── Per-server connection overrides. ──────────────────────────────────────

  /**
   * Replace the per-server override for `id`. Passing an empty `{}` is
   * preserved here but stripped from the canonical output (an override with
   * no fields adds no information).
   */
  setServerOverride(id: ServerId, override: HostServerOverride): this {
    this.serverOverrides[id] = structuredClone(override);
    return this;
  }

  removeServerOverride(id: ServerId): this {
    delete this.serverOverrides[id];
    return this;
  }

  // ── MCP block. ────────────────────────────────────────────────────────────

  /**
   * Reset `mcp` to an empty object — equivalent to "use SDK defaults / no
   * host-level MCP profile." Collapses to no `mcpProfile` in canonical.
   */
  clearMcp(): this {
    this.mcp = {};
    return this;
  }

  // ── Output. ───────────────────────────────────────────────────────────────

  /**
   * Throw a clear error if required fields (`style`, `model`) are still empty.
   * Called from `toJSON()` so the failure lands at the moment of use, not
   * deep inside the canonicalizer with a less obvious message.
   */
  private requireConfigured(): void {
    if (!this.style) {
      throw new Error(
        "Host requires a `style` (e.g. \"mcpjam\", \"claude\", \"chatgpt\"). " +
          'Pass it to the constructor (`new Host({ style: "..." })`) or assign `host.style = "..."`.',
      );
    }
    if (!this.model) {
      throw new Error(
        "Host requires a `model` (e.g. \"anthropic/claude-sonnet-4-6\"). " +
          'Pass it to the constructor (`new Host({ model: "..." })`) or assign `host.model = "..."`.',
      );
    }
  }

  /**
   * Build the internal canonicalizer input from the current public-shape
   * properties. Snapshotted (`structuredClone`) so the canonicalizer sees a
   * stable copy even if the caller is mid-mutation.
   */
  private toInternalInput(): HostConfigInputV2 {
    const snap = structuredClone({
      style: this.style,
      model: this.model,
      systemPrompt: this.systemPrompt,
      temperature: this.temperature,
      requireToolApproval: this.requireToolApproval,
      progressiveToolDiscovery: this.progressiveToolDiscovery,
      respectToolVisibility: this.respectToolVisibility,
      servers: this.servers,
      optionalServers: this.optionalServers,
      connectionDefaults: this.connectionDefaults,
      clientCapabilities: this.clientCapabilities,
      hostContext: this.hostContext,
      hostCapabilitiesOverride: this.hostCapabilitiesOverride,
      chatUiOverride: this.chatUiOverride,
      mcp: this.mcp,
      serverOverrides: this.serverOverrides,
    });

    const input: HostConfigInputV2 = {
      hostStyle: snap.style,
      modelId: snap.model,
      systemPrompt: snap.systemPrompt,
      temperature: snap.temperature,
      requireToolApproval: snap.requireToolApproval,
      serverIds: snap.servers,
      optionalServerIds: snap.optionalServers,
      connectionDefaults: snap.connectionDefaults,
      clientCapabilities: snap.clientCapabilities,
      hostContext: snap.hostContext,
    };
    if (snap.progressiveToolDiscovery !== undefined) {
      input.progressiveToolDiscovery = snap.progressiveToolDiscovery;
    }
    if (snap.respectToolVisibility !== undefined) {
      input.respectToolVisibility = snap.respectToolVisibility;
    }
    if (snap.hostCapabilitiesOverride !== undefined) {
      input.hostCapabilitiesOverride = snap.hostCapabilitiesOverride;
    }
    if (snap.chatUiOverride !== undefined) {
      input.chatUiOverride = snap.chatUiOverride;
    }
    // Collapse "empty mcp": an untouched `host.mcp = {}` (the default after
    // construction) maps to no `mcpProfile`, matching an explicitly cleared
    // profile.
    if (!isEmptyHostMcp(snap.mcp)) {
      input.mcpProfile = hostMcpToProfile(snap.mcp);
    }
    const overrides = serverOverridesToInternal(snap.serverOverrides);
    if (overrides !== undefined) input.serverConnectionOverrides = overrides;
    return input;
  }

  /**
   * Serialize to the normalized public `HostJson` shape (clean MCP
   * vocabulary — `mcp`, `servers`, `style`; no `mcpProfile`/`schemaVersion`).
   * Normalized and round-trippable: `new Host(host.toJSON())` reproduces an
   * equivalent host. Throws if the configuration is invalid (e.g.
   * `style`/`model` not set, a non-finite temperature, or a malformed MCP
   * profile).
   */
  toJSON(): HostJson {
    this.requireConfigured();
    return canonicalToPublic(canonicalizeHostConfigV2(this.toInternalInput()));
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

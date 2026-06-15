/**
 * `@mcpjam/sdk/host-config` — PUBLIC type surface.
 *
 * MCP-protocol vocabulary for the developer-facing `Host` API. These names are
 * what an external agent author sees; the internal storage-row vocabulary
 * (`HostConfigInputV2`, `mcpProfile`, schema versions) stays in `./types.ts`
 * and `./canonicalize.ts` and is reached only through `Host`.
 *
 * Wire compatibility (option b): the internal canonical shape keeps the
 * on-disk field name `mcpProfile`, but `HostJson` deliberately exposes public
 * vocabulary (`mcp`). A small mapper in `./host.ts` bridges the two so the
 * storage-row canonical JSON + hash stay stable.
 */

import type {
  CspDomainSet,
  HostConfigComputer,
  HostConfigComputerInput,
  HostConfigConnectionDefaults,
  HostConfigMcpProfileV1,
  HostEngine,
  HostStyleId,
  McpAppsCapabilities,
  McpProtocolVersion,
  OpenAiAppsCapabilities,
  ServerId,
} from "./types.js";

export type {
  McpProtocolVersion,
  ServerId,
  HostStyleId,
  HostEngine,
  CspDomainSet,
  OpenAiAppsCapabilities,
  McpAppsCapabilities,
};

/**
 * Personal cloud workstation attached to a host — one machine per
 * (project, user). This is the RESOURCE attachment only; the capabilities
 * the model gets on it (e.g. `bash`) are granted via `builtInToolIds`.
 * `{ kind: "personal" }` is the only shape in MVP.
 */
export type HostComputer = HostConfigComputer;

/**
 * Input-tolerant computer shape for the Host builder / JSON snapshots: the
 * legacy `toolset` key is accepted (and dropped by the canonicalizer) so
 * pre-existing programmatic callers keep compiling. New code should write
 * `{ kind: "personal" }` and grant capabilities via `builtInToolIds`.
 */
export type HostComputerInput = HostConfigComputerInput;

/** Per-host connection defaults (headers + request timeout in ms). */
export type HostConnectionDefaults = HostConfigConnectionDefaults;

/**
 * A host's MCP settings — the host-facing rename of the internal `mcpProfile`.
 * Spec-aligned vocabulary: `protocolVersion`, `initialize` (clientInfo,
 * supported versions), and `apps` (sandbox, ui/initialize hostInfo, compat
 * runtime, MCP-Apps overrides). The internal schema-version marker
 * (`profileVersion`) is supplied by the SDK; authors never set it.
 */
export type HostMcp = Omit<
  HostConfigMcpProfileV1,
  "profileVersion" | "mcpProtocolVersion"
> & {
  /** Host-default pinned MCP protocol version (e.g. "2025-11-25"). */
  protocolVersion?: McpProtocolVersion;
};

/**
 * The normalized host configuration returned by `Host.toJSON()`.
 *
 * Pure public vocabulary — no implementation names leak here: `mcp` (not
 * `mcpProfile`), `style`/`model`/`servers`, and no `schemaVersion`/
 * `profileVersion` markers. It is normalized (sorted, deduped, derived) and
 * round-trips: `new Host(host.toJSON())` reproduces an equivalent host. The
 * internal content-addressed wire form (which the backend stores) is
 * deliberately not exposed.
 */
export interface HostJson {
  style: HostStyleId;
  model: string;
  systemPrompt: string;
  temperature: number;
  requireToolApproval: boolean;
  progressiveToolDiscovery?: boolean;
  respectToolVisibility?: boolean;
  /** Personal computer attached to this host; absent ⇒ none. Normalized:
   * `null` input never survives to `HostJson`. */
  computer?: HostComputer;
  /** Execution engine; absent ⇒ emulated. `"harness:claude-code"` runs the
   * turn in a real Claude Code runtime (requires an attached `computer`). */
  engine?: HostEngine;
  servers: ServerId[];
  optionalServers: ServerId[];
  connectionDefaults: HostConnectionDefaults;
  clientCapabilities: Record<string, unknown>;
  hostContext: Record<string, unknown>;
  hostCapabilitiesOverride?: Record<string, unknown>;
  chatUiOverride?: Record<string, unknown>;
  mcp?: HostMcp;
  serverOverrides?: Record<string, HostServerOverride>;
}

/** Per-server connection override (host-facing field names). */
export interface HostServerOverride {
  headers?: Record<string, string>;
  requestTimeout?: number;
  protocolVersion?: McpProtocolVersion;
}

/**
 * Optional initial configuration for `new Host(init?)`. Every field is
 * type-optional so the imperative pattern works (`new Host(); host.style =
 * "..."; host.model = "..."`), but `style` and `model` are **required at
 * use** — `toJSON()` throws if either is missing. The SDK deliberately ships
 * no default `style` (so an external author isn't silently opted into MCPJam
 * product chrome) and no default `model`. After construction every field is
 * also accessible as a mutable property on the `Host` instance (e.g.
 * `host.mcp.protocolVersion = "..."`, `host.servers.push(...)`).
 */
export interface HostInit {
  /**
   * Host style id (e.g. "mcpjam", "claude", "chatgpt"). Required at
   * `toJSON()`; no SDK default. **Product knob, not SEP-1865** — selects
   * which host-style preset (chrome, capability defaults, compat-runtime
   * shims) the inspector applies.
   */
  style?: HostStyleId;
  /** LLM model id (e.g. "anthropic/claude-sonnet-4-6"). Required at `toJSON()`; no SDK default. */
  model?: string;
  systemPrompt?: string;
  /** Sampling temperature. Default: 0.7. */
  temperature?: number;
  requireToolApproval?: boolean;
  /** Opt into progressive MCP tool discovery (search/load meta-tools). */
  progressiveToolDiscovery?: boolean;
  /** SEP-1865 `_meta.ui.visibility` filtering. Undefined → spec default. */
  respectToolVisibility?: boolean;
  /**
   * Attach a personal cloud workstation (chat `bash` tool + web terminal).
   * Absent or `null` ⇒ no computer; `null` is accepted so an editor can
   * clear the field and is normalized away at `toJSON()`.
   */
  computer?: HostComputer | null;
  /**
   * Execution engine; absent ⇒ emulated (MCPJam's own loop). Set to
   * `"harness:claude-code"` to run the turn inside a real Claude Code runtime
   * via the AI SDK harness. The harness runs in the host's attached
   * `computer` (E2B), so a computer is required when this is set.
   */
  engine?: HostEngine;
  /** Required servers this host connects to. */
  servers?: ServerId[];
  /** Optional (auto-connect-if-available) servers. */
  optionalServers?: ServerId[];
  connectionDefaults?: Partial<HostConnectionDefaults>;
  clientCapabilities?: Record<string, unknown>;
  hostContext?: Record<string, unknown>;
  /**
   * Override the SEP-1865 MCP-Apps `hostCapabilities` blob advertised in
   * `ui/initialize`. `undefined` = use the host-style preset; `{}` =
   * advertise nothing (hashes distinctly from `undefined`). Used to *cap*
   * what a host advertises (e.g. drop `serverTools` to block widget→server
   * tool proxying), never to grant capabilities the preset doesn't already
   * support.
   */
  hostCapabilitiesOverride?: Record<string, unknown>;
  /** Override the chat-UI surface (logo, fonts, …). */
  chatUiOverride?: Record<string, unknown>;
  /** The host's MCP settings. */
  mcp?: HostMcp;
  /** Per-server connection overrides, keyed by server id. */
  serverOverrides?: Record<string, HostServerOverride>;
}

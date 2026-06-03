/**
 * `@mcpjam/sdk/host-config` — PUBLIC type surface.
 *
 * MCP-protocol vocabulary for the developer-facing `Host` API. These names are
 * what an external agent author sees; the internal storage-row vocabulary
 * (`HostConfigInputV2`, `mcpProfile`, schema versions) stays in `./types.ts`
 * and `./canonicalize.ts` and is reached only through `Host`.
 *
 * Wire compatibility (option b): the *serialized* canonical shape
 * (`HostJson`) keeps the on-disk field name `mcpProfile`; only the fluent API
 * renames it to `mcp`. A small mapper in `./host.ts` bridges the two so the
 * canonical JSON + hash never change (the golden-vector fixture still holds).
 */

import type {
  CspDomainSet,
  HostConfigConnectionDefaults,
  HostConfigMcpProfileV1,
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
  CspDomainSet,
  OpenAiAppsCapabilities,
  McpAppsCapabilities,
};

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
 * type-optional so the setter pattern works
 * (`new Host().setStyle(...).setModel(...)`), but `style` and `model` are
 * **required at use** — `toJSON()` throws if either is missing. The SDK
 * deliberately ships no default `style` (so an external author isn't silently
 * opted into MCPJam product chrome) and no default `model`. Equivalent
 * settings are available as fluent setters (`setStyle`, `setModel`, `setMcp`,
 * `addServer`, …).
 */
export interface HostInit {
  /** Host style id (e.g. "mcpjam", "claude", "chatgpt"). Required at `toJSON()`; no SDK default. */
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
  /** Required servers this host connects to. */
  servers?: ServerId[];
  /** Optional (auto-connect-if-available) servers. */
  optionalServers?: ServerId[];
  connectionDefaults?: Partial<HostConnectionDefaults>;
  clientCapabilities?: Record<string, unknown>;
  hostContext?: Record<string, unknown>;
  /** Override the MCP-Apps `hostCapabilities` blob. {} = advertise nothing. */
  hostCapabilitiesOverride?: Record<string, unknown>;
  /** Override the chat-UI surface (logo, fonts, …). */
  chatUiOverride?: Record<string, unknown>;
  /** The host's MCP settings. */
  mcp?: HostMcp;
  /** Per-server connection overrides, keyed by server id. */
  serverOverrides?: Record<string, HostServerOverride>;
}

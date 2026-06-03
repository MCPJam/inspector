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
  CanonicalHostConfigV2,
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
 * Normalized, content-addressable host JSON returned by `Host.toJSON()`.
 *
 * NOTE: this is the *serialized* shape that gets hashed and stored, so it
 * keeps the on-disk field name `mcpProfile` (not `mcp`) for backend
 * compatibility — see the option-(b) note above. Use the `Host` fluent API
 * (`host.mcp` / `setMcp`) for authoring; use `toJSON()` only when you need the
 * exact wire form.
 */
export type HostJson = CanonicalHostConfigV2;

/** Per-server connection override (host-facing field names). */
export interface HostServerOverride {
  headers?: Record<string, string>;
  requestTimeout?: number;
  protocolVersion?: McpProtocolVersion;
}

/**
 * Optional initial configuration for `new Host(init?)`. Every field is
 * optional; omitted fields fall back to SDK defaults. Equivalent settings are
 * also available as fluent setters (`setModel`, `setMcp`, `addServer`, …).
 */
export interface HostInit {
  /** Host style id — a pointer into the host registry. Default: "mcpjam". */
  style?: HostStyleId;
  /** LLM model id (e.g. "anthropic/claude-sonnet-4-6"). */
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

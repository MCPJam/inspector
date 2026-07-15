/**
 * HostConfig v2 — portable type surface.
 *
 * SOURCE OF TRUTH. This module is the canonical home of the host-config
 * shape, canonicalizer, and hash. It is hand-mirrored (NOT imported) by the
 * Convex backend in `convex/lib/hostConfigV2.ts`, because Convex's isolate
 * bundling forbids importing `@mcpjam/sdk` (Node-only deps). Drift between
 * the two implementations is caught by a golden-vector parity test that runs
 * identical inputs through both canonicalizers and asserts byte-identical
 * canonical JSON + sha256 (see `sdk/tests/host-config-parity.test.ts` and
 * `mcpjam-backend/tests/convex/hostConfigV2Parity.test.ts`). When you change
 * a type or canonicalization rule here, update the backend mirror in the
 * same change set and regenerate both fixture copies.
 *
 * Pure + browser-safe: no `convex/values`, no `ctx.db`, no Node-only APIs.
 */

import type { McpProtocolVersion } from "../mcp-client-manager/mcp-protocol-version.js";

export type { McpProtocolVersion };

/**
 * Identifier of a host-config host style. Storage is a free-form string —
 * the canonical "what's a registered host" check lives in the inspector
 * client's `lib/host-styles` registry, not here. Treated as an opaque
 * pointer into that registry so users can register custom hosts (BYO)
 * without a backend deploy.
 */
export type HostConfigStyle = string;

/**
 * Public alias of {@link HostConfigStyle}. **Intentionally `string`**, not a
 * closed union — the host registry is extensible (users can register custom
 * host styles via the client's `lib/host-styles` registry without an SDK or
 * backend deploy). Don't "tighten" this to `'mcpjam' | 'claude' | 'chatgpt'`;
 * it would break BYO hosts.
 */
export type HostStyleId = HostConfigStyle;

/**
 * Opaque MCP server identifier. The backend brands this as `Id<'servers'>`;
 * the portable core treats it as a plain string because the canonicalizer
 * only sorts/dedupes serverIds — it never dereferences them.
 */
export type ServerId = string;

export const HOST_CONFIG_SCHEMA_VERSION_V2 = 2;

/**
 * Every harness id the persistence layer accepts. This is the portable
 * **persistence-contract source of truth**: the inspector's server registry and
 * the backend's hand-mirrored validator each assert parity with this list (so the
 * copies can't silently drift), and the canonicalizer rejects anything not in it.
 * Adding a runtime is a one-line addition here + a registry adapter + tests —
 * never a schema migration (absent ⇒ emulated still hashes byte-identically).
 */
export const HARNESS_IDS = ["claude-code", "codex"] as const;

/**
 * Which real agent **harness** runs a host's turn. Absent ⇒ the MCPJam
 * **emulated** loop — the only historical behavior, so pre-feature rows hash
 * byte-identically (the key is simply never written). `"claude-code"` runs the
 * turn inside a real Claude Code runtime via the AI SDK harness; `"codex"` runs
 * OpenAI Codex. Extensible to additional runtimes (e.g. `"pi"`) later without a
 * schema migration.
 */
export type Harness = (typeof HARNESS_IDS)[number];

/** Type guard — the single membership check every layer routes through. */
export function isHarness(value: unknown): value is Harness {
  return (
    typeof value === "string" &&
    (HARNESS_IDS as readonly string[]).includes(value)
  );
}

export type McpToolResultImageRenderPlacement = "none" | "collapsed" | "inline";

export type McpToolResultImageRenderingPolicy = {
  placement?: McpToolResultImageRenderPlacement;
  directContent?: {
    image?: boolean;
  };
  embeddedResources?: {
    blob?: {
      image?: boolean;
    };
  };
  linkedResources?: {
    blob?: {
      image?: boolean;
    };
  };
};

export type McpToolResultImageRendering = McpToolResultImageRenderingPolicy;

/**
 * Permissions Policy feature tokens corresponding to the four
 * SEP-1865 spec permissions. These are the KEBAB-CASE browser tokens
 * (as they appear in iframe `allow=` attributes), NOT the camelCase
 * mcpProfile.permissions.allow keys. The canonicalizer uses this list to
 * drop these features from `allowFeatures` (they belong in
 * `permissions.allow`).
 *
 * Naming gap (intentional): `permissions.allow.clipboardWrite` (camel,
 * spec field name) ↔ `allowFeatures["clipboard-write"]` (kebab,
 * Permissions Policy token). Do NOT normalize casing on either side.
 */
export const SEP_1865_PERMISSION_FEATURES = [
  "camera",
  "microphone",
  "geolocation",
  "clipboard-write",
] as const;

export type HostConfigConnectionDefaults = {
  headers: Record<string, string>;
  requestTimeout: number;
};

// A CSP "domain set" — four parallel allowlists keyed by CSP directive
// family (SEP-1865 is allowlist-only; there's no deny concept). Canonicalized
// as a set (trimmed, deduped, sorted) so policies that differ only in array
// order hash identically.
export type CspDomainSet = {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
};

// Versioned envelope for host-level MCP state. Designed so the MCP spec
// can evolve under `extensions` or a future `profileVersion: 2` without
// adding new columns. The backend stores intent; the inspector SDK enforces
// sandbox policy when it builds the proxy CSP. Domain syntax is intentionally
// NOT validated here — that's a UI/SDK concern.
export type HostConfigMcpProfileV1 = {
  profileVersion: 1;
  // Host-default pinned MCP protocol version. Absent → SDK chooses at
  // request time. Per-server pins live on serverConnectionOverrides.
  mcpProtocolVersion?: McpProtocolVersion;
  initialize?: {
    // Order is semantic. The first entry is sent in
    // `initialize.params.protocolVersion`; all entries form the
    // accept-list. A single-item array pins a reproducible version.
    supportedProtocolVersions?: string[];
    // Stored as the exact `initialize.clientInfo` object the SDK should
    // send. Soft-validated (name & version required when set); everything
    // else passes through verbatim so future spec additions land here
    // without a schema migration.
    clientInfo?: Record<string, unknown>;
  };
  apps?: {
    sandbox?: {
      csp?: {
        mode?: "host-default" | "declared" | "relaxed";
        // Intersection — never adds undeclared domains. Per SEP-1865:
        // host MAY further restrict but MUST NOT loosen.
        restrictTo?: CspDomainSet;
        // Per-directive CSP source-expression overrides. Keys are CSP
        // directive names (script-src, style-src, …); values are token
        // arrays. Stored verbatim — no enum. Inspector-only emission knob.
        cspDirectives?: Record<string, string[]>;
        extensions?: Record<string, unknown>;
      };
      permissions?: {
        mode?: "resource-declared" | "deny-all" | "custom";
        allow?: Record<string, boolean>;
        extensions?: Record<string, unknown>;
      };
      // Extra outer/inner iframe `sandbox=` tokens unioned with the
      // mandatory `allow-scripts allow-same-origin`. Inspector-only.
      sandboxAttrs?: string[];
      // Extra Permissions Policy entries appended to outer/inner iframe
      // `allow=`. Keys are RAW kebab Permissions Policy tokens
      // (clipboard-write, not clipboardWrite). Spec-permission keys are
      // dropped on canonicalize — those belong in `permissions.allow`.
      allowFeatures?: Record<string, string>;
    };
    // Overrides for the MCP Apps `ui/initialize` response (SEP-1865).
    // Sibling of `apps.sandbox`; distinct from `mcpProfile.initialize`
    // (which targets the base-protocol `initialize`).
    uiInitialize?: {
      // Stored as the exact `hostInfo` object the inspector should emit in
      // `ui/initialize`. Soft-validated (name & version required when set).
      hostInfo?: Record<string, unknown>;
    };
    // Vendor compat-runtime shims the inspector injects into widget HTML.
    // Claude/Cursor/Codex-style hosts leave these off; ChatGPT/Copilot and
    // MCPJam's dev surface enable them. Absent → inspector falls back to the
    // host style preset.
    compatRuntime?: {
      // Inject the OpenAI Apps SDK `window.openai` shim into widget HTML.
      //   undefined → fall back to the host style preset.
      //   true → inject the shim (preset baseline merged with overrides).
      //   false → do NOT inject; `openaiAppsOverrides` ignored.
      openaiApps?: boolean;
      // Sparse per-method overrides applied on top of the host style preset
      // when the shim IS injected. See canonicalizer for validation rules.
      openaiAppsOverrides?: OpenAiAppsCapabilities;
    };
    // Sparse per-dimension override on the SEP-1865 MCP Apps `app.*`
    // spec-bridge matrix. Independent from `compatRuntime`.
    mcpAppsOverrides?: McpAppsCapabilities;
  };
  extensions?: Record<string, unknown>;
};

// Per-method `window.openai.*` surface controlled by
// `mcpProfile.apps.compatRuntime.openaiAppsOverrides`. Sparse — every field
// optional; user overrides only specify fields they're flipping.
export type OpenAiAppsCapabilities = {
  callTool?: boolean;
  sendFollowUpMessage?: boolean;
  setWidgetState?: boolean;
  requestDisplayMode?: "all" | "fullscreen-only" | "none";
  notifyIntrinsicHeight?: boolean;
  openExternal?: boolean;
  setOpenInAppUrl?: boolean;
  requestModal?: boolean;
  uploadFile?: boolean;
  selectFiles?: boolean;
  getFileDownloadUrl?: boolean;
  requestCheckout?: boolean;
  requestClose?: boolean;
};

// Per-dimension surface controlled by `mcpProfile.apps.mcpAppsOverrides`.
// Sparse — every field optional. `availableDisplayModes` is the only
// non-boolean: an array of spec-defined mode strings, replacement semantics.
export type McpAppsCapabilities = {
  availableDisplayModes?: ("inline" | "fullscreen" | "pip")[];
  toolInputPartial?: boolean;
  toolCancelled?: boolean;
  hostContextChanged?: boolean;
  resourceTeardown?: boolean;
  toolInfo?: boolean;
  openLinks?: boolean;
  serverTools?: boolean;
  serverResources?: boolean;
  logging?: boolean;
  updateModelContext?: boolean;
  message?: boolean;
  sandboxPermissions?: boolean;
  cspFrameDomains?: boolean;
  cspBaseUriDomains?: boolean;
  resourcePrefersBorder?: boolean;
  downloadFile?: boolean;
  requestTeardown?: boolean;
  // Host policy for `ui/request-display-mode` originating from the widget.
  //   "accept": grant the requested mode
  //   "user-initiated-only": grant only after the user moved off `inline`
  //   "decline": always return the current mode
  widgetDisplayModeRequests?: "accept" | "user-initiated-only" | "decline";
};

// Personal cloud workstation attached to a host: one machine per
// (project, user), surfaced through computer-backed built-in tools (e.g.
// `bash` in `builtInToolIds`) and the web terminal. `computer` is the
// RESOURCE attachment only — which capabilities the model gets on it is
// expressed in `builtInToolIds`, the same list every other built-in tool
// uses (docs/project-computers.md in mcpjam-backend). The hash describes
// intent, not environment: two hosts with the same `computer` value hash
// identically even though each member resolves their own machine.
export type HostConfigComputer = {
  kind: "personal";
  // Optional initial working directory for shell/terminal sessions. Trimmed
  // during canonicalization; empty-after-trim collapses to absent.
  workdir?: string;
};

// Input-side shape: accepts the legacy `toolset` key from the original MVP
// shape (`{ kind, toolset: "bash" }`) and DROPS it during canonicalization —
// capability naming moved to `builtInToolIds`. Remove once no caller sends
// it (it never shipped in a UI, so this is belt-and-suspenders for old
// programmatic callers).
export type HostConfigComputerInput = {
  kind: "personal";
  toolset?: "bash";
  workdir?: string;
};

export type McpToolResultBlobVisibility = {
  enabled?: boolean;
  image?: boolean;
  audio?: boolean;
  document?: boolean;
  video?: boolean;
  otherBinary?: boolean;
};

export type ModelVisibleMcpToolResults = {
  directContent?: {
    text?: boolean;
    image?: boolean;
    audio?: boolean;
  };
  embeddedResources?: {
    text?: boolean;
    blob?: McpToolResultBlobVisibility;
  };
  linkedResources?: {
    text?: boolean;
    blob?: McpToolResultBlobVisibility;
  };
};

export type HostConfigInputV2 = {
  hostStyle: HostConfigStyle;
  modelId: string;
  systemPrompt: string;
  temperature: number;
  requireToolApproval: boolean;
  // Host-level opt-in for progressive MCP tool discovery. Optional + defaults
  // to undefined ("off") so pre-feature rows hash byte-identically.
  // JSON.stringify drops undefined, so `undefined` and `false` hash distinctly
  // only when the value is explicitly written.
  progressiveToolDiscovery?: boolean;
  // Host-level switch for SEP-1865 `_meta.ui.visibility` filtering. `true` →
  // hide tools whose visibility doesn't include "model" (spec default).
  // `false` → show every tool (faithful to hosts that don't implement
  // SEP-1865). `undefined` → "use the spec default" (filter).
  respectToolVisibility?: boolean;
  // Personal computer opt-in (resource only; capabilities ride
  // `builtInToolIds`). Optional + absent ⇒ no computer, hashing
  // byte-identically to pre-feature rows (the `progressiveToolDiscovery`
  // policy). `null` is accepted so the host editor can clear the field; the
  // canonicalizer collapses it to undefined so "cleared" and "never set"
  // hash identically. Legacy `toolset` input is accepted and dropped.
  computer?: HostConfigComputerInput | null;
  // Which real agent harness runs the turn. Absent ⇒ emulated loop;
  // `"claude-code"` runs the real Claude Code runtime. Optional + near
  // pass-through (like progressiveToolDiscovery) so absent hashes
  // byte-identically to pre-feature rows. Emulated has exactly one canonical
  // form (the key absent), so all emulated hosts dedupe together. The
  // canonicalizer rejects any value other than the known harness ids.
  harness?: Harness;
  // Optional during the rollout of project-scoped server config: named hosts
  // pass `undefined` (server set lives on `projects.serverIds`); chatbox/eval
  // forks still pass real arrays. Normalized to `[]` BEFORE hashing so the
  // canonical / hash output is byte-identical to the old "explicit empty
  // array" case.
  serverIds?: Array<ServerId>;
  optionalServerIds?: Array<ServerId>;
  // Catalog ids of host-managed built-in tools (e.g. "web_search") attached to
  // this host config — a peer dimension to serverIds. The SDK treats these as
  // OPAQUE strings: it validates wire shape (array of non-empty strings, then
  // dedupe + sort) but does NOT check them against any enum or catalog.
  // Existence / org-scope is enforced by the backend against the `builtInTools`
  // table. undefined OR [] → omitted from the canonical hash so pre-feature
  // rows stay byte-identical; a populated set dedupes + sorts before hashing.
  builtInToolIds?: ReadonlyArray<string>;
  // Host/client policy for how MCP tool-result content/resources become
  // model-visible. Optional so absent rows keep their historical hash and
  // runtime defaults can treat the currently implemented image leaves as
  // enabled.
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
  // Host/client policy for human-facing rendering of MCP tool-result images.
  // Optional so absent rows keep their historical hash and runtime defaults
  // can treat "unset" as inline rendering.
  mcpToolResultImageRendering?: McpToolResultImageRendering;
  connectionDefaults: HostConfigConnectionDefaults;
  clientCapabilities: Record<string, unknown>;
  hostContext: Record<string, unknown>;
  // Optional user override of the MCP Apps `hostCapabilities` blob advertised
  // in ui/initialize. undefined → use preset; `{}` → explicit empty (hashes
  // distinctly).
  hostCapabilitiesOverride?: Record<string, unknown>;
  // User override of the chat-UI surface. Same undefined-vs-{} semantics.
  chatUiOverride?: Record<string, unknown>;
  // Versioned envelope for host-level MCP state. Optional; absent means "use
  // SDK defaults / no host-level sandbox override."
  mcpProfile?: HostConfigMcpProfileV1;
  // Per-server connection overrides scoped to this host config. Keys are
  // server IDs. Included in the canonical hash.
  serverConnectionOverrides?: Record<
    string,
    {
      headersOverride?: Record<string, string>;
      requestTimeoutOverride?: number;
      mcpProtocolVersionOverride?: McpProtocolVersion;
    }
  >;
};

export type CanonicalHostConfigV2 = {
  schemaVersion: typeof HOST_CONFIG_SCHEMA_VERSION_V2;
  hostStyle: HostConfigStyle;
  modelId: string;
  systemPrompt: string;
  temperature: number;
  requireToolApproval: boolean;
  // Mirrors HostConfigInputV2.progressiveToolDiscovery. Optional so absent
  // rows hash byte-identically to pre-feature rows.
  progressiveToolDiscovery?: boolean;
  // Mirrors HostConfigInputV2.respectToolVisibility. Same undefined-vs-set
  // policy.
  respectToolVisibility?: boolean;
  // Mirrors HostConfigInputV2.computer with input `null` collapsed to
  // undefined, so the canonical JSON for "no computer" is byte-identical to
  // pre-feature rows.
  computer?: HostConfigComputer;
  // Mirrors HostConfigInputV2.harness (validated pass-through). Optional so
  // absent rows hash byte-identically to pre-feature rows.
  harness?: Harness;
  serverIds: Array<ServerId>;
  optionalServerIds: Array<ServerId>;
  // Mirrors HostConfigInputV2.builtInToolIds. Optional + omitted when absent or
  // empty so pre-feature rows hash byte-identically; deduped + sorted when set.
  builtInToolIds?: Array<string>;
  // Mirrors HostConfigInputV2.modelVisibleMcpToolResults. Optional so absent
  // rows hash byte-identically; explicit true/false leaves are real snapshots.
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
  mcpToolResultImageRendering?: McpToolResultImageRendering;
  connectionDefaults: HostConfigConnectionDefaults;
  clientCapabilities: Record<string, unknown>;
  hostContext: Record<string, unknown>;
  // Mirrors HostConfigInputV2.hostCapabilitiesOverride. Optional so
  // `undefined` (use preset) and `{}` (explicit empty) hash distinctly.
  hostCapabilitiesOverride?: Record<string, unknown>;
  chatUiOverride?: Record<string, unknown>;
  mcpProfile?: HostConfigMcpProfileV1;
  serverConnectionOverrides?: Record<
    string,
    {
      headersOverride?: Record<string, string>;
      requestTimeoutOverride?: number;
      mcpProtocolVersionOverride?: McpProtocolVersion;
    }
  >;
};

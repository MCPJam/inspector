/**
 * HostConfig v2 — portable type surface.
 *
 * SOURCE OF TRUTH. This module is the canonical home of the host-config
 * shape, canonicalizer, and hash.
 *
 * The canonicalizer is no longer hand-mirrored: mcpjam-backend PR #409
 * collapsed the mirror into a one-import delegation, so
 * `convex/lib/hostConfigV2.ts` IMPORTS `canonicalizeHostConfigV2` from
 * `@mcpjam/sdk/host-config/internal`. There is exactly one canonicalizer and
 * one golden-vector fixture (`sdk/tests/host-config-parity.test.ts`) — no
 * cross-repo parity ritual, and nothing to regenerate unless you
 * intentionally change an existing vector's canonical output.
 *
 * The backend does still hand-mirror the TYPES and, more importantly, keeps
 * an explicit persistence projection that copies known fields onto the stored
 * document. A new optional field added here is hashed by the shared
 * canonicalizer but will NOT be persisted until that projection and the
 * Convex validator learn about it — so ship the backend half in the same
 * change set as anything that must round-trip.
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
/**
 * Whether the simulated client mirrors `x-mcp-header`-annotated tool
 * arguments into `Mcp-Param-*` HTTP headers on `tools/call`
 * (SEP-2243, integrated into MCP `2026-07-28`).
 *
 * - `"mirror"` — spec-conforming, and the behavior you get when the field is
 *   absent. Declared arguments ride as `Mcp-Param-{Name}` headers.
 * - `"omit"` — simulate a NON-conforming client that never sends them. Real
 *   clients in the wild are uneven here (browser clients never mirror;
 *   MCPJam itself didn't until #3620), so this is how you check what your
 *   server does when the headers don't arrive — including whether it answers
 *   `-32020 HeaderMismatch` rather than silently serving the request.
 *
 * A property of the simulated CLIENT, not of one server, so it lives here
 * rather than on `serverConnectionOverrides`. An enum rather than a boolean
 * to leave room for future modes (e.g. a deliberately-corrupt value).
 */
export type ToolParamHeaderMirroring = "mirror" | "omit";

/** The permitted {@link ToolParamHeaderMirroring} literals, for validation. */
export const TOOL_PARAM_HEADER_MIRRORING_MODES = [
  "mirror",
  "omit",
] as const satisfies readonly ToolParamHeaderMirroring[];

// ── Client-conformance knobs ──────────────────────────────────────────
//
// Siblings of `toolParamHeaderMirroring`: each field models a way REAL
// clients differ from each other, so a server author can see their server
// through a specific client's eyes. Shared rules:
//
// - Absent = the spec-conforming/full behavior, and the field is OMITTED
//   from canonical output, so pre-feature rows keep their hash. The
//   conforming literal is storable but hashes distinctly; UIs write absence.
// - Each knob is a property of the simulated CLIENT, so it lives here
//   rather than on `serverConnectionOverrides`.
// - Enforcement is era- and transport-scoped: a knob whose mechanism
//   doesn't exist on the negotiated era (or on stdio) is silently inert.
//
// Deliberately NOT modeled here (each was considered and rejected):
// - `Mcp-Method`/`Mcp-Name` emission — the official client attaches these
//   on every modern enveloped request with no browser carve-out, so every
//   SDK-built client sends them. (Only `Mcp-Param-*` mirroring is browser-
//   gated, which is why `toolParamHeaderMirroring` exists and this does
//   not.) "What does my server do without them" is conformance-harness
//   territory, which already sends hostile frames outside the client.
// - A vestigial `Mcp-Session-Id`, or per-request `_meta` sent only on the
//   first request — no real client does either; the SDKs handle both.
// - `requestState` echo fidelity — synthetic fault injection against the
//   server's integrity check; belongs to the conformance harness.
// - Elicitation form/url support — already modeled, as
//   `clientCapabilities.elicitation.{form,url}`. Do not duplicate it here.
// - list_changed handling — a real divergence between hosts, but making
//   MCPJam's own tool list go stale is an anti-feature for a debugger.
//   It belongs in the host catalog as a fact to DISPLAY about a host, not
//   as a behavior to simulate.

/**
 * How the simulated client walks paginated list results (`tools/list`,
 * `resources/list`, `resources/templates/list`, `prompts/list`).
 *
 * - `"full"` — follow `nextCursor` to exhaustion (spec-conforming client
 *   behavior, and what an ABSENT field means).
 * - `"firstPageOnly"` — treat page one as the complete result, the way
 *   several real hosts notoriously do. Lets a server author answer "do my
 *   important tools survive a first-page-only host?".
 *
 * Deliberate interaction: the SEP-2243 `Mcp-Param-*` mirroring source is
 * the aggregated list cache, so under this mode params are mirrored only
 * for page-one tools — which is exactly how such a client really behaves.
 *
 * Era- and transport-agnostic: pagination has existed since `2025-03-26`,
 * and the enforcement seam is a transport wrapper (not the fetch layer), so
 * it applies on stdio as well as Streamable HTTP. Only the cursor-less
 * aggregation is truncated — an explicit-cursor request is the debugger's
 * own manual paging, not something the emulated client did.
 */
export type PaginationTraversalMode = "full" | "firstPageOnly";

/** The permitted {@link PaginationTraversalMode} literals, for validation. */
export const PAGINATION_TRAVERSAL_MODES = [
  "full",
  "firstPageOnly",
] as const satisfies readonly PaginationTraversalMode[];

/**
 * Whether the simulated client drives MRTR (multi-round tool result) at
 * all — i.e. whether it understands `resultType: "input_required"` and
 * retries the original request with `inputResponses`, or treats the result
 * as terminal. Real clients differ on whether they implement the 2026
 * pattern at all, which is the fact this models.
 *
 * - `"full"` — drive `input_required` rounds (and what an ABSENT field
 *   means).
 * - `"none"` — no MRTR: the modern connection must not advertise a
 *   capability the MRTR bridge would have to fulfill (advertise = enforce),
 *   and an `input_required` result surfaces to the caller instead of
 *   silently looping.
 *
 * WHICH elicitation modes an MRTR-capable client fulfills is a separate,
 * already-modeled fact: `clientCapabilities.elicitation.{form,url}`.
 * This knob is only about the retry loop existing.
 */
export type MrtrSupport = "full" | "none";

/** The permitted {@link MrtrSupport} literals, for validation. */
export const MRTR_SUPPORT_MODES = [
  "full",
  "none",
] as const satisfies readonly MrtrSupport[];

/**
 * The conformance-knob keys shared verbatim between the public `HostMcp`
 * authoring shape and the internal `mcpProfile` (same names on both sides),
 * so the profile ⇄ HostMcp round-trip helpers can copy them in one loop
 * instead of a hand-maintained block per knob. `toolParamHeaderMirroring`
 * predates this list and is copied individually at its call sites.
 */
export const CONFORMANCE_PROFILE_KEYS = [
  "paginationTraversal",
  "mrtrSupport",
] as const;

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
  // Host-default protocol selection. `"auto"` negotiates at connect time;
  // concrete revisions pin that exact wire era. Per-server pins live on
  // serverConnectionOverrides and win over this default.
  mcpProtocolVersion?: McpProtocolVersion | "auto";
  // Whether the simulated client mirrors `x-mcp-header` tool arguments into
  // `Mcp-Param-*` request headers (SEP-2243). Absent → `"mirror"`, the
  // spec-conforming default; `"omit"` simulates a non-conforming client so a
  // server can be tested against one. Host-level on purpose — conformance is
  // a property of the client, not of an individual server.
  toolParamHeaderMirroring?: ToolParamHeaderMirroring;
  // Client-conformance knobs (siblings of `toolParamHeaderMirroring`; see
  // the type docblocks above for per-knob semantics, and for the list of
  // knobs deliberately NOT modeled). Absent always means "spec-conforming"
  // and is omitted from canonical output.
  paginationTraversal?: PaginationTraversalMode;
  // Whether the client drives MRTR retry rounds at all. WHICH elicitation
  // modes it fulfills stays in `clientCapabilities.elicitation`.
  mrtrSupport?: MrtrSupport;
  // How the client handles `notifications/tools/list_changed` (probe-measured;
  // MCP spec "List Changed Notification" under server/tools, every revision
  // since 2024-11-05). Two independently-measured facts, not one flag:
  //
  //   listens   — the client opens the server->client notification channel at
  //               all (legacy: the standalone GET SSE stream; 2026-07-28:
  //               `subscriptions/listen`).
  //   refetches — after receiving the notification, the client re-issues
  //               `tools/list`.
  //
  // The two are independent. `refetches` was originally documented as only
  // measurable when `listens` is true; the 2026-08-26 Copilot capture
  // disproved that — a server can publish the notification on an open
  // `tools/call` response stream, reaching a client that never opened the
  // standalone channel, so `listens: false, refetches: true` is real.
  //
  // Absent -> spec-conforming (listens and refetches), like every knob above.
  toolListChanged?: {
    listens?: boolean;
    refetches?: boolean;
  };
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
      // Whether the browser storage APIs work inside the widget iframe
      // (probe-measured).
      //
      // NOT AN MCP CONCEPT. The MCP Apps spec (2026-01-26) says nothing about
      // storage — its `sandbox` object defines only `permissions` and `csp`.
      // This is an observed consequence of the sandboxed iframe the spec does
      // mandate ("MCP App HTML runs in a sandboxed iframe with no same-origin
      // server"), recorded because widgets that persist state break silently
      // on a host that blocks it. Named `browserStorage`, with the literal
      // browser API identifiers as keys, so nobody reads it as a capability
      // MCP negotiates.
      //
      // Each API is measured separately because a host can block one and not
      // the others (Safari private mode exposes `localStorage` and throws only
      // on write). Absent -> available.
      browserStorage?: {
        localStorage?: boolean;
        sessionStorage?: boolean;
        indexedDB?: boolean;
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
  cspConnectDomains?: {
    fetch?: boolean;
    xhr?: boolean;
    websocket?: boolean;
  };
  cspResourceDomains?: {
    script?: boolean;
    stylesheet?: boolean;
    image?: boolean;
    font?: boolean;
    media?: boolean;
  };
  resourceCacheTtl?: boolean;
  // Whether the host forwards the `structuredContent` half of a tool result
  // to the widget when the widget itself calls a tool (probe-measured; MCP
  // spec "Tool Result" -> "Structured Content" under server/tools). A tool
  // result has two halves - `content` blocks and `structuredContent` - and
  // some hosts strip the JSON half on the way back (Cursor 3.4 does), so a
  // widget reading it silently breaks. Absent -> forwarded (spec-conforming).
  toolResult?: {
    structuredContent?: boolean;
    // Which `ContentBlock` kinds survive the host->widget relay, per the MCP
    // spec "Tool Result" section under server/tools. Each kind names the
    // revision it arrived in: `text`/`image`/`resource` since 2024-11-05,
    // `audio` since 2025-03-26, `resource_link` since 2025-06-18.
    //
    // THIRD AXIS - do not merge with the two that already exist:
    //   `modelVisibleMcpToolResults`   - what the MODEL sees
    //   `mcpToolResultImageRendering`  - what mcpjam's own chat UI renders
    //   this field                     - what a WIDGET receives when it calls
    //                                    a tool itself
    // Absent -> relayed (spec-conforming).
    content?: {
      text?: boolean;
      image?: boolean;
      audio?: boolean;
      resource?: boolean;
      resourceLink?: boolean;
    };
  };
  resourcePrefersBorder?: boolean;
  downloadFile?: boolean;
  requestTeardown?: boolean;
  // Host policy for `ui/request-display-mode` originating from the widget.
  //   "accept": grant the requested mode
  //   "user-initiated-only": grant only after the user moved off `inline`
  //   "decline": always return the current mode
  widgetDisplayModeRequests?: "accept" | "user-initiated-only" | "decline";
};

// ── OAuth profile (HP-1 / HP-3) ───────────────────────────────────────
//
// Versioned envelope for per-host OAuth handshake knobs — how a given real
// client behaves during the OAuth dance, so emulators can replay it (HP-43)
// and the capability matrix can report it.
//
// EVERY field is an evidence envelope, never a bare value. This is a
// deliberate reaction to HP-17: a partner supplied nine cross-client OAuth
// claims and four did not survive verification, because the matrix had no way
// to distinguish "we observed this" from "someone said this". Here a value
// cannot be recorded without a citation and a capture date, and a field you
// could not confirm is representable ONLY as `unverifiable` — which carries
// no value at all (see `OAuthProfileEvidence`). Unverified lore is therefore
// unrepresentable rather than merely discouraged.

export const OAUTH_PROFILE_EVIDENCE_STATUSES = [
  "verified",
  "refuted",
  "unverifiable",
] as const;

/**
 * Verification state of a single profile field.
 *   `verified`     — read in first-party source or official docs.
 *   `refuted`      — positive evidence the claim is FALSE. Carries the true
 *                    value, so a refutation is durable and can't be
 *                    re-proposed later (HP-45 "keep refuted lore out").
 *   `unverifiable` — could not be confirmed. Carries a reason, never a value.
 */
export type OAuthProfileEvidenceStatus =
  (typeof OAUTH_PROFILE_EVIDENCE_STATUSES)[number];

/**
 * A profile field plus the evidence behind it.
 *
 * The union is the load-bearing part: `value` exists on the verified/refuted
 * arm ONLY. There is no way to spell "I think it's X but I couldn't check" —
 * that input is a type error in TS and a canonicalizer throw for untyped JS
 * callers. Downstream consumers (HP-43 emulator enforcement) can therefore
 * treat "has a value" as "is evidence-backed" without a second check.
 */
export type OAuthProfileEvidence<T> =
  | {
      status: "verified" | "refuted";
      value: T;
      /** Citation: an absolute URL, or `repo/path.ts:123`. Non-empty. */
      source: string;
      /** ISO calendar date (`YYYY-MM-DD`) the evidence was captured. */
      capturedAt: string;
    }
  | {
      status: "unverifiable";
      /** Why it could not be confirmed (e.g. "closed-source client"). */
      reason: string;
      /** Optional: when the attempt was made, for staleness tracking. */
      capturedAt?: string;
    };

export const OAUTH_AUTH_MODELS = [
  "oauth2-dcr",
  "oauth2-cimd",
  "oauth2-preregistered",
  "api-key",
  "none",
] as const;

/**
 * One way a client can authenticate to an MCP server.
 *
 * `oauth2-cimd` (Client ID Metadata Documents) is kept distinct from
 * `oauth2-dcr`: both obtain a client identity, but DCR self-asserts metadata
 * to a `registration_endpoint` (RFC 7591) while CIMD anchors identity to a
 * fetchable URL. A server that supports one does not necessarily support the
 * other, so collapsing them would lose the distinction the emulator needs.
 */
export type OAuthAuthModel = (typeof OAUTH_AUTH_MODELS)[number];

/**
 * An MCP authorization-spec revision, as its `YYYY-MM-DD` stamp.
 *
 * Deliberately NOT `McpProtocolVersion`. That enum is the set of revisions
 * *this inspector speaks*, which is a different set from the revisions a
 * third-party client implements: Cline's bundled SDK supports `2024-11-05`
 * and `2024-10-07`, and `rmcp` pins `2024-11-05` on OAuth discovery — none of
 * which are members. Reusing the enum silently made real, sourced findings
 * unrecordable. Validated by FORMAT (a real calendar date), not membership,
 * so a client on an older or newer revision than we support is still
 * expressible.
 */
export type OAuthSpecRevision = string;

/**
 * What we actually know about a client's OAuth spec revision.
 *
 * Two arms, because the evidence comes in two genuinely different strengths
 * and collapsing them would overstate the weaker one:
 *
 *   `constant`   — a literal revision string exists in the client's source.
 *                  `revisions` is the EXACT set it implements (clients are
 *                  often multi-revision: MCPJam ships four state machines).
 *   `behavioral` — no revision constant exists anywhere in the client (this
 *                  is the real state of VS Code), so the revision is inferred
 *                  from observed OAuth shape — e.g. an RFC 9728 PRM ladder
 *                  implies 2025-06-18 or later. `minimumRevision` is a FLOOR,
 *                  NOT an exact value.
 *
 * Keeping the floor distinct from the exact set is what lets a behavioral
 * finding be recorded as `verified` honestly: the verified claim is "at least
 * this revision", not "exactly this revision".
 */
export type OAuthSpecVersionClaim =
  | { basis: "constant"; revisions: OAuthSpecRevision[] }
  | { basis: "behavioral"; minimumRevision: OAuthSpecRevision };

/**
 * Whether the client hardcodes `MCP-Protocol-Version` or negotiates it.
 * Discriminated so "pinned" cannot be recorded without the pinned value.
 */
export type OAuthProtocolVersionPinning =
  | { mode: "pinned"; version: OAuthSpecRevision }
  | { mode: "negotiated" };

/**
 * The exact identity a client asserts at Dynamic Client Registration.
 *
 * Per RFC 7591 this metadata is self-asserted and therefore attacker
 * controllable, so it is NOT a sound input to server authorization policy —
 * but servers in the wild DO gate on `clientName`, so emulators must replay
 * these strings byte-exactly to reproduce real-world behavior. Recorded as
 * observation, not endorsement.
 */
export type OAuthDcrIdentity = {
  clientName?: string;
  redirectUris?: string[];
  userAgent?: string;
};

/**
 * Per-host OAuth handshake profile. Every field optional and absent-by-default
 * so a host that has not been investigated yet hashes byte-identically to a
 * pre-feature row.
 */
export type HostConfigOAuthProfileV1 = {
  profileVersion: 1;
  /** RFC 8707: does the client send `resource` on /authorize + /token? */
  sendsResourceIndicator?: OAuthProfileEvidence<boolean>;
  /**
   * Which MCP authorization spec revision(s) the client's OAuth layer
   * implements. Drives the discovery ladder — notably, clients on
   * `2025-03-26` assume same-origin AS endpoints. Modeled as the spec
   * revision, NOT as a standalone "same-origin" quirk flag, so the behavior
   * is derived from one fact instead of duplicated across two fields that can
   * disagree.
   *
   * This is the OAUTH layer only. The MCP layer's version lives in
   * `protocolVersionPinning`, and the two genuinely disagree in the wild —
   * Goose runs a PRM-era OAuth ladder while hard-pinning 2025-03-26 on MCP.
   */
  oauthSpecVersion?: OAuthProfileEvidence<OAuthSpecVersionClaim>;
  protocolVersionPinning?: OAuthProfileEvidence<OAuthProtocolVersionPinning>;
  dcrIdentity?: OAuthProfileEvidence<OAuthDcrIdentity>;
  /**
   * Every auth model the client supports, **in preference order** — the first
   * entry is what it reaches for first.
   *
   * A list rather than a single value because real clients are almost never
   * single-mode: Claude advertises six paths, Slack four, and both Codex and
   * Goose try static headers/bearer BEFORE falling back to OAuth on a 401.
   * Recording only a primary mode would discard the fallbacks an emulator has
   * to reproduce, and recording an unordered set would discard the precedence.
   *
   * Order is therefore semantic and is preserved verbatim — NOT sorted (same
   * convention as `mcpProfile.initialize.supportedProtocolVersions`).
   * Duplicates are rejected rather than deduped, since a repeated entry means
   * the caller's precedence list is ambiguous.
   *
   * `none` is the one entry that is not a mechanism but the absence of one —
   * it is how "this client has no auth" is spelled (see `oauthProfile` on
   * `HostConfigInputV2`). It is therefore rejected unless it is the SOLE
   * entry: `["none", "oauth2-dcr"]` claims the client both does and does not
   * authenticate, which is not a preference an emulator can honor.
   */
  authModel?: OAuthProfileEvidence<OAuthAuthModel[]>;
  extensions?: Record<string, unknown>;
};

export const OAUTH_SCOPE_REQUEST_MODES = [
  "omit",
  "fixed",
  "challenge",
  "all-supported",
] as const;

export type OAuthScopeRequestMode = (typeof OAUTH_SCOPE_REQUEST_MODES)[number];

/**
 * How a client populates the `scope` parameter on the authorization request.
 *
 *   `omit`          — never sends `scope`.
 *   `fixed`         — always sends the same captured scope list. Discriminated
 *                     so "fixed" cannot be recorded without the scopes (same
 *                     convention as `OAuthProtocolVersionPinning`). Order is
 *                     the captured wire order — preserved verbatim, duplicates
 *                     rejected — because the emulator replays the scope string
 *                     byte-exactly.
 *   `challenge`     — echoes the scopes from the `WWW-Authenticate` challenge.
 *   `all-supported` — sends the AS metadata's `scopes_supported`.
 */
export type OAuthScopeRequest =
  | { mode: "omit" }
  | { mode: "fixed"; scopes: string[] }
  | { mode: "challenge" }
  | { mode: "all-supported" };

export const OAUTH_TOKEN_ENDPOINT_AUTH_METHODS = [
  "none",
  "client_secret_basic",
  "client_secret_post",
] as const;

/**
 * RFC 7591 `token_endpoint_auth_method` a client asserts at registration and
 * honors at the token endpoint. Closed set — a future method must be added
 * here deliberately, not smuggled in as a free string.
 */
export type OAuthTokenEndpointAuthMethod =
  (typeof OAUTH_TOKEN_ENDPOINT_AUTH_METHODS)[number];

/**
 * Per-host OAuth handshake profile, version 2 (HP-43 emulator inputs).
 *
 * V2 exists alongside V1 — V1 canonicalization is FROZEN and V1 rows are
 * never rewritten, so every existing content-addressed hash stays valid. A
 * profile opts into V2 by writing `profileVersion: 2`; absent fields are
 * omitted from the canonical JSON exactly like V1 (never null/default-filled).
 *
 * Differences from V1, both in service of byte-exact wire replay:
 *   - two new evidence-backed fields: `scopeRequest` and
 *     `tokenEndpointAuthMethod`;
 *   - `dcrIdentity.redirectUris` preserves the CAPTURED order and rejects
 *     duplicates, where V1 deduped + sorted. The registration body the
 *     emulator sends must match what the real client sent, and that includes
 *     array order.
 *   - `dcrIdentity.clientName` is stored verbatim, where V1 trimmed —
 *     surrounding whitespace in a capture is part of the string a server may
 *     gate on. Empty/whitespace-only is still rejected as a missing capture.
 */
export type HostConfigOAuthProfileV2 = {
  profileVersion: 2;
  sendsResourceIndicator?: OAuthProfileEvidence<boolean>;
  oauthSpecVersion?: OAuthProfileEvidence<OAuthSpecVersionClaim>;
  protocolVersionPinning?: OAuthProfileEvidence<OAuthProtocolVersionPinning>;
  dcrIdentity?: OAuthProfileEvidence<OAuthDcrIdentity>;
  authModel?: OAuthProfileEvidence<OAuthAuthModel[]>;
  scopeRequest?: OAuthProfileEvidence<OAuthScopeRequest>;
  tokenEndpointAuthMethod?: OAuthProfileEvidence<OAuthTokenEndpointAuthMethod>;
  extensions?: Record<string, unknown>;
};

/** Either profile version. V1 rows stay V1 — there is no auto-upgrade. */
export type HostConfigOAuthProfile =
  | HostConfigOAuthProfileV1
  | HostConfigOAuthProfileV2;

// Personal cloud workstation attached to a host: one machine per
// (project, user), surfaced through computer-backed built-in tools (e.g.
// `bash` in `builtInToolIds`) and the web terminal. `computer` is the
// RESOURCE attachment only — which capabilities the model gets on it is
// expressed in `builtInToolIds`, the same list every other built-in tool
// uses (docs/project-computers.md in mcpjam-backend). The hash describes
// intent, not environment: two hosts with the same `computer` value hash
// identically even though each member resolves their own machine.
//
// `kind` is a closed union. `"personal"` is the only kind an AUTHOR can write
// (see `HostComputerInput` / `HostInit.computer` in public-types.ts, both
// narrowed to it). `"ephemeral"` is RUNTIME-MINTED: the platform stamps it at
// a snapshot boundary for a per-run box (an eval run boots one box per
// iteration from the run's frozen environment image). The image never rides
// this field — it comes from the run's frozen environment pin — and the minting
// site emits no `workdir`, because provisioning supplies the box's working
// directory. Naming a personal workdir on a per-run box would name a path on
// the author's own machine.
//
// That last rule is enforced where the kind is MINTED (the backend's
// `toEvalComputer`, which returns `{ kind: 'ephemeral' }` and nothing else),
// not here and not in the canonicalizer. This shape stays kind-agnostic on
// purpose: it is a content-addressing type, and folding a cross-field rule into
// it would mean a value that round-trips differently depending on a sibling
// field. Since no writer can produce an ephemeral computer with a `workdir`,
// there is nothing for such a rule to catch.
export type HostConfigComputerKind = "personal" | "ephemeral";

export type HostConfigComputer = {
  kind: HostConfigComputerKind;
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
  // INTERNAL input type — carries the full canonical kind union so a platform
  // snapshot boundary can hand `{ kind: "ephemeral" }` to the canonicalizer.
  // The PUBLIC authoring alias (`HostComputerInput`) stays personal-only.
  kind: HostConfigComputerKind;
  toolset?: "bash";
  workdir?: string;
};

/**
 * Skill selection policy for a host (OpenAI plugin import, PR SDK-2).
 * Controls which project skills a selection-aware runtime advertises.
 * Plugin-imported skills are ordinary materialized skill rows and are
 * selectable by id here exactly like any standalone skill — the UI groups
 * them by plugin provenance, but there is no separate selection channel.
 *
 * Input-side union:
 *   - absent (`undefined`)          → legacy all-visible behavior.
 *   - `{ mode: "all-visible" }`     → explicit spelling of the same behavior;
 *                                     canonicalized to ABSENT (see
 *                                     `canonicalizeSkillSelection`).
 *   - `{ mode: "explicit", skillIds }` → only the listed skills;
 *                                     `skillIds: []` means "explicitly none"
 *                                     and hashes distinctly from absent.
 */
export type HostConfigSkillSelection =
  | { mode: "all-visible" }
  | { mode: "explicit"; skillIds: string[] };

/**
 * Canonical-side skill selection. Only the explicit variant survives
 * canonicalization — `{ mode: "all-visible" }` collapses to absent so one
 * runtime behavior has exactly one content-addressed identity.
 */
export type CanonicalHostConfigSkillSelection = {
  mode: "explicit";
  skillIds: string[];
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
  // pass `undefined` (server set lives on `projects.serverIds`); scenario/eval
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
  // Skill selection policy. Absent → legacy all-visible behavior.
  // `{ mode: "all-visible" }` is the explicit spelling of the same behavior
  // and canonicalizes to absent; `{ mode: "explicit", skillIds }` (including
  // an EMPTY skillIds — "explicitly no skills") is preserved and hashes
  // distinctly from absent. Absence is semantic here. Hosts do NOT carry
  // plugin-specific fields: plugin component servers attach via `serverIds`
  // and plugin skills are selectable here by their materialized skill id.
  skillSelection?: HostConfigSkillSelection;
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
  // Versioned envelope for per-host OAuth handshake behavior. Optional; absent
  // means "this host's OAuth behavior has not been investigated yet" — which
  // is distinct from "it has no OAuth", spelled `authModel: { value: ["none"] }`
  // — which, being a claim about the whole client, must be the list's sole entry.
  oauthProfile?: HostConfigOAuthProfile;
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
  // Mirrors HostConfigInputV2.skillSelection. Only the explicit variant
  // survives canonicalization (`all-visible` collapses to absent so one
  // behavior has one content-addressed identity); explicit-empty
  // (`skillIds: []`) is preserved and hashes distinctly from absent.
  skillSelection?: CanonicalHostConfigSkillSelection;
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
  // Mirrors HostConfigInputV2.oauthProfile. Optional + omitted when absent so
  // every pre-feature row hashes byte-identically. Whichever profileVersion
  // came in is what comes out — canonicalization never upgrades V1 to V2.
  oauthProfile?: HostConfigOAuthProfile;
  serverConnectionOverrides?: Record<
    string,
    {
      headersOverride?: Record<string, string>;
      requestTimeoutOverride?: number;
      mcpProtocolVersionOverride?: McpProtocolVersion;
    }
  >;
};

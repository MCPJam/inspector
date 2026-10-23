/**
 * MCP Apps host capabilities shared by chat (the client's host styles) and the
 * eval/swarm browser harness, so both advertise the same `ui/initialize` blob.
 */

import type { McpUiHostCapabilities } from "@modelcontextprotocol/ext-apps/app-bridge";
// Canonical MCP Apps capability matrices live in the SDK so the compat engine
// and this playground emulation share ONE source. The SDK types them sparse
// (`McpAppsCapabilities`); they are complete surfaces, so we present them as
// the client's resolved (all-required) shape. The cast is guarded by a
// completeness test (built-ins matrix-parity). SLACK + the OpenAI surfaces stay
// local — the SDK catalog doesn't carry them.
import {
  MCP_APPS_FULL,
  MCP_APPS_CLAUDE,
  MCP_APPS_CHATGPT,
  MCP_APPS_COPILOT,
  MCP_APPS_CURSOR,
  MCP_APPS_GOOSE,
  MCP_APPS_NO_CLAIMS,
  MCP_APPS_VSCODE,
} from "@mcpjam/sdk/host-compat";


type HostCapabilitiesDetail = Partial<Omit<McpUiHostCapabilities, "sandbox">>;

/** The capability part of a host style: matrix plus preset-only detail. */
export type HostStyleCapabilities = {
  mcpAppsCapabilities: ResolvedMcpAppsCapabilities;
  hostCapabilitiesAugment?: HostCapabilitiesDetail;
  hostCapabilitiesReplacement?: HostCapabilitiesDetail;
};

/** Finds a host style's capabilities: chat's registry, or the built-in table. */
export type FindStyleCapabilities = (
  hostStyle: string | null | undefined,
) => HostStyleCapabilities | undefined;

/** The part of a saved profile these resolvers read. */
type McpProfileWithApps = { apps?: { mcpAppsOverrides?: McpAppsCapabilities } };

/**
 * Sibling of the client's `OpenAiAppsCapabilities` for the SEP-1865 `app.*` spec
 * bridge. Sparse here — presets supply the full resolved record via
 * {@link ResolvedMcpAppsCapabilities}; user overrides on
 * `mcpProfile.apps.mcpAppsOverrides` are sparse and merge field-by-field.
 *
 * Independent from the OpenAI shim matrix. `window.openai.callTool` and
 * `app.callTool` are different surfaces representing different APIs;
 * toggling a row here does not affect the OpenAI matrix and vice versa.
 *
 * Each row corresponds to one of three lever types:
 *
 *   - **advertise** — folded into the `HostCapabilities` blob the host
 *     returns in `ui/initialize` (e.g. `serverResources`, `logging`).
 *   - **emit** — gates whether the host actually sends a notification to
 *     the View at runtime (e.g. `toolInputPartial`, `hostContextChanged`).
 *   - **behavior** — gates how the host interprets resource `_meta.ui.*`
 *     or other inbound data (e.g. `resourcePrefersBorder`).
 *
 * Row meanings:
 *
 *   - `availableDisplayModes` — host-advertised display modes via
 *     `HostContext.availableDisplayModes`. The matrix only gates the
 *     host-advertised side; the View also declares its own
 *     `appCapabilities.availableDisplayModes` in `ui/initialize` (the
 *     widget's responsibility).
 *   - `toolInputPartial` / `toolCancelled` / `hostContextChanged` /
 *     `resourceTeardown` — gate whether the host emits the corresponding
 *     `ui/notifications/*` (or `ui/resource-teardown` request) to the View.
 *   - `toolInfo` — gate the `HostContext.toolInfo` field.
 *   - `serverResources` / `logging` — gate the matching `HostCapabilities`
 *     keys. Disabling `logging` also blocks `app.sendLog()` (the
 *     `notifications/message` View → Host channel is gated by this
 *     capability per the spec).
 *   - `sandboxPermissions` / `cspFrameDomains` / `cspBaseUriDomains` —
 *     gate whether the renderer honors the matching resource `_meta.ui`
 *     sandbox sub-fields when composing the iframe sandbox.
 *   - `resourcePrefersBorder` — gate whether the renderer honors
 *     `_meta.ui.prefersBorder` when rendering the iframe chrome.
 */
export type McpAppsCspConnectDomains = {
  fetch?: boolean;
  xhr?: boolean;
  websocket?: boolean;
};

export type McpAppsCspResourceDomains = {
  script?: boolean;
  stylesheet?: boolean;
  image?: boolean;
  font?: boolean;
  media?: boolean;
};

/**
 * Which halves of an MCP Tool Result the host relays to a widget that called
 * a tool. Named (not inlined) because BOTH the authoring surface
 * (`McpAppsCapabilities`) and the resolved surface
 * (`ResolvedMcpAppsCapabilities`) carry it, and the merge function converts
 * one into the other — inlining it twice is how they drift apart.
 */
export type McpAppsToolResultPolicy = {
  structuredContent?: boolean;
  content?: {
    text?: boolean;
    image?: boolean;
    audio?: boolean;
    resource?: boolean;
    resourceLink?: boolean;
  };
};

export type McpAppsCapabilities = {
  /** Allow-list of display modes advertised in HostContext. */
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
  cspConnectDomains?: McpAppsCspConnectDomains;
  cspResourceDomains?: McpAppsCspResourceDomains;
  resourcePrefersBorder?: boolean;
  downloadFile?: boolean;
  requestTeardown?: boolean;
  /**
   * Whether the host sends `hostContext.safeAreaInsets` at all. Optional
   * under SEP-1865, and hosts split: Claude reports 12px on every edge,
   * while Slackbot, Cursor, VS Code, Codex and Le Chat omit the key, so a
   * widget reading `insets.top` gets `undefined` rather than a zero.
   */
  safeAreaInsets?: boolean;
  /**
   * Probe-measured MCP Tool Result relay behavior for widget-initiated tool
   * calls. Shares storage with the app bridge overrides but is not an
   * `app.*` capability — it shapes the VALUE a live handler returns rather
   * than gating whether a handler exists.
   */
  toolResult?: McpAppsToolResultPolicy;
  /**
   * Host policy for `ui/request-display-mode` originating from the widget.
   * SEP-1865 permits the host to decline these requests; this row exposes
   * that decision as a knob.
   *   - "accept": grant the requested mode (clamped to `availableDisplayModes`)
   *   - "user-initiated-only": grant only after the user has explicitly
   *     moved off `inline` via the host picker; otherwise return `inline`
   *   - "decline": always return the current mode, ignoring the request
   */
  widgetDisplayModeRequests?: "accept" | "user-initiated-only" | "decline";
};

/**
 * Fully-resolved per-dimension matrix — preset merged with user overrides,
 * no undefineds except the optional probe-derived CSP subtype leaves.
 * Returned by `resolveEffectiveMcpAppsCapabilities`.
 * `availableDisplayModes` is non-empty (resolver coerces to `["inline"]`
 * if a user override would otherwise empty it).
 *
 * `openLinks` and `serverTools` are matrix-controlled even though every
 * built-in preset turns them on — keeping them in the matrix lets
 * legacy `hostCapabilitiesOverride: {}` ("advertise nothing") survive
 * migration without silently widening the advertised surface, and lets
 * future host presets that legitimately don't advertise them
 * (e.g. minimal SEP-1865-only hosts) sit in the same shape.
 *
 * `downloadFile` advertises the host's support for the spec's
 * `ui/download-file` request. When true the renderer wires
 * `bridge.ondownloadfile` and advertises `hostCapabilities.downloadFile`
 * in the ui/initialize blob.
 *
 * `requestTeardown` advertises that the host will honor a view-initiated
 * `ui/notifications/request-teardown` by attempting a graceful
 * `ui/resource-teardown` before unmounting the iframe. The notification
 * itself is not capability-gated by SEP-1865, but the matrix row keeps
 * the per-preset behavior honest (a host that ignores the request
 * should set this false).
 */
export type ResolvedMcpAppsCapabilities = {
  availableDisplayModes: ("inline" | "fullscreen" | "pip")[];
  toolInputPartial: boolean;
  toolCancelled: boolean;
  hostContextChanged: boolean;
  resourceTeardown: boolean;
  toolInfo: boolean;
  openLinks: boolean;
  serverTools: boolean;
  serverResources: boolean;
  logging: boolean;
  updateModelContext: boolean;
  message: boolean;
  sandboxPermissions: boolean;
  cspFrameDomains: boolean;
  cspBaseUriDomains: boolean;
  cspConnectDomains?: McpAppsCspConnectDomains;
  cspResourceDomains?: McpAppsCspResourceDomains;
  resourcePrefersBorder: boolean;
  downloadFile: boolean;
  requestTeardown: boolean;
  safeAreaInsets: boolean;
  widgetDisplayModeRequests: "accept" | "user-initiated-only" | "decline";
  /**
   * Optional like the CSP subtype records above: absent means the host
   * forwards the whole tool result. `mergeMcpAppsCapabilities` resolves it
   * and `host-app-bridge` enforces it on every result relayed to a widget.
   */
  toolResult?: McpAppsToolResultPolicy;
};

/**
 * Full MCP Apps `app.*` spec-bridge surface — every spec dimension on,
 * every display mode allowed. Used by Claude / ChatGPT / Cursor / Codex /
 * MCPJam as the per-host baseline before per-preset overrides
 * (`hostCapabilitiesAugment`, sparser `mcpAppsCapabilities` keys) tighten
 * specific rows.
 *
 * Independent from {@link OPENAI_APPS_FULL_SURFACE} — the two surfaces
 * model different APIs (`window.openai.*` shim vs `app.*` spec) and never
 * cross-gate.
 */
export const MCP_APPS_FULL_SURFACE: ResolvedMcpAppsCapabilities =
  MCP_APPS_FULL as ResolvedMcpAppsCapabilities;

export const MCP_APPS_CLAUDE_SURFACE: ResolvedMcpAppsCapabilities =
  MCP_APPS_CLAUDE as ResolvedMcpAppsCapabilities;

export const MCP_APPS_CHATGPT_SURFACE: ResolvedMcpAppsCapabilities =
  MCP_APPS_CHATGPT as ResolvedMcpAppsCapabilities;

export const MCP_APPS_CURSOR_SURFACE: ResolvedMcpAppsCapabilities =
  MCP_APPS_CURSOR as ResolvedMcpAppsCapabilities;

/**
 * Spec-default "no claims" surface — every advertise key off, no
 * notification gates, no behavior gates. `availableDisplayModes` stays
 * `["inline"]` (the spec baseline; an empty array is not a valid
 * resolved value). Used by the resolver as the fallback for unknown /
 * unrecognized host styles so persisted `mcpAppsOverrides` cannot
 * silently advertise near-full support on hosts that don't exist
 * (mirrors `SPEC_DEFAULT_HOST_CAPABILITIES` in `registry.ts`).
 */
export const MCP_APPS_NO_CLAIMS_SURFACE: ResolvedMcpAppsCapabilities =
  MCP_APPS_NO_CLAIMS as ResolvedMcpAppsCapabilities;

/**
 * Microsoft 365 Copilot's published MCP Apps spec-bridge surface, verbatim
 * from the "Supported MCP Apps capabilities in Copilot" → "Component
 * bridge" table at
 * https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-mcp-apps
 *
 * Diffs from FULL:
 *   - `availableDisplayModes` is `["inline", "fullscreen"]` (no `pip`).
 *     Copilot renders widgets INLINE by default and supports fullscreen as
 *     a mode the widget can request. The docs phrase
 *     `requestDisplayMode` as supported "fullscreen only" — that means
 *     fullscreen is the only expansion a widget may request, NOT that
 *     inline is unavailable (the docs show an inline widget screenshot and
 *     a user-clicked "Enter Fullscreen" button). Advertising
 *     `["fullscreen"]` alone made the clamp coerce the initial mode to
 *     fullscreen and trap the widget there (the close button could never
 *     return to inline).
 *   - `toolInputPartial`, `toolCancelled`, `hostContextChanged`,
 *     `resourceTeardown` off — these `ui/notifications/*` are not
 *     delivered by Copilot.
 *   - `toolInfo` off — `app.getHostContext()?.toolInfo` is not provided.
 *   - `serverResources`, `logging` off — Copilot does not advertise these
 *     `HostCapabilities` keys.
 *   - Sandbox `permissions`, `frameDomains`, `baseUriDomains` off —
 *     Copilot does not honor those resource `_meta.ui` sub-fields.
 *   - `resourcePrefersBorder` off — Copilot does not honor
 *     `_meta.ui.prefersBorder`.
 *
 * Note: `updateModelContext` and `message` stay on (Copilot honors both).
 */
export const MCP_APPS_COPILOT_SURFACE: ResolvedMcpAppsCapabilities =
  MCP_APPS_COPILOT as ResolvedMcpAppsCapabilities;

/**
 * Goose Desktop 1.38.0 captured MCP Apps surface. Goose renders MCP Apps and
 * exposes a rich HostContext (theme, display modes, style variables), but the
 * captured `ui/initialize.hostCapabilities` only advertised `openLinks`.
 * Keep the rest off until a probe demonstrates those bridge methods.
 */
export const MCP_APPS_GOOSE_SURFACE: ResolvedMcpAppsCapabilities =
  MCP_APPS_GOOSE as ResolvedMcpAppsCapabilities;

/**
 * Slackbot MCP host surface captured on 2026-06-24. Slackbot renders MCP Apps and
 * exposes HostContext/tool notifications, but the probed `ui/initialize`
 * hostCapabilities advertised only openLinks, serverTools, serverResources,
 * and logging. No `window.openai` surface was present in the iframe.
 */
export const MCP_APPS_SLACK_SURFACE: ResolvedMcpAppsCapabilities = {
  availableDisplayModes: ["inline", "fullscreen"],
  toolInputPartial: false,
  toolCancelled: false,
  hostContextChanged: false,
  resourceTeardown: false,
  toolInfo: true,
  openLinks: true,
  serverTools: true,
  serverResources: true,
  logging: true,
  updateModelContext: false,
  message: false,
  sandboxPermissions: false,
  cspFrameDomains: false,
  cspBaseUriDomains: false,
  resourcePrefersBorder: false,
  downloadFile: false,
  requestTeardown: false,
  // Slackbot omits `hostContext.safeAreaInsets` entirely — the
  // 2026-09-03 captures carry no such key in either theme.
  safeAreaInsets: false,
  widgetDisplayModeRequests: "accept",
};

/**
 * Content types OpenAI's App hosts accept, per the plugin extensions spec's
 * Supported Content table: `ui/update-model-context` takes text, images,
 * resource links, embedded resources and structured content; `ui/message`
 * takes the same minus structured content. The matrix's generic default is
 * text-only, which undersells what ChatGPT and Codex accept.
 */
const OPENAI_APP_HOST_CAPABILITIES_REPLACEMENT: HostCapabilitiesDetail =
  {
    updateModelContext: {
      text: {},
      image: {},
      resourceLink: {},
      resource: {},
      structuredContent: {},
    },
    message: {
      text: {},
      image: {},
      resourceLink: {},
      resource: {},
    },
  };

/**
 * Each built-in host style's MCP Apps capability data. The client's built-in
 * styles spread their entry, and eval and swarm resolve against this table,
 * so chat and the browser harness advertise the same capabilities.
 */
export const HOST_STYLE_CAPABILITIES = {
  claude: {
    // Claude advertises the full MCP Apps spec-bridge surface. `openLinks`
    // and `serverTools` are fixed-on baseline (not in matrix);
    // serverResources / logging / updateModelContext / message are matrix-
    // controlled and all on. listChanged sub-fields stay omitted because
    // the renderer doesn't forward those notifications yet — apps that
    // gate on `listChanged: true` would otherwise hit dead paths.
    mcpAppsCapabilities: MCP_APPS_CLAUDE_SURFACE,
  },
  "claude-desktop": {
    mcpAppsCapabilities: MCP_APPS_CLAUDE_SURFACE,
  },
  "claude-code": {
    mcpAppsCapabilities: MCP_APPS_FULL_SURFACE,
  },
  chatgpt: {
    mcpAppsCapabilities: MCP_APPS_CHATGPT_SURFACE,
    hostCapabilitiesReplacement: OPENAI_APP_HOST_CAPABILITIES_REPLACEMENT,
  },
  mistral: {
    // Keep this preset keyed to the Apps-side `ui/initialize` evidence:
    // no PIP, no downloadFile, no teardown claims, no `window.openai` shim,
    // and a text+image message surface.
    mcpAppsCapabilities: {
      ...MCP_APPS_FULL_SURFACE,
      availableDisplayModes: ["inline", "fullscreen"],
      toolCancelled: false,
      resourceTeardown: false,
      toolInfo: false,
      cspFrameDomains: false,
      cspBaseUriDomains: false,
      resourcePrefersBorder: false,
      downloadFile: false,
      requestTeardown: false,
      widgetDisplayModeRequests: "accept",
    },
    hostCapabilitiesAugment: {
      message: { image: {} },
    },
  },
  goose: {
    mcpAppsCapabilities: MCP_APPS_GOOSE_SURFACE,
  },
  slack: {
    mcpAppsCapabilities: MCP_APPS_SLACK_SURFACE,
  },
  cursor: {
    // Matrix captured verbatim from a Cursor 3.4.17 probe. Notably Cursor
    // does NOT advertise `updateModelContext` or `message`. The
    // `listChanged: false` markers on serverTools/serverResources don't
    // fit the M365-grain matrix (which is advertise-or-not booleans), so
    // they're carried as a preset-only `hostCapabilitiesAugment` below.
    // Don't widen without evidence — apps that gate on `listChanged: true`
    // need to know real Cursor doesn't send them.
    mcpAppsCapabilities: MCP_APPS_CURSOR_SURFACE,
    hostCapabilitiesAugment: {
      serverTools: { listChanged: false },
      serverResources: { listChanged: false },
    },
  },
  "cursor-cli": {
    mcpAppsCapabilities: MCP_APPS_NO_CLAIMS_SURFACE,
  },
  copilot: {
    // Microsoft 365 Copilot's published MCP Apps subset (see
    // MCP_APPS_COPILOT_SURFACE for the per-row M365 table mapping).
    // Strips serverResources / logging / notification gates / sandbox
    // sub-fields / resource prefersBorder; clamps display modes to
    // fullscreen-only.
    mcpAppsCapabilities: MCP_APPS_COPILOT_SURFACE,
  },
  codex: {
    // Codex shares ChatGPT's matrix (CLI surface mostly unused, but the
    // OpenAI-flavored protocol bucket carries over). serverResources /
    // logging off; updateModelContext / message on.
    mcpAppsCapabilities: {
      ...MCP_APPS_FULL_SURFACE,
      serverResources: false,
      logging: false,
      // Same CSP answers as ChatGPT (2026-08-19 probe), same app runtime.
      // `connect-src` is one directive, so the three subtypes cannot diverge:
      // the declared wss endpoint connected while an undeclared one took a
      // real violation, so the declared list IS honored. Resource subtypes
      // stay unknown — the probe's declared origin sits in ChatGPT's own
      // baseline allowlist, so it proves nothing either way.
      cspConnectDomains: { fetch: true, xhr: true, websocket: true },
    },
    // Same OpenAI app runtime as ChatGPT, so the same accepted content types.
    hostCapabilitiesReplacement: OPENAI_APP_HOST_CAPABILITIES_REPLACEMENT,
  },
  vscode: {
    mcpAppsCapabilities: MCP_APPS_VSCODE as ResolvedMcpAppsCapabilities,
    hostCapabilitiesAugment: {
      serverTools: { listChanged: true },
      serverResources: { listChanged: true },
    },
    // The matrix's generic updateModelContext default is `{ text: {} }`.
    // VS Code's capture advertises this exact typed set instead, with no text.
    hostCapabilitiesReplacement: {
      updateModelContext: {
        audio: {},
        image: {},
        resourceLink: {},
        resource: {},
        structuredContent: {},
      },
    },
  },
  agentcore: {
    // No widget rendering → advertise nothing. Honest baseline for a
    // text-only host.
    mcpAppsCapabilities: MCP_APPS_NO_CLAIMS_SURFACE,
  },
  n8n: {
    mcpAppsCapabilities: MCP_APPS_NO_CLAIMS_SURFACE,
  },
  perplexity: {
    mcpAppsCapabilities: MCP_APPS_NO_CLAIMS_SURFACE,
  },
  cline: {
    mcpAppsCapabilities: MCP_APPS_NO_CLAIMS_SURFACE,
  },
  notion: {
    mcpAppsCapabilities: MCP_APPS_NO_CLAIMS_SURFACE,
  },
  mcpjam: {
    // MCPJam is the inspector's own dev surface and intentionally
    // maximalist — full MCP Apps spec surface advertised so developers
    // testing here see every dimension a widget might touch.
    mcpAppsCapabilities: MCP_APPS_FULL_SURFACE,
  },
} satisfies Record<string, HostStyleCapabilities>;

/**
 * Last-resort fallback used when no host style resolves (e.g., the caller
 * passed an unknown id and we don't want to silently inherit Claude's
 * capability blob). Mirrors the "advertise nothing" position from the SEP —
 * widgets that gate on optional fields will treat them as unsupported.
 *
 * `sandbox` is intentionally omitted; it's per-resource runtime data.
 */
export const SPEC_DEFAULT_HOST_CAPABILITIES: Omit<
  McpUiHostCapabilities,
  "sandbox"
> = {};

/**
 * Build the `HostCapabilities` blob advertised in `ui/initialize` from a
 * resolved per-dimension matrix plus optional preset-only augment/replacement
 * detail. This is the single derivation point for advertisement — the matrix
 * is the source of truth (per the foundation PR's D1 decision).
 *
 * Every advertised field is matrix-controlled:
 *   - `openLinks` / `serverTools` / `serverResources` / `logging` /
 *     `updateModelContext` / `message` — advertised when the matrix
 *     sets `true`. (`openLinks` and `serverTools` are conventionally on
 *     for every built-in preset, but staying matrix-controlled lets
 *     legacy `hostCapabilitiesOverride: {}` migrate to a truly empty
 *     advertised blob without the resolver silently re-adding them.)
 *   - `downloadFile` — matrix-controlled. When the row is true the wire
 *     blob carries `downloadFile: {}` and the renderer wires
 *     `bridge.ondownloadfile`. Off for honest-no-claims presets.
 *   - `sandbox` — NOT added here; the renderer composes it separately
 *     via `resolveSandboxCsp` / `resolveSandboxPermissions` and adds it
 *     onto the advertised blob before passing to AppBridge.
 *
 * `augment` carries preset-specific sub-fields merged onto a matrix-derived
 * key (for example Cursor's `listChanged: false`). `replacement` carries an
 * exact typed value that must replace the generic matrix-derived shape (for
 * example VS Code's non-text updateModelContext set). Neither can add a key
 * the matrix omitted.
 */
export function buildHostCapabilities(
  matrix: ResolvedMcpAppsCapabilities,
  augment?: Partial<Omit<McpUiHostCapabilities, "sandbox">>,
  replacement?: Partial<Omit<McpUiHostCapabilities, "sandbox">>
): Omit<McpUiHostCapabilities, "sandbox"> {
  const caps: Omit<McpUiHostCapabilities, "sandbox"> = {};
  if (matrix.openLinks) caps.openLinks = {};
  if (matrix.serverTools) caps.serverTools = {};
  if (matrix.serverResources) caps.serverResources = {};
  if (matrix.logging) caps.logging = {};
  if (matrix.updateModelContext) caps.updateModelContext = { text: {} };
  if (matrix.message) caps.message = { text: {} };
  if (matrix.downloadFile) caps.downloadFile = {};
  if (augment) {
    for (const [key, value] of Object.entries(augment) as Array<
      [
        keyof Omit<McpUiHostCapabilities, "sandbox">,
        Omit<McpUiHostCapabilities, "sandbox">[keyof Omit<
          McpUiHostCapabilities,
          "sandbox"
        >]
      ]
    >) {
      if (caps[key] === undefined) continue;
      (caps as Record<string, unknown>)[key] = {
        ...(caps[key] as object),
        ...(value as object),
      };
    }
  }
  if (replacement) {
    for (const [key, value] of Object.entries(replacement)) {
      if ((caps as Record<string, unknown>)[key] === undefined) continue;
      (caps as Record<string, unknown>)[key] = value;
    }
  }
  return caps;
}

/**
 * Apply a sparse MCP Apps spec-bridge matrix override on top of a fully
 * resolved baseline. Mirrors {@link mergeOpenAiAppsCapabilities} for the
 * `app.*` surface. Each present field in `override` replaces the
 * corresponding baseline field; absent fields pass through.
 *
 * `availableDisplayModes` is REPLACED (not unioned) when present — the
 * array semantics is "exactly these modes." Empty arrays are coerced to
 * `["inline"]` (inline is the spec default; an empty allowlist would be
 * an unrenderable widget and the matrix UI prevents reaching this branch,
 * but the resolver enforces the invariant as a backstop).
 */
export function mergeMcpAppsCapabilities(
  base: ResolvedMcpAppsCapabilities,
  override: McpAppsCapabilities | undefined,
): ResolvedMcpAppsCapabilities {
  if (!override) return base;
  const modesOverride = override.availableDisplayModes;
  const availableDisplayModes =
    modesOverride !== undefined
      ? modesOverride.length > 0
        ? modesOverride
        : (["inline"] as ResolvedMcpAppsCapabilities["availableDisplayModes"])
      : base.availableDisplayModes;
  const cspConnectDomains =
    base.cspConnectDomains || override.cspConnectDomains
      ? { ...base.cspConnectDomains, ...override.cspConnectDomains }
      : undefined;
  const cspResourceDomains =
    base.cspResourceDomains || override.cspResourceDomains
      ? { ...base.cspResourceDomains, ...override.cspResourceDomains }
      : undefined;
  // Two levels deep, so a shallow spread would let an override that names
  // only `structuredContent` erase the preset's per-block-kind answers.
  const toolResult =
    base.toolResult || override.toolResult
      ? {
          ...base.toolResult,
          ...override.toolResult,
          ...(base.toolResult?.content || override.toolResult?.content
            ? {
                content: {
                  ...base.toolResult?.content,
                  ...override.toolResult?.content,
                },
              }
            : {}),
        }
      : undefined;
  return {
    availableDisplayModes,
    toolInputPartial: override.toolInputPartial ?? base.toolInputPartial,
    toolCancelled: override.toolCancelled ?? base.toolCancelled,
    hostContextChanged: override.hostContextChanged ?? base.hostContextChanged,
    resourceTeardown: override.resourceTeardown ?? base.resourceTeardown,
    toolInfo: override.toolInfo ?? base.toolInfo,
    openLinks: override.openLinks ?? base.openLinks,
    serverTools: override.serverTools ?? base.serverTools,
    serverResources: override.serverResources ?? base.serverResources,
    logging: override.logging ?? base.logging,
    updateModelContext: override.updateModelContext ?? base.updateModelContext,
    message: override.message ?? base.message,
    sandboxPermissions: override.sandboxPermissions ?? base.sandboxPermissions,
    cspFrameDomains: override.cspFrameDomains ?? base.cspFrameDomains,
    cspBaseUriDomains: override.cspBaseUriDomains ?? base.cspBaseUriDomains,
    cspConnectDomains,
    cspResourceDomains,
    toolResult,
    resourcePrefersBorder:
      override.resourcePrefersBorder ?? base.resourcePrefersBorder,
    downloadFile: override.downloadFile ?? base.downloadFile,
    requestTeardown: override.requestTeardown ?? base.requestTeardown,
    safeAreaInsets: override.safeAreaInsets ?? base.safeAreaInsets,
    widgetDisplayModeRequests:
      override.widgetDisplayModeRequests ?? base.widgetDisplayModeRequests,
  };
}

/**
 * Resolve the effective MCP Apps spec-bridge matrix for a host config.
 * Mirror of {@link resolveEffectiveCompatRuntime} for the spec bridge —
 * preset baseline from the host style + sparse user override from
 * `mcpProfile.apps.mcpAppsOverrides`, merged via
 * {@link mergeMcpAppsCapabilities}.
 *
 * Unlike `resolveEffectiveCompatRuntime`, this does NOT return a sum
 * type — the MCP Apps spec bridge is always active (it's the primary
 * protocol). Only the dimensions vary.
 */
export function resolveMcpAppsCapabilities(
  args: {
    profile: McpProfileWithApps | undefined;
    hostStyle: string | null | undefined;
  },
  findStyle: FindStyleCapabilities,
): ResolvedMcpAppsCapabilities {
  const hostStylePreset = findStyle(args.hostStyle)?.mcpAppsCapabilities;
  const override = args.profile?.apps?.mcpAppsOverrides;
  // Unknown / unrecognized host style fallback depends on whether the
  // user has explicitly opted in via override:
  //
  // - **Override present + host style unknown** → start from
  //   NO_CLAIMS so the user's sparse override only enables rows
  //   they explicitly set. A persisted override against a removed
  //   host can't silently advertise near-full support — matches
  //   `getHostCapabilitiesForStyle`'s honest "no claims" baseline
  //   (`registry.ts:SPEC_DEFAULT_HOST_CAPABILITIES`).
  //
  // - **No override + host style unknown** → fall back to
  //   FULL_SURFACE so runtime behavior matches pre-matrix
  //   permissive defaults. Without this, callers that don't supply
  //   a host style (test renderers, edge cases during init) would
  //   suddenly suppress every notification — a runtime regression
  //   the matrix shouldn't introduce when there's literally nothing
  //   to honor.
  const preset =
    hostStylePreset ??
    (override !== undefined
      ? MCP_APPS_NO_CLAIMS_SURFACE
      : MCP_APPS_FULL_SURFACE);
  return mergeMcpAppsCapabilities(preset, override);
}

/**
 * Resolve the `hostCapabilities` blob the MCP Apps iframe handshake should
 * advertise for a given host config. Precedence:
 *   1. Profile-level `mcpAppsOverrides` matrix (merged with the host style
 *      preset via {@link resolveMcpAppsCapabilities} → derived
 *      blob via {@link buildHostCapabilities}).
 *   2. Legacy top-level `hostCapabilitiesOverride` (verbatim, when present
 *      and the new matrix override is absent). Deprecated — migrated to
 *      `mcpAppsOverrides` at profile load via
 *      {@link hostCapabilitiesOverrideToMatrix}; readable for one release
 *      window so old persisted configs don't break.
 *   3. The active host style's preset (matrix-derived).
 *   4. Spec-default "no claims" baseline (handled inside
 *      {@link SPEC_DEFAULT_HOST_CAPABILITIES}).
 *
 * **Sandbox is intentionally NOT resolved here.** Per SEP-1865, sandbox
 * CSP/permissions are approved per-UI-resource at runtime and merged into
 * the final blob by the renderer. Profile presets and user overrides cover
 * vendor-trait fields only.
 *
 * **Conformance gap (advertise vs. enforce):** This returns the value the
 * handshake will advertise. Notification/behavior gates that match the
 * matrix land in subsequent PRs (B/C/D in the foundation PR series); the
 * matrix's notification/resource-meta rows are advertised here but not
 * yet enforced in the renderer's request handlers. Use this value as the
 * single source of truth when enforcement ships so advertise and enforce
 * stay in lockstep.
 */
export function resolveHostCapabilities(
  args: {
  hostStyle: string | null | undefined;
  /** Versioned profile carrying the new `mcpAppsOverrides` matrix. */
  profile?: McpProfileWithApps;
  /**
   * Legacy override. Deprecated; pass-through path while configs migrate.
   * If both `profile.apps.mcpAppsOverrides` and this are present, the
   * matrix wins (per the foundation PR's precedence rule).
   */
  hostCapabilitiesOverride?: Record<string, unknown>;
  },
  findStyle: FindStyleCapabilities,
): Omit<McpUiHostCapabilities, "sandbox"> {
  // 1. New matrix path — wins whenever the profile carries an
  // `mcpAppsOverrides`. Threaded through the renderer, canvas, Apps tab,
  // and saved-view consumers so a persisted matrix actually affects the
  // wire advertisement.
  if (args.profile?.apps?.mcpAppsOverrides !== undefined) {
    const matrix = resolveMcpAppsCapabilities(
      { profile: args.profile, hostStyle: args.hostStyle },
      findStyle,
    );
    const style = findStyle(args.hostStyle);
    return buildHostCapabilities(
      matrix,
      style?.hostCapabilitiesAugment,
      style?.hostCapabilitiesReplacement,
    );
  }
  // 2. Legacy override path — strip-then-return semantics preserved from
  // pre-matrix behavior so configs with `hostCapabilitiesOverride` set but
  // not yet migrated continue to advertise the user's saved value.
  // `!== undefined` (not truthy-check): `{}` is a meaningful override
  // ("advertise nothing") and must take the strip-then-return path, not
  // silently fall through to the preset.
  if (args.hostCapabilitiesOverride !== undefined) {
    // Strip `sandbox` defensively: the JSON editor doesn't prevent users
    // from typing it in, and leaking a static sandbox blob into the
    // advertised handshake would violate the per-resource sandbox rule
    // (SEP-1865 — sandbox is approved per UI resource at runtime, not as
    // a vendor trait). Matches the return-type contract.
    const { sandbox: _sandbox, ...rest } = args.hostCapabilitiesOverride as {
      sandbox?: unknown;
    } & Record<string, unknown>;
    return rest as Omit<McpUiHostCapabilities, "sandbox">;
  }
  // 3. No override → matrix-derived from the host style preset, or the
  // spec-default "no claims" baseline for an unknown id.
  const style = findStyle(args.hostStyle);
  if (!style) return SPEC_DEFAULT_HOST_CAPABILITIES;
  return buildHostCapabilities(
    style.mcpAppsCapabilities,
    style.hostCapabilitiesAugment,
    style.hostCapabilitiesReplacement,
  );
}

const BUILT_IN_STYLES: Readonly<Record<string, HostStyleCapabilities | undefined>> =
  HOST_STYLE_CAPABILITIES;

export function findBuiltInStyleCapabilities(
  hostStyle: string | null | undefined,
): HostStyleCapabilities | undefined {
  return hostStyle && Object.hasOwn(BUILT_IN_STYLES, hostStyle)
    ? BUILT_IN_STYLES[hostStyle]
    : undefined;
}

/** What eval and swarm advertise: chat's resolution over the built-in table. */
export function resolveBuiltInHostCapabilities(
  args: Parameters<typeof resolveHostCapabilities>[0],
): Omit<McpUiHostCapabilities, "sandbox"> {
  return resolveHostCapabilities(args, findBuiltInStyleCapabilities);
}

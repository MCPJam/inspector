import type {
  HostStyleCapabilities,
  ResolvedMcpAppsCapabilities,
} from "./host-style-capabilities";

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

type HostCapabilitiesDetail = NonNullable<
  HostStyleCapabilities["hostCapabilitiesReplacement"]
>;

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
const OPENAI_APP_HOST_CAPABILITIES_REPLACEMENT: HostCapabilitiesDetail = {
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

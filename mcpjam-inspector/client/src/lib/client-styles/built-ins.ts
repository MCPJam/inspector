import claudeLogo from "/claude_logo.png";
import claudeCodeLogo from "/claude_code_logo.png";
import openaiLogo from "/openai_logo.png";
import cursorLogo from "/cursor_logo.png";
import copilotLogo from "/copilot_logo.png";
import codexLogo from "/codex-logo.svg";
import vscodeLogo from "/vscode_logo.svg";
import bedrockLogo from "/bedrock_logo.svg";
import n8nLogo from "/n8n_logo.svg";
import perplexityLogo from "/perplexity_logo.svg";
import mcpjamLogo from "/mcp_jam.svg";
import { UIType } from "@/lib/mcp-ui/mcp-apps-utils";
import {
  CHATGPT_CHAT_BACKGROUND,
  CHATGPT_FONT_CSS,
  CHATGPT_PLATFORM,
  getChatGPTStyleVariables,
} from "@/config/chatgpt-client-context";
import {
  CLAUDE_DESKTOP_CHAT_BACKGROUND,
  CLAUDE_DESKTOP_FONT_CSS,
  CLAUDE_DESKTOP_PLATFORM,
  getClaudeDesktopStyleVariables,
} from "@/config/claude-desktop-client-context";
import {
  CURSOR_CHAT_BACKGROUND,
  CURSOR_FONT_CSS,
  CURSOR_PLATFORM,
  getCursorStyleVariables,
} from "@/config/cursor-client-context";
import {
  MCPJAM_CHAT_BACKGROUND,
  MCPJAM_FONT_CSS,
  MCPJAM_PLATFORM,
  getMcpJamStyleVariables,
} from "@/config/mcpjam-client-context";
import { ClaudeMarkIndicator } from "./indicators/claude-mark";
import { ClaudeCodeCliIndicator } from "./indicators/claude-code-cli";
import { ChatGptDotIndicator } from "./indicators/chatgpt-dot";
import { CursorShineIndicator } from "./indicators/cursor-shine";
import { CopilotPulseIndicator } from "./indicators/copilot-pulse";
import { CodexShineIndicator } from "./indicators/codex-shine";
import { MCPJamMarkIndicator } from "./indicators/mcpjam-mark";
import type {
  HostStyleDefinition,
  ResolvedMcpAppsCapabilities,
  ResolvedOpenAiAppsCapabilities,
} from "./types";

/**
 * Full `window.openai.*` method surface — every method on, every display
 * mode allowed. This is what ChatGPT (the original Apps SDK host) and the
 * MCPJam dev shim advertise.
 *
 * `selectFiles` is `true` here for type completeness and forward
 * compatibility, but the SDK runtime in
 * `sdk/src/McpAppsOpenAICompatibleRuntime.ts` does NOT install it yet —
 * widgets that feature-detect on it must see `typeof
 * window.openai.selectFiles === "undefined"` to take their fallback path.
 * `setOpenInAppUrl` is implemented by the runtime and host fullscreen
 * chrome.
 */
export const OPENAI_APPS_FULL_SURFACE: ResolvedOpenAiAppsCapabilities = {
  callTool: true,
  sendFollowUpMessage: true,
  setWidgetState: true,
  requestDisplayMode: "all",
  notifyIntrinsicHeight: true,
  openExternal: true,
  setOpenInAppUrl: true,
  requestModal: true,
  uploadFile: true,
  selectFiles: true,
  getFileDownloadUrl: true,
  requestCheckout: true,
  requestClose: true,
};

/**
 * Microsoft 365 Copilot's published per-method surface, verbatim from
 * the "Supported MCP Apps capabilities in Copilot" → "Component bridge"
 * table at
 * https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-mcp-apps
 *
 * Diffs from FULL: `requestDisplayMode` is fullscreen-only;
 * `requestModal`, `uploadFile`, `getFileDownloadUrl`, `requestCheckout`,
 * `selectFiles` are off. Everything else is on.
 */
export const OPENAI_APPS_COPILOT_SURFACE: ResolvedOpenAiAppsCapabilities = {
  callTool: true,
  sendFollowUpMessage: true,
  setWidgetState: true,
  requestDisplayMode: "fullscreen-only",
  notifyIntrinsicHeight: true,
  openExternal: true,
  setOpenInAppUrl: true,
  requestModal: false,
  uploadFile: false,
  selectFiles: false,
  getFileDownloadUrl: false,
  requestCheckout: false,
  requestClose: true,
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
export const MCP_APPS_FULL_SURFACE: ResolvedMcpAppsCapabilities = {
  availableDisplayModes: ["inline", "fullscreen", "pip"],
  toolInputPartial: true,
  toolCancelled: true,
  hostContextChanged: true,
  resourceTeardown: true,
  toolInfo: true,
  openLinks: true,
  serverTools: true,
  serverResources: true,
  logging: true,
  updateModelContext: true,
  message: true,
  sandboxPermissions: true,
  cspFrameDomains: true,
  cspBaseUriDomains: true,
  resourcePrefersBorder: true,
  downloadFile: true,
  requestTeardown: true,
  // Default to today's behavior — host accepts widget-initiated
  // `ui/request-display-mode` calls. Set to "user-initiated-only" or
  // "decline" per-preset (or via user override) to harden against
  // widgets that re-request fullscreen on every host-context-changed.
  widgetDisplayModeRequests: "accept",
};

/**
 * Spec-default "no claims" surface — every advertise key off, no
 * notification gates, no behavior gates. `availableDisplayModes` stays
 * `["inline"]` (the spec baseline; an empty array is not a valid
 * resolved value). Used by the resolver as the fallback for unknown /
 * unrecognized host styles so persisted `mcpAppsOverrides` cannot
 * silently advertise near-full support on hosts that don't exist
 * (mirrors `SPEC_DEFAULT_HOST_CAPABILITIES` in `registry.ts`).
 */
export const MCP_APPS_NO_CLAIMS_SURFACE: ResolvedMcpAppsCapabilities = {
  availableDisplayModes: ["inline"],
  toolInputPartial: false,
  toolCancelled: false,
  hostContextChanged: false,
  resourceTeardown: false,
  toolInfo: false,
  openLinks: false,
  serverTools: false,
  serverResources: false,
  logging: false,
  updateModelContext: false,
  message: false,
  sandboxPermissions: false,
  cspFrameDomains: false,
  cspBaseUriDomains: false,
  resourcePrefersBorder: false,
  downloadFile: false,
  requestTeardown: false,
  widgetDisplayModeRequests: "accept",
};

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
export const MCP_APPS_COPILOT_SURFACE: ResolvedMcpAppsCapabilities = {
  availableDisplayModes: ["inline", "fullscreen"],
  toolInputPartial: false,
  toolCancelled: false,
  hostContextChanged: false,
  resourceTeardown: false,
  toolInfo: false,
  openLinks: true,
  serverTools: true,
  serverResources: false,
  logging: false,
  updateModelContext: true,
  message: true,
  sandboxPermissions: false,
  cspFrameDomains: false,
  cspBaseUriDomains: false,
  resourcePrefersBorder: false,
  // Copilot's published spec-bridge table does not list downloadFile or
  // a request-teardown ack — leave off until Microsoft publishes
  // otherwise.
  downloadFile: false,
  requestTeardown: false,
  widgetDisplayModeRequests: "accept",
};

// NOTE: capability presets are best-effort mocks of what each vendor publicly
// supports today. Treat them as starting points — verify against vendor docs
// when behavior matters, and refine as the inspector's enforcement layer
// (Step 4) lands. Sandbox is omitted intentionally; it's resource-derived at
// runtime (see HostMcpProfile.hostCapabilities).
export const CLAUDE_HOST_STYLE: HostStyleDefinition = {
  id: "claude",
  mcp: {
    protocolOverride: UIType.MCP_APPS,
    platform: CLAUDE_DESKTOP_PLATFORM,
    fontCss: CLAUDE_DESKTOP_FONT_CSS,
    // Claude advertises the full MCP Apps spec-bridge surface. `openLinks`
    // and `serverTools` are fixed-on baseline (not in matrix);
    // serverResources / logging / updateModelContext / message are matrix-
    // controlled and all on. listChanged sub-fields stay omitted because
    // the renderer doesn't forward those notifications yet — apps that
    // gate on `listChanged: true` would otherwise hit dead paths.
    mcpAppsCapabilities: MCP_APPS_FULL_SURFACE,
    resolveStyleVariables: getClaudeDesktopStyleVariables,
  },
  chatUi: {
    label: "Claude",
    shortLabel: "Claude-style host",
    pickerDescription: "Claude-style chatbox chrome",
    logoSrc: claudeLogo,
    family: "claude",
    resolveChatBackground: (theme) => CLAUDE_DESKTOP_CHAT_BACKGROUND[theme],
    loadingIndicator: ClaudeMarkIndicator,
  },
};

// Claude Code is a terminal agent with no chat chrome of its own, so it
// borrows Claude's desktop chat surface wholesale (style variables, fonts,
// background, MCP profile) and only differs in brand identity: its own
// label, logo, and a CLI spinner busy-state instead of the claude.ai
// mascot. Mirrors how CODEX_HOST_STYLE borrows ChatGPT's surface.
//
// Capabilities reuse Claude's preset here, but the "claude-code" template
// (`client-templates.ts`) overrides hostCapabilities to `{}` since the CLI
// renders no MCP Apps — the style preset is just the fallback if a host
// ever clears that override.
export const CLAUDE_CODE_HOST_STYLE: HostStyleDefinition = {
  id: "claude-code",
  mcp: {
    protocolOverride: UIType.MCP_APPS,
    platform: CLAUDE_DESKTOP_PLATFORM,
    fontCss: CLAUDE_DESKTOP_FONT_CSS,
    mcpAppsCapabilities: MCP_APPS_FULL_SURFACE,
    resolveStyleVariables: getClaudeDesktopStyleVariables,
  },
  chatUi: {
    label: "Claude Code",
    shortLabel: "Claude Code-style host",
    pickerDescription: "Anthropic Claude Code CLI chrome",
    logoSrc: claudeCodeLogo,
    family: "claude",
    resolveChatBackground: (theme) => CLAUDE_DESKTOP_CHAT_BACKGROUND[theme],
    loadingIndicator: ClaudeCodeCliIndicator,
  },
};

export const CHATGPT_HOST_STYLE: HostStyleDefinition = {
  id: "chatgpt",
  mcp: {
    protocolOverride: UIType.OPENAI_SDK,
    platform: CHATGPT_PLATFORM,
    fontCss: CHATGPT_FONT_CSS,
    // ChatGPT differs from Claude on the SDK surface: ChatGPT's Apps SDK
    // historically focuses on tool calls rather than proxying server
    // resources/logging, so those rows are off here. `updateModelContext`
    // and `message` stay on. Adjust once verified against the current
    // OpenAI Apps SDK documentation.
    mcpAppsCapabilities: {
      ...MCP_APPS_FULL_SURFACE,
      serverResources: false,
      logging: false,
    },
    resolveStyleVariables: getChatGPTStyleVariables,
    // Real ChatGPT exposes the OpenAI Apps SDK `window.openai` surface
    // to widget HTML; emulating it here keeps existing Apps SDK widgets
    // rendering as their authors intended. Per-method capabilities = the
    // full surface (every method on, requestDisplayMode unconstrained).
    compatRuntime: {
      openaiApps: true,
      openaiAppsCapabilities: OPENAI_APPS_FULL_SURFACE,
    },
  },
  chatUi: {
    label: "ChatGPT",
    shortLabel: "ChatGPT-style host",
    pickerDescription: "OpenAI-style chatbox chrome",
    logoSrc: openaiLogo,
    family: "chatgpt",
    resolveChatBackground: (theme) => CHATGPT_CHAT_BACKGROUND[theme],
    loadingIndicator: ChatGptDotIndicator,
  },
};

export const CURSOR_HOST_STYLE: HostStyleDefinition = {
  id: "cursor",
  mcp: {
    // Cursor advertises only `text/html;profile=mcp-app` (per probe
    // clientCapabilities.extensions["io.modelcontextprotocol/ui"]).
    protocolOverride: UIType.MCP_APPS,
    platform: CURSOR_PLATFORM,
    fontCss: CURSOR_FONT_CSS,
    // Matrix captured verbatim from a Cursor 3.4.17 probe. Notably Cursor
    // does NOT advertise `updateModelContext` or `message`. The
    // `listChanged: false` markers on serverTools/serverResources don't
    // fit the M365-grain matrix (which is advertise-or-not booleans), so
    // they're carried as a preset-only `hostCapabilitiesAugment` below.
    // Don't widen without evidence — apps that gate on `listChanged: true`
    // need to know real Cursor doesn't send them.
    mcpAppsCapabilities: {
      ...MCP_APPS_FULL_SURFACE,
      updateModelContext: false,
      message: false,
    },
    hostCapabilitiesAugment: {
      serverTools: { listChanged: false },
      serverResources: { listChanged: false },
    },
    resolveStyleVariables: getCursorStyleVariables,
  },
  chatUi: {
    label: "Cursor",
    shortLabel: "Cursor-style host",
    pickerDescription: "Cursor IDE chat panel chrome",
    logoSrc: cursorLogo,
    // Visual family: Cursor's chat panel is a dark, flat, IDE-like surface
    // — closer to ChatGPT than to Claude's warm bubbles. Routes
    // family-keyed branches (bubble shape, send hint, etc.) to the
    // chatgpt visual until Cursor earns its own family.
    family: "chatgpt",
    resolveChatBackground: (theme) => CURSOR_CHAT_BACKGROUND[theme],
    loadingIndicator: CursorShineIndicator,
  },
};

/**
 * Microsoft 365 Copilot host style. Reuses ChatGPT's MCP profile and most
 * of its chat chrome — Copilot routes widgets through the OpenAI Apps SDK
 * under the hood and its chat UI sits in the same flat-neutral visual
 * bucket. Only the label, picker description, logo, chat background, and
 * loading indicator are Copilot-specific. The indicator is a faithful
 * recreation of M365 Copilot's 3-circle gradient pulse (see
 * `indicators/copilot-pulse.tsx`).
 */
export const COPILOT_HOST_STYLE: HostStyleDefinition = {
  id: "copilot",
  mcp: {
    protocolOverride: UIType.OPENAI_SDK,
    platform: CHATGPT_PLATFORM,
    fontCss: CHATGPT_FONT_CSS,
    // Microsoft 365 Copilot's published MCP Apps subset (see
    // MCP_APPS_COPILOT_SURFACE for the per-row M365 table mapping).
    // Strips serverResources / logging / notification gates / sandbox
    // sub-fields / resource prefersBorder; clamps display modes to
    // fullscreen-only.
    mcpAppsCapabilities: MCP_APPS_COPILOT_SURFACE,
    resolveStyleVariables: getChatGPTStyleVariables,
    // Copilot routes widgets through the OpenAI Apps SDK under the
    // hood, but exposes only a subset of `window.openai.*` — see
    // OPENAI_APPS_COPILOT_SURFACE for the per-method matrix.
    compatRuntime: {
      openaiApps: true,
      openaiAppsCapabilities: OPENAI_APPS_COPILOT_SURFACE,
    },
  },
  chatUi: {
    label: "Copilot",
    shortLabel: "Copilot-style host",
    pickerDescription: "Microsoft 365 Copilot chrome",
    logoSrc: copilotLogo,
    family: "chatgpt",
    // Light surface mirrors ChatGPT (pure white). Dark surface is
    // Copilot's slightly lighter neutral (#303030) — distinct from
    // ChatGPT's #212121, captured from M365 Copilot's chat panel.
    resolveChatBackground: (theme) =>
      theme === "dark" ? "rgba(48, 48, 48, 1)" : CHATGPT_CHAT_BACKGROUND.light,
    loadingIndicator: CopilotPulseIndicator,
  },
};

/**
 * OpenAI Codex host style. Codex itself is a CLI tool (no widget
 * rendering — see the Codex template in `client-templates.ts` which
 * advertises `elicitation`-only client capabilities), so this entry is
 * a playground stand-in rather than a faithful clone of a real Codex
 * surface. We mirror ChatGPT's MCP profile because Codex is OpenAI-
 * flavored: if a widget ever did land in a Codex-adjacent surface, the
 * OpenAI Apps SDK is the right protocol bucket. In practice the `mcp`
 * blob is unread (real Codex never renders an iframe).
 *
 * Chat surface reuses ChatGPT's `#212121` dark / white light colors
 * verbatim — Codex doesn't have its own published chat chrome to copy,
 * and ChatGPT's neutral palette is the closest analog to a terminal-
 * adjacent OpenAI tool. The loading indicator is the shimmering
 * "Thinking" treatment (`CodexShineIndicator`), which shares CSS with
 * Cursor's shine via a multi-selector rule in `index.css`.
 */
export const CODEX_HOST_STYLE: HostStyleDefinition = {
  id: "codex",
  mcp: {
    protocolOverride: UIType.OPENAI_SDK,
    platform: CHATGPT_PLATFORM,
    fontCss: CHATGPT_FONT_CSS,
    // Codex shares ChatGPT's matrix (CLI surface mostly unused, but the
    // OpenAI-flavored protocol bucket carries over). serverResources /
    // logging off; updateModelContext / message on.
    mcpAppsCapabilities: {
      ...MCP_APPS_FULL_SURFACE,
      serverResources: false,
      logging: false,
    },
    resolveStyleVariables: getChatGPTStyleVariables,
    // Codex is a CLI (no widget rendering surface), so the `window.openai`
    // shim is moot in practice. Keep it off so the inspector's emulated
    // Codex doesn't lie about a surface real Codex doesn't expose.
  },
  chatUi: {
    label: "Codex",
    shortLabel: "Codex-style host",
    pickerDescription: "OpenAI Codex CLI-style chrome",
    logoSrc: codexLogo,
    family: "chatgpt",
    resolveChatBackground: (theme) => CHATGPT_CHAT_BACKGROUND[theme],
    loadingIndicator: CodexShineIndicator,
  },
};

/**
 * Visual Studio Code host style (GitHub Copilot Chat MCP client). VS Code
 * is the editor Cursor itself forks — Cursor's `clientInfo.name` is
 * literally "cursor-vscode" and its chat panel mirrors "VS Code / Cursor's
 * standard editor surface" (see cursor-client-context.ts). So VS Code
 * reuses Cursor's chrome base verbatim (platform, font, style variables,
 * chat background, shine indicator); only the label, picker description,
 * and logo are VS Code-specific.
 *
 * Capability surface mirrors Cursor's MCP Apps subset — VS Code renders
 * MCP UI resources (`text/html;profile=mcp-app`) inline in the chat panel
 * but, like Cursor, does not surface `updateModelContext` / `message`
 * back-channels for widgets. Treat as a best-effort mock until a live VS
 * Code probe lands (no captured `ui/initialize` yet — values inherited
 * from Cursor's probe).
 */
export const VSCODE_HOST_STYLE: HostStyleDefinition = {
  id: "vscode",
  mcp: {
    // VS Code advertises the MCP UI extension (`text/html;profile=mcp-app`),
    // same as Cursor.
    protocolOverride: UIType.MCP_APPS,
    platform: CURSOR_PLATFORM,
    fontCss: CURSOR_FONT_CSS,
    // Inherited from Cursor's probe (VS Code shares the editor base). No
    // `updateModelContext` / `message`; carry the `listChanged: false`
    // markers as a preset-only augment so apps gating on `listChanged: true`
    // know they aren't forwarded.
    mcpAppsCapabilities: {
      ...MCP_APPS_FULL_SURFACE,
      updateModelContext: false,
      message: false,
    },
    hostCapabilitiesAugment: {
      serverTools: { listChanged: false },
      serverResources: { listChanged: false },
    },
    resolveStyleVariables: getCursorStyleVariables,
  },
  chatUi: {
    label: "VS Code",
    shortLabel: "VS Code-style host",
    pickerDescription: "Visual Studio Code chat panel chrome",
    logoSrc: vscodeLogo,
    // Flat, dark, IDE-like surface — same visual family as Cursor/ChatGPT.
    family: "chatgpt",
    resolveChatBackground: (theme) => CURSOR_CHAT_BACKGROUND[theme],
    loadingIndicator: CursorShineIndicator,
  },
};

/**
 * AWS Bedrock AgentCore host style. AgentCore is a server-side agent
 * runtime that permits only text-based MCP servers — it does not render
 * MCP Apps widgets (analogous to the Codex CLI; see the AgentCore template
 * in `client-templates.ts`, which advertises `elicitation`-only client
 * capabilities). This entry is therefore a playground stand-in, not a
 * faithful clone of a real rendering surface.
 *
 * Chrome reuses MCPJam's neutral house tokens — AgentCore has no published
 * chat UI of its own to copy, and the neutral surface is the honest choice
 * (don't invent AWS-branded chrome). The capability surface is the
 * spec-default "no claims" set because AgentCore renders nothing; the `mcp`
 * blob is unread in practice (no iframe is ever created).
 */
export const AGENTCORE_HOST_STYLE: HostStyleDefinition = {
  id: "agentcore",
  mcp: {
    protocolOverride: UIType.MCP_APPS,
    platform: MCPJAM_PLATFORM,
    fontCss: MCPJAM_FONT_CSS,
    // No widget rendering → advertise nothing. Honest baseline for a
    // text-only host.
    mcpAppsCapabilities: MCP_APPS_NO_CLAIMS_SURFACE,
    resolveStyleVariables: getMcpJamStyleVariables,
  },
  chatUi: {
    label: "AgentCore",
    shortLabel: "AgentCore-style host",
    pickerDescription: "AWS Bedrock AgentCore runtime (text servers only)",
    logoSrc: bedrockLogo,
    // Maps onto the claude visual family (warm bubble chat language) like
    // MCPJam, whose neutral tokens AgentCore borrows.
    family: "claude",
    resolveChatBackground: (theme) => MCPJAM_CHAT_BACKGROUND[theme],
    loadingIndicator: MCPJamMarkIndicator,
  },
};

/**
 * n8n MCP Client Tool host style. The real n8n client is a workflow-node
 * tool caller with no MCP Apps rendering surface, so its MCP matrix stays
 * at the no-claims baseline. The chat chrome is just MCPJam's neutral
 * stand-in with n8n identity; it exists so users can run the same simulated
 * turns through an n8n-shaped MCP initialize profile.
 */
export const N8N_HOST_STYLE: HostStyleDefinition = {
  id: "n8n",
  mcp: {
    protocolOverride: UIType.MCP_APPS,
    platform: MCPJAM_PLATFORM,
    fontCss: MCPJAM_FONT_CSS,
    mcpAppsCapabilities: MCP_APPS_NO_CLAIMS_SURFACE,
    resolveStyleVariables: getMcpJamStyleVariables,
  },
  chatUi: {
    label: "n8n",
    shortLabel: "n8n-style host",
    pickerDescription: "n8n MCP Client Tool (tools-only)",
    logoSrc: n8nLogo,
    family: "chatgpt",
    resolveChatBackground: (theme) => MCPJAM_CHAT_BACKGROUND[theme],
    loadingIndicator: MCPJamMarkIndicator,
  },
};

/**
 * Perplexity MCP client host style. The captured Perplexity probe exposes
 * only the base MCP initialize layer (`mcp@0.1.0`) with no capabilities and
 * no snapshot, so this preset mirrors a headless tool-calling client.
 */
export const PERPLEXITY_HOST_STYLE: HostStyleDefinition = {
  id: "perplexity",
  mcp: {
    protocolOverride: UIType.MCP_APPS,
    platform: MCPJAM_PLATFORM,
    fontCss: MCPJAM_FONT_CSS,
    mcpAppsCapabilities: MCP_APPS_NO_CLAIMS_SURFACE,
    resolveStyleVariables: getMcpJamStyleVariables,
  },
  chatUi: {
    label: "Perplexity",
    shortLabel: "Perplexity-style host",
    pickerDescription: "Perplexity MCP client (tools-only)",
    logoSrc: perplexityLogo,
    family: "chatgpt",
    resolveChatBackground: (theme) => MCPJAM_CHAT_BACKGROUND[theme],
    loadingIndicator: MCPJamMarkIndicator,
  },
};

/**
 * MCPJam's own house chrome. Used as the inspector's default host style so
 * "no host selected" doesn't silently render as Claude. Capability blob is
 * the inspector's actual MCP Apps renderer support — same baseline as
 * Claude minus `listChanged` notifications the renderer doesn't forward.
 */
export const MCPJAM_HOST_STYLE: HostStyleDefinition = {
  id: "mcpjam",
  mcp: {
    protocolOverride: UIType.MCP_APPS,
    platform: MCPJAM_PLATFORM,
    fontCss: MCPJAM_FONT_CSS,
    // MCPJam is the inspector's own dev surface and intentionally
    // maximalist — full MCP Apps spec surface advertised so developers
    // testing here see every dimension a widget might touch.
    mcpAppsCapabilities: MCP_APPS_FULL_SURFACE,
    resolveStyleVariables: getMcpJamStyleVariables,
    // MCPJam is the inspector's own house chrome and intentionally
    // maximalist: developers testing here should see the full
    // `window.openai` surface so widgets authored against OpenAI's
    // Apps SDK can be debugged in MCPJam without swapping to the
    // ChatGPT host. Real MCPJam exposes the shim deliberately (it's
    // not SEP-1865 honest, but it's the right call for a dev surface).
    compatRuntime: {
      openaiApps: true,
      openaiAppsCapabilities: OPENAI_APPS_FULL_SURFACE,
    },
  },
  chatUi: {
    label: "MCPJam",
    shortLabel: "MCPJam-style host",
    pickerDescription: "Inspector's house chrome",
    logoSrc: mcpjamLogo,
    // Maps onto the claude visual family (warm bubble chat language) until
    // MCPJam earns its own. Family controls bubble shape, send hint, etc.;
    // colors and the loading mark are already MCPJam-branded above.
    family: "claude",
    resolveChatBackground: (theme) => MCPJAM_CHAT_BACKGROUND[theme],
    loadingIndicator: MCPJamMarkIndicator,
  },
};

export const BUILT_IN_HOST_STYLES: readonly HostStyleDefinition[] = [
  MCPJAM_HOST_STYLE,
  CLAUDE_HOST_STYLE,
  CHATGPT_HOST_STYLE,
  CURSOR_HOST_STYLE,
  COPILOT_HOST_STYLE,
  CODEX_HOST_STYLE,
  CLAUDE_CODE_HOST_STYLE,
  VSCODE_HOST_STYLE,
  AGENTCORE_HOST_STYLE,
  N8N_HOST_STYLE,
  PERPLEXITY_HOST_STYLE,
];

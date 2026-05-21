import claudeLogo from "/claude_logo.png";
import openaiLogo from "/openai_logo.png";
import cursorLogo from "/cursor_logo.png";
import copilotLogo from "/copilot_logo.png";
import codexLogo from "/codex-logo.svg";
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
 * `selectFiles` / `setOpenInAppUrl` are `true` here for type completeness
 * and forward compatibility, but the SDK runtime in
 * `sdk/src/McpAppsOpenAICompatibleRuntime.ts` does NOT install them —
 * widgets that feature-detect on them must see `typeof
 * window.openai.selectFiles === "undefined"` to take their fallback path.
 * See plan §3 (feedback_feature_detection_over_rejection memory).
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
  serverResources: true,
  logging: true,
  updateModelContext: true,
  message: true,
  sandboxPermissions: true,
  cspFrameDomains: true,
  cspBaseUriDomains: true,
  resourcePrefersBorder: true,
};

/**
 * Microsoft 365 Copilot's published MCP Apps spec-bridge surface, verbatim
 * from the "Supported MCP Apps capabilities in Copilot" → "Component
 * bridge" table at
 * https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-mcp-apps
 *
 * Diffs from FULL:
 *   - `availableDisplayModes` clamped to `["fullscreen"]` (only fullscreen
 *     is honored; the docs say `requestDisplayMode` is supported as
 *     "fullscreen only").
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
  availableDisplayModes: ["fullscreen"],
  toolInputPartial: false,
  toolCancelled: false,
  hostContextChanged: false,
  resourceTeardown: false,
  toolInfo: false,
  serverResources: false,
  logging: false,
  updateModelContext: true,
  message: true,
  sandboxPermissions: false,
  cspFrameDomains: false,
  cspBaseUriDomains: false,
  resourcePrefersBorder: false,
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
];

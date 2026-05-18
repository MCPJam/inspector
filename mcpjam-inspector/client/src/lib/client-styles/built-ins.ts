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
import type { HostStyleDefinition } from "./types";

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
    // Only claim capabilities the renderer actually implements. listChanged
    // notifications are not forwarded into the iframe yet, so omit them here
    // — apps that gate on `listChanged: true` would otherwise hit dead paths.
    // Re-add per field when the renderer wires the corresponding notification
    // (see the enforcement landing pad in mcp-apps-renderer.tsx).
    hostCapabilities: {
      openLinks: {},
      serverTools: {},
      serverResources: {},
      logging: {},
      updateModelContext: { text: {} },
      message: { text: {} },
    },
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
    // Only claim capabilities the renderer actually implements (see comment
    // on CLAUDE_HOST_STYLE.mcp.hostCapabilities). `downloadFile` is a renderer
    // TODO and `listChanged` notifications aren't forwarded yet — both are
    // omitted to keep advertise and behavior in sync.
    hostCapabilities: {
      openLinks: {},
      serverTools: {},
      // Differs from Claude: ChatGPT's Apps SDK historically focuses on tool
      // calls rather than proxying server resources/logging. Adjust once
      // verified against the current OpenAI Apps SDK documentation.
      updateModelContext: { text: {} },
      message: { text: {} },
    },
    resolveStyleVariables: getChatGPTStyleVariables,
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
    // Capability blob captured verbatim from a Cursor 3.4.17 probe. Notably
    // Cursor does NOT advertise `updateModelContext` or `message`, and it
    // explicitly disables `listChanged` notifications on serverTools /
    // serverResources. Don't widen this without evidence — apps that gate
    // on `listChanged: true` need to know real Cursor doesn't send them.
    hostCapabilities: {
      openLinks: {},
      serverTools: { listChanged: false },
      serverResources: { listChanged: false },
      logging: {},
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
    hostCapabilities: {
      openLinks: {},
      serverTools: {},
      updateModelContext: { text: {} },
      message: { text: {} },
    },
    resolveStyleVariables: getChatGPTStyleVariables,
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
    hostCapabilities: {
      openLinks: {},
      serverTools: {},
      updateModelContext: { text: {} },
      message: { text: {} },
    },
    resolveStyleVariables: getChatGPTStyleVariables,
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
    hostCapabilities: {
      openLinks: {},
      serverTools: {},
      serverResources: {},
      logging: {},
      updateModelContext: { text: {} },
      message: { text: {} },
    },
    resolveStyleVariables: getMcpJamStyleVariables,
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

/**
 * Built-in styles for clients that borrow an existing client's surface (the
 * ChatGPT and Claude Code app clients, Codex CLI) and for two tools-only
 * clients (Muse, Grokbot). `built-ins.ts` lists them in BUILT_IN_HOST_STYLES.
 */

import claudeLogo from "/claude_logo.png";
import claudeDesktopLogo from "/claude-desktop-logo.png";
import chatgptDesktopLogo from "/chatgpt_desktop_logo.png";
import openaiLogo from "/openai_logo.png";
import codexLogo from "/codex-logo.svg";
import museLogo from "/muse_logo.png";
import grokbotLogo from "/grokbot_logo.png";
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
  MCPJAM_CHAT_BACKGROUND,
  MCPJAM_FONT_CSS,
  MCPJAM_PLATFORM,
  getMcpJamStyleVariables,
} from "@/config/mcpjam-client-context";
import { ClaudeCodeCliIndicator } from "./indicators/claude-code-cli";
import { ChatGptDotIndicator } from "./indicators/chatgpt-dot";
import { CodexShineIndicator } from "./indicators/codex-shine";
import { MCPJamMarkIndicator } from "./indicators/mcpjam-mark";
import type { HostStyleDefinition } from "./types";
import { HOST_STYLE_CAPABILITIES } from "@/shared/host-style-capabilities";
import {
  OPENAI_APPS_DESKTOP_SURFACE,
  OPENAI_APPS_FULL_SURFACE,
} from "./openai-apps-surfaces";

// Claude Code in the Claude desktop app and on the web. Its connectors use
// Claude Desktop's and claude.ai's widget hosts, so both borrow Claude's
// surface and differ in identity: Claude Code's label, logo and spinner. The
// behavioural differences live in the catalog rows.
export const CLAUDE_CODE_DESKTOP_HOST_STYLE: HostStyleDefinition = {
  id: "claude-code-desktop",
  mcp: {
    protocolOverride: UIType.MCP_APPS,
    platform: CLAUDE_DESKTOP_PLATFORM,
    fontCss: CLAUDE_DESKTOP_FONT_CSS,
    ...HOST_STYLE_CAPABILITIES["claude-code-desktop"],
    resolveStyleVariables: getClaudeDesktopStyleVariables,
  },
  chatUi: {
    // Must match the catalog label byte-for-byte (see CLAUDE_DESKTOP_HOST_STYLE).
    label: "Claude Code Desktop",
    shortLabel: "Claude Code Desktop-style host",
    pickerDescription: "Claude Code in the Claude desktop app",
    logoSrc: claudeDesktopLogo,
    family: "claude",
    resolveChatBackground: (theme) => CLAUDE_DESKTOP_CHAT_BACKGROUND[theme],
    loadingIndicator: ClaudeCodeCliIndicator,
  },
};

export const CLAUDE_CODE_WEB_HOST_STYLE: HostStyleDefinition = {
  id: "claude-code-web",
  mcp: {
    protocolOverride: UIType.MCP_APPS,
    platform: "web",
    fontCss: CLAUDE_DESKTOP_FONT_CSS,
    ...HOST_STYLE_CAPABILITIES["claude-code-web"],
    resolveStyleVariables: getClaudeDesktopStyleVariables,
  },
  chatUi: {
    // Must match the catalog label byte-for-byte (see CLAUDE_DESKTOP_HOST_STYLE).
    label: "Claude Code Web",
    shortLabel: "Claude Code Web-style host",
    pickerDescription: "Claude Code Web in the browser",
    logoSrc: claudeLogo,
    family: "claude",
    resolveChatBackground: (theme) => CLAUDE_DESKTOP_CHAT_BACKGROUND[theme],
    loadingIndicator: ClaudeCodeCliIndicator,
  },
};

// ChatGPT's desktop app and its work mode, on the web and in the desktop app.
// All three run OpenAI's app runtime, so they borrow ChatGPT's surface and
// differ in identity. The desktop builds expose the smaller `window.openai`
// the Codex app has; the work mode on the web exposes ChatGPT's full one.
export const CHATGPT_DESKTOP_HOST_STYLE: HostStyleDefinition = {
  id: "chatgpt-desktop",
  mcp: {
    protocolOverride: UIType.OPENAI_SDK,
    platform: "desktop",
    fontCss: CHATGPT_FONT_CSS,
    ...HOST_STYLE_CAPABILITIES["chatgpt-desktop"],
    resolveStyleVariables: getChatGPTStyleVariables,
    compatRuntime: {
      openaiApps: true,
      openaiAppsCapabilities: OPENAI_APPS_DESKTOP_SURFACE,
    },
  },
  chatUi: {
    label: "ChatGPT Desktop",
    shortLabel: "ChatGPT Desktop-style host",
    pickerDescription: "ChatGPT desktop app chrome",
    logoSrc: chatgptDesktopLogo,
    family: "chatgpt",
    resolveChatBackground: (theme) => CHATGPT_CHAT_BACKGROUND[theme],
    loadingIndicator: ChatGptDotIndicator,
  },
};

export const CHATGPT_WORK_HOST_STYLE: HostStyleDefinition = {
  id: "chatgpt-work",
  mcp: {
    protocolOverride: UIType.OPENAI_SDK,
    platform: CHATGPT_PLATFORM,
    fontCss: CHATGPT_FONT_CSS,
    ...HOST_STYLE_CAPABILITIES["chatgpt-work"],
    resolveStyleVariables: getChatGPTStyleVariables,
    compatRuntime: {
      openaiApps: true,
      openaiAppsCapabilities: OPENAI_APPS_FULL_SURFACE,
    },
  },
  chatUi: {
    label: "ChatGPT Work",
    shortLabel: "ChatGPT Work-style host",
    pickerDescription: "ChatGPT Work in the browser",
    logoSrc: openaiLogo,
    family: "chatgpt",
    resolveChatBackground: (theme) => CHATGPT_CHAT_BACKGROUND[theme],
    loadingIndicator: ChatGptDotIndicator,
  },
};

export const CHATGPT_WORK_DESKTOP_HOST_STYLE: HostStyleDefinition = {
  id: "chatgpt-work-desktop",
  mcp: {
    protocolOverride: UIType.OPENAI_SDK,
    platform: "desktop",
    fontCss: CHATGPT_FONT_CSS,
    ...HOST_STYLE_CAPABILITIES["chatgpt-work-desktop"],
    resolveStyleVariables: getChatGPTStyleVariables,
    compatRuntime: {
      openaiApps: true,
      openaiAppsCapabilities: OPENAI_APPS_DESKTOP_SURFACE,
    },
  },
  chatUi: {
    label: "ChatGPT Work Desktop",
    shortLabel: "ChatGPT Work Desktop-style host",
    pickerDescription: "ChatGPT work mode in the desktop app",
    logoSrc: chatgptDesktopLogo,
    family: "chatgpt",
    resolveChatBackground: (theme) => CHATGPT_CHAT_BACKGROUND[theme],
    loadingIndicator: ChatGptDotIndicator,
  },
};

/**
 * Codex in a terminal. Borrows Codex's chrome and differs in identity; the
 * capability claim drops to the no-claims preset, because the CLI renders no
 * widgets (the same recipe as CURSOR_CLI_HOST_STYLE).
 */
export const CODEX_CLI_HOST_STYLE: HostStyleDefinition = {
  id: "codex-cli",
  mcp: {
    protocolOverride: UIType.MCP_APPS,
    platform: CHATGPT_PLATFORM,
    fontCss: CHATGPT_FONT_CSS,
    ...HOST_STYLE_CAPABILITIES["codex-cli"],
    resolveStyleVariables: getChatGPTStyleVariables,
  },
  chatUi: {
    label: "Codex CLI",
    shortLabel: "Codex CLI-style host",
    pickerDescription: "OpenAI Codex in a terminal",
    logoSrc: codexLogo,
    family: "chatgpt",
    resolveChatBackground: (theme) => CHATGPT_CHAT_BACKGROUND[theme],
    loadingIndicator: CodexShineIndicator,
  },
};

/**
 * Muse and Grokbot: tools-only clients with no widget rendered during their
 * probes, so the MCP matrix stays at the no-claims baseline. The chat chrome
 * is MCPJam's neutral stand-in with each client's identity.
 */
export const MUSE_HOST_STYLE: HostStyleDefinition = {
  id: "muse",
  mcp: {
    protocolOverride: UIType.MCP_APPS,
    platform: MCPJAM_PLATFORM,
    fontCss: MCPJAM_FONT_CSS,
    ...HOST_STYLE_CAPABILITIES.muse,
    resolveStyleVariables: getMcpJamStyleVariables,
  },
  chatUi: {
    label: "Muse",
    shortLabel: "Muse-style host",
    pickerDescription: "Muse MCP client (tools-only)",
    logoSrc: museLogo,
    family: "chatgpt",
    resolveChatBackground: (theme) => MCPJAM_CHAT_BACKGROUND[theme],
    loadingIndicator: MCPJamMarkIndicator,
  },
};

export const GROKBOT_HOST_STYLE: HostStyleDefinition = {
  id: "grokbot",
  mcp: {
    protocolOverride: UIType.MCP_APPS,
    platform: MCPJAM_PLATFORM,
    fontCss: MCPJAM_FONT_CSS,
    ...HOST_STYLE_CAPABILITIES.grokbot,
    resolveStyleVariables: getMcpJamStyleVariables,
  },
  chatUi: {
    label: "Grokbot",
    shortLabel: "Grokbot-style host",
    pickerDescription: "Grokbot MCP client (tools-only)",
    logoSrc: grokbotLogo,
    family: "chatgpt",
    resolveChatBackground: (theme) => MCPJAM_CHAT_BACKGROUND[theme],
    loadingIndicator: MCPJamMarkIndicator,
  },
};

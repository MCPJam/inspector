import claudeLogo from "/claude_logo.png";
import openaiLogo from "/openai_logo.png";
import { UIType } from "@/lib/mcp-ui/mcp-apps-utils";
import {
  CHATGPT_CHAT_BACKGROUND,
  CHATGPT_FONT_CSS,
  CHATGPT_PLATFORM,
  getChatGPTStyleVariables,
} from "@/config/chatgpt-host-context";
import {
  CLAUDE_DESKTOP_CHAT_BACKGROUND,
  CLAUDE_DESKTOP_FONT_CSS,
  CLAUDE_DESKTOP_PLATFORM,
  getClaudeDesktopStyleVariables,
} from "@/config/claude-desktop-host-context";
import { ClaudeMarkIndicator } from "./indicators/claude-mark";
import { ChatGptDotIndicator } from "./indicators/chatgpt-dot";
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

export const BUILT_IN_HOST_STYLES: readonly HostStyleDefinition[] = [
  CLAUDE_HOST_STYLE,
  CHATGPT_HOST_STYLE,
];

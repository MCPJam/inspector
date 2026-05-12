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
import type { HostStyleDefinition } from "./types";

// NOTE: capability presets are best-effort mocks of what each vendor publicly
// supports today. Treat them as starting points — verify against vendor docs
// when behavior matters, and refine as the inspector's enforcement layer
// (Step 4) lands. Sandbox is omitted intentionally; it's resource-derived at
// runtime (see HostStyleDefinition.hostCapabilities).
export const CLAUDE_HOST_STYLE: HostStyleDefinition = {
  id: "claude",
  label: "Claude",
  shortLabel: "Claude-style host",
  pickerDescription: "Claude-style chatbox chrome",
  logoSrc: claudeLogo,
  family: "claude",
  protocolOverride: UIType.MCP_APPS,
  platform: CLAUDE_DESKTOP_PLATFORM,
  fontCss: CLAUDE_DESKTOP_FONT_CSS,
  hostCapabilities: {
    openLinks: {},
    serverTools: { listChanged: true },
    serverResources: { listChanged: true },
    logging: {},
    updateModelContext: { text: {} },
    message: { text: {} },
  },
  resolveStyleVariables: getClaudeDesktopStyleVariables,
  resolveChatBackground: (theme) => CLAUDE_DESKTOP_CHAT_BACKGROUND[theme],
};

export const CHATGPT_HOST_STYLE: HostStyleDefinition = {
  id: "chatgpt",
  label: "ChatGPT",
  shortLabel: "ChatGPT-style host",
  pickerDescription: "OpenAI-style chatbox chrome",
  logoSrc: openaiLogo,
  family: "chatgpt",
  protocolOverride: UIType.OPENAI_SDK,
  platform: CHATGPT_PLATFORM,
  fontCss: CHATGPT_FONT_CSS,
  hostCapabilities: {
    openLinks: {},
    serverTools: { listChanged: true },
    // Differs from Claude: ChatGPT's Apps SDK historically focuses on tool
    // calls rather than proxying server resources/logging. Adjust once
    // verified against the current OpenAI Apps SDK documentation.
    updateModelContext: { text: {} },
    message: { text: {} },
    downloadFile: {},
  },
  resolveStyleVariables: getChatGPTStyleVariables,
  resolveChatBackground: (theme) => CHATGPT_CHAT_BACKGROUND[theme],
};

export const BUILT_IN_HOST_STYLES: readonly HostStyleDefinition[] = [
  CLAUDE_HOST_STYLE,
  CHATGPT_HOST_STYLE,
];

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
  resolveStyleVariables: getChatGPTStyleVariables,
  resolveChatBackground: (theme) => CHATGPT_CHAT_BACKGROUND[theme],
};

export const BUILT_IN_HOST_STYLES: readonly HostStyleDefinition[] = [
  CLAUDE_HOST_STYLE,
  CHATGPT_HOST_STYLE,
];

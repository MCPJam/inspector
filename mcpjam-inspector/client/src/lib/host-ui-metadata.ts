import type { HostThemeMode } from "@/lib/client-styles";
import mcpjamLogo from "/mcp_jam.svg";
import claudeLogo from "/claude_logo.png";
import claudeDesktopLogo from "/claude-desktop-logo.png";
import claudeCodeLogo from "/claude_code_logo.png";
import openaiLogo from "/openai_logo.png";
import mistralLogo from "/mistral_logo.png";
import gooseLogoDark from "/goose_logo_dark.png";
import gooseLogoLight from "/goose_logo_light.png";
import cursorLogo from "/cursor_logo.png";
import codexLogo from "/codex-logo.svg";
import copilotLogo from "/copilot_logo.png";
import vscodeLogo from "/vscode_logo.svg";
import bedrockLogo from "/bedrock_logo.svg";
import n8nLogo from "/n8n_logo.svg";
import perplexityLogo from "/perplexity_logo.svg";
import clineLogoDark from "/cline_logo_dark.svg";
import clineLogoLight from "/cline_logo_light.svg";
import notionLogo from "/notion_logo.png";
import slackLogo from "/slack_logo.png";

export const DEFAULT_CATALOG_HOST_ID = "mcpjam";

export const UNKNOWN_HOST_LOGO = "/mcp.svg";

const LOGO_BY_HOST_ID: Record<string, string> = {
  mcpjam: mcpjamLogo,
  claude: claudeLogo,
  "claude-desktop": claudeDesktopLogo,
  "claude-code": claudeCodeLogo,
  chatgpt: openaiLogo,
  mistral: mistralLogo,
  goose: gooseLogoLight,
  slack: slackLogo,
  cursor: cursorLogo,
  // Same mark as the IDE: one Cursor brand, two products. Mapped explicitly
  // because an id absent from this record falls back to the anonymous MCP mark.
  "cursor-cli": cursorLogo,
  codex: codexLogo,
  copilot: copilotLogo,
  vscode: vscodeLogo,
  agentcore: bedrockLogo,
  n8n: n8nLogo,
  perplexity: perplexityLogo,
  cline: clineLogoLight,
  notion: notionLogo,
};

const LOGO_BY_HOST_ID_AND_THEME: Record<
  string,
  { light: string; dark: string } | undefined
> = {
  goose: {
    light: gooseLogoLight,
    dark: gooseLogoDark,
  },
  cline: {
    light: clineLogoLight,
    dark: clineLogoDark,
  },
};

export function getHostLogoSrc(
  hostId: string,
  themeMode?: HostThemeMode | null,
): string {
  return (
    (themeMode ? LOGO_BY_HOST_ID_AND_THEME[hostId]?.[themeMode] : undefined) ??
    LOGO_BY_HOST_ID[hostId] ??
    UNKNOWN_HOST_LOGO
  );
}

export const HOST_LOGO_OPTIONS = Object.entries(LOGO_BY_HOST_ID).map(
  ([id, logoSrc]) => ({
    id,
    logoSrc,
    logoSrcByTheme: LOGO_BY_HOST_ID_AND_THEME[id],
  }),
);

// Hosts whose mark is essentially black or white (ChatGPT, Codex, Cursor,
// Copilot, Goose, Cline, Notion) have no usable brand hue to tint with — a
// neutral gray keeps their circle reading neutral instead of arbitrarily
// colored, which is what the design's near-neutral swatches show.
const NEUTRAL_HOST_TINT = "#6E6E80";

const TINT_BY_HOST_ID: Record<string, string> = {
  mcpjam: "#E07856",
  claude: "#D97757",
  "claude-desktop": "#D97757",
  "claude-code": "#D97757",
  chatgpt: NEUTRAL_HOST_TINT,
  codex: NEUTRAL_HOST_TINT,
  mistral: "#FA520F",
  goose: NEUTRAL_HOST_TINT,
  slack: "#611F69",
  cursor: NEUTRAL_HOST_TINT,
  "cursor-cli": NEUTRAL_HOST_TINT,
  copilot: NEUTRAL_HOST_TINT,
  vscode: "#0098FF",
  agentcore: "#FF9900",
  n8n: "#EA4B71",
  perplexity: "#20808D",
  cline: NEUTRAL_HOST_TINT,
  notion: NEUTRAL_HOST_TINT,
};

/**
 * A subtle circular backdrop for a host logo (the server card's support pill
 * stacks these). The host's brand hue is mixed into `--card` rather than
 * hardcoded per theme, so one value reads as a faint tint on the light card
 * and on the dark one. Unknown host ids fall back to the neutral gray.
 */
export function getHostTintBackground(hostId: string): string {
  const tint = TINT_BY_HOST_ID[hostId] ?? NEUTRAL_HOST_TINT;
  return `color-mix(in oklch, ${tint} 12%, var(--card))`;
}

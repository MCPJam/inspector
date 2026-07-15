import type { HostThemeMode } from "@/lib/client-styles";
import mcpjamLogo from "/mcp_jam.svg";
import claudeLogo from "/claude_logo.png";
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

const UNKNOWN_HOST_LOGO = "/mcp.svg";

const LOGO_BY_HOST_ID: Record<string, string> = {
  mcpjam: mcpjamLogo,
  claude: claudeLogo,
  "claude-code": claudeCodeLogo,
  chatgpt: openaiLogo,
  mistral: mistralLogo,
  goose: gooseLogoLight,
  slack: slackLogo,
  cursor: cursorLogo,
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
  themeMode?: HostThemeMode | null
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
  })
);

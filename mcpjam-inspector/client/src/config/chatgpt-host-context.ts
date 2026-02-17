/**
 * ChatGPT host context — mapped from OpenAI's apps-sdk-ui design tokens
 *
 * All 76 style variables from the MCP Apps spec (SEP-1865), resolved
 * from ChatGPT's neutral gray design system into concrete RGBA strings.
 *
 * Source: https://github.com/openai/apps-sdk-ui
 *   - src/styles/variables-primitive.css (gray scale, color palettes)
 *   - src/styles/variables-semantic.css (semantic tokens, typography)
 */

import type { McpUiStyles } from "@modelcontextprotocol/ext-apps/app-bridge";

export const CHATGPT_PLATFORM = "web" as const;

const CHATGPT_LIGHT_DARK_VARS: Record<string, [light: string, dark: string]> = {
  // Backgrounds — pure neutral grays (no warm tint)
  // Mapped from ChatGPT's --color-surface / gray scale
  "--color-background-primary": [
    "rgba(255, 255, 255, 1)",
    "rgba(33, 33, 33, 1)",
  ],
  "--color-background-secondary": [
    "rgba(249, 249, 249, 1)",
    "rgba(24, 24, 24, 1)",
  ],
  "--color-background-tertiary": [
    "rgba(243, 243, 243, 1)",
    "rgba(19, 19, 19, 1)",
  ],
  "--color-background-inverse": [
    "rgba(13, 13, 13, 1)",
    "rgba(255, 255, 255, 1)",
  ],
  "--color-background-ghost": ["rgba(255, 255, 255, 0)", "rgba(33, 33, 33, 0)"],
  // Info — blue palette
  "--color-background-info": ["rgba(229, 243, 255, 1)", "rgba(1, 53, 102, 1)"],
  // Danger — red palette
  "--color-background-danger": [
    "rgba(255, 217, 217, 1)",
    "rgba(110, 22, 21, 1)",
  ],
  // Success — green palette
  "--color-background-success": [
    "rgba(217, 244, 228, 1)",
    "rgba(0, 79, 31, 1)",
  ],
  // Warning — orange palette (ChatGPT uses orange, not yellow)
  "--color-background-warning": [
    "rgba(255, 231, 217, 1)",
    "rgba(109, 46, 15, 1)",
  ],
  "--color-background-disabled": [
    "rgba(13, 13, 13, 0.05)",
    "rgba(255, 255, 255, 0.05)",
  ],

  // Text — neutral grays
  "--color-text-primary": ["rgba(13, 13, 13, 1)", "rgba(255, 255, 255, 1)"],
  "--color-text-secondary": ["rgba(93, 93, 93, 1)", "rgba(175, 175, 175, 1)"],
  "--color-text-tertiary": ["rgba(143, 143, 143, 1)", "rgba(143, 143, 143, 1)"],
  "--color-text-inverse": ["rgba(255, 255, 255, 1)", "rgba(13, 13, 13, 1)"],
  "--color-text-ghost": [
    "rgba(143, 143, 143, 0.5)",
    "rgba(143, 143, 143, 0.5)",
  ],
  // Info — blue
  "--color-text-info": ["rgba(1, 105, 204, 1)", "rgba(102, 181, 255, 1)"],
  // Danger — red
  "--color-text-danger": ["rgba(145, 30, 27, 1)", "rgba(224, 46, 42, 1)"],
  // Success — green
  "--color-text-success": ["rgba(0, 105, 42, 1)", "rgba(4, 184, 76, 1)"],
  // Warning — orange
  "--color-text-warning": ["rgba(146, 59, 15, 1)", "rgba(226, 85, 7, 1)"],
  "--color-text-disabled": ["rgba(143, 143, 143, 1)", "rgba(93, 93, 93, 1)"],

  // Borders — pure black/white alpha
  "--color-border-primary": [
    "rgba(0, 0, 0, 0.15)",
    "rgba(255, 255, 255, 0.20)",
  ],
  "--color-border-secondary": [
    "rgba(0, 0, 0, 0.10)",
    "rgba(255, 255, 255, 0.12)",
  ],
  "--color-border-tertiary": [
    "rgba(0, 0, 0, 0.05)",
    "rgba(255, 255, 255, 0.06)",
  ],
  "--color-border-inverse": [
    "rgba(255, 255, 255, 0.15)",
    "rgba(0, 0, 0, 0.10)",
  ],
  "--color-border-ghost": ["rgba(0, 0, 0, 0)", "rgba(255, 255, 255, 0)"],
  // Semantic borders — from ChatGPT's color palettes
  "--color-border-info": ["rgba(1, 105, 204, 1)", "rgba(2, 133, 255, 1)"],
  "--color-border-danger": ["rgba(224, 46, 42, 1)", "rgba(250, 66, 62, 1)"],
  "--color-border-success": ["rgba(0, 162, 64, 1)", "rgba(4, 184, 76, 1)"],
  "--color-border-warning": ["rgba(226, 85, 7, 1)", "rgba(251, 106, 34, 1)"],
  "--color-border-disabled": [
    "rgba(0, 0, 0, 0.06)",
    "rgba(255, 255, 255, 0.06)",
  ],

  // Rings — alpha versions of text/border colors
  "--color-ring-primary": ["rgba(13, 13, 13, 0.7)", "rgba(255, 255, 255, 0.7)"],
  "--color-ring-secondary": [
    "rgba(93, 93, 93, 0.7)",
    "rgba(175, 175, 175, 0.7)",
  ],
  "--color-ring-inverse": ["rgba(255, 255, 255, 0.7)", "rgba(13, 13, 13, 0.7)"],
  "--color-ring-info": ["rgba(1, 105, 204, 0.5)", "rgba(2, 133, 255, 0.5)"],
  "--color-ring-danger": ["rgba(224, 46, 42, 0.5)", "rgba(250, 66, 62, 0.5)"],
  "--color-ring-success": ["rgba(0, 162, 64, 0.5)", "rgba(4, 184, 76, 0.5)"],
  "--color-ring-warning": ["rgba(226, 85, 7, 0.5)", "rgba(251, 106, 34, 0.5)"],
};

const CHATGPT_STATIC_VARS: Record<string, string> = {
  // Fonts — system UI stack (no branded font)
  "--font-sans":
    'ui-sans-serif, -apple-system, system-ui, "Segoe UI", "Noto Sans", "Helvetica", "Arial", sans-serif',
  "--font-mono":
    'ui-monospace, "SFMono-Regular", "SF Mono", "Menlo", "Monaco", "Consolas", "Liberation Mono", "DejaVu Sans Mono", "Courier New", monospace',

  // Font weights — same as Claude
  "--font-weight-normal": "400",
  "--font-weight-medium": "500",
  "--font-weight-semibold": "600",
  "--font-weight-bold": "700",

  // Text sizes — ChatGPT uses slightly different sizes
  "--font-text-xs-size": "12px",
  "--font-text-sm-size": "14px",
  "--font-text-md-size": "16px",
  "--font-text-lg-size": "18px", // ChatGPT: 18px (Claude: 20px)

  // Heading sizes — ChatGPT's scale
  "--font-heading-xs-size": "16px",
  "--font-heading-sm-size": "18px",
  "--font-heading-md-size": "20px",
  "--font-heading-lg-size": "24px",
  "--font-heading-xl-size": "32px", // ChatGPT: 32px (Claude: 24px)
  "--font-heading-2xl-size": "36px",
  "--font-heading-3xl-size": "48px", // ChatGPT: 48px (Claude: 36px)

  // Text line heights
  "--font-text-xs-line-height": "1.5",
  "--font-text-sm-line-height": "1.43",
  "--font-text-md-line-height": "1.5",
  "--font-text-lg-line-height": "1.61",

  // Heading line heights
  "--font-heading-xs-line-height": "1.5",
  "--font-heading-sm-line-height": "1.44",
  "--font-heading-md-line-height": "1.3",
  "--font-heading-lg-line-height": "1.17",
  "--font-heading-xl-line-height": "1.19",
  "--font-heading-2xl-line-height": "1.17",
  "--font-heading-3xl-line-height": "1",

  // Border radius — same as Claude
  "--border-radius-xs": "4px",
  "--border-radius-sm": "6px",
  "--border-radius-md": "8px",
  "--border-radius-lg": "10px",
  "--border-radius-xl": "12px",
  "--border-radius-full": "9999px",

  // Border width
  "--border-width-regular": "1px",

  // Shadows — from ChatGPT's elevation system
  "--shadow-hairline": "0 0 0 1px rgba(0, 0, 0, 0.08)",
  "--shadow-sm": "0 1px 2px -1px rgba(0, 0, 0, 0.08)",
  "--shadow-md": "0 2px 4px -1px rgba(0, 0, 0, 0.08)",
  "--shadow-lg": "0 4px 8px -2px rgba(0, 0, 0, 0.1)",
};

/**
 * Returns ChatGPT style variables resolved to concrete RGBA values
 * for the given theme.
 */
export function getChatGPTStyleVariables(theme: "light" | "dark"): McpUiStyles {
  const idx = theme === "light" ? 0 : 1;
  const resolved: Record<string, string> = {};
  for (const [key, [light, dark]] of Object.entries(CHATGPT_LIGHT_DARK_VARS)) {
    resolved[key] = idx === 0 ? light : dark;
  }
  return { ...resolved, ...CHATGPT_STATIC_VARS } as McpUiStyles;
}

/** Actual ChatGPT chat area background (not a widget design token) */
export const CHATGPT_CHAT_BACKGROUND = {
  light: "rgba(255, 255, 255, 1)",
  dark: "rgba(33, 33, 33, 1)",
};

// No custom fonts — ChatGPT uses system fonts only
export const CHATGPT_FONT_CSS = ``;

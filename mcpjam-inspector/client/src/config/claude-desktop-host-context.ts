/**
 * Claude Desktop host context — captured from version 1.1.1520
 *
 * All 76 style variables from the MCP Apps spec (SEP-1865), resolved
 * from Claude Desktop's light-dark() values into concrete RGBA strings.
 */

import type { McpUiStyles } from "@modelcontextprotocol/ext-apps/app-bridge";

export const CLAUDE_DESKTOP_PLATFORM = "desktop" as const;

const CLAUDE_DESKTOP_LIGHT_DARK_VARS: Record<
  string,
  [light: string, dark: string]
> = {
  "--color-background-primary": [
    "rgba(255, 255, 255, 1)",
    "rgba(48, 48, 46, 1)",
  ],
  "--color-background-secondary": [
    "rgba(245, 244, 237, 1)",
    "rgba(38, 38, 36, 1)",
  ],
  "--color-background-tertiary": [
    "rgba(250, 249, 245, 1)",
    "rgba(20, 20, 19, 1)",
  ],
  "--color-background-inverse": [
    "rgba(20, 20, 19, 1)",
    "rgba(250, 249, 245, 1)",
  ],
  "--color-background-ghost": ["rgba(255, 255, 255, 0)", "rgba(48, 48, 46, 0)"],
  "--color-background-info": ["rgba(214, 228, 246, 1)", "rgba(37, 62, 95, 1)"],
  "--color-background-danger": [
    "rgba(247, 236, 236, 1)",
    "rgba(96, 42, 40, 1)",
  ],
  "--color-background-success": [
    "rgba(233, 241, 220, 1)",
    "rgba(27, 70, 20, 1)",
  ],
  "--color-background-warning": [
    "rgba(246, 238, 223, 1)",
    "rgba(72, 58, 15, 1)",
  ],
  "--color-background-disabled": [
    "rgba(255, 255, 255, 0.5)",
    "rgba(48, 48, 46, 0.5)",
  ],
  "--color-text-primary": ["rgba(20, 20, 19, 1)", "rgba(250, 249, 245, 1)"],
  "--color-text-secondary": ["rgba(61, 61, 58, 1)", "rgba(194, 192, 182, 1)"],
  "--color-text-tertiary": ["rgba(115, 114, 108, 1)", "rgba(156, 154, 146, 1)"],
  "--color-text-inverse": ["rgba(255, 255, 255, 1)", "rgba(20, 20, 19, 1)"],
  "--color-text-ghost": [
    "rgba(115, 114, 108, 0.5)",
    "rgba(156, 154, 146, 0.5)",
  ],
  "--color-text-info": ["rgba(50, 102, 173, 1)", "rgba(128, 170, 221, 1)"],
  "--color-text-danger": ["rgba(127, 44, 40, 1)", "rgba(238, 136, 132, 1)"],
  "--color-text-success": ["rgba(38, 91, 25, 1)", "rgba(122, 185, 72, 1)"],
  "--color-text-warning": ["rgba(90, 72, 21, 1)", "rgba(209, 160, 65, 1)"],
  "--color-text-disabled": [
    "rgba(20, 20, 19, 0.5)",
    "rgba(250, 249, 245, 0.5)",
  ],
  "--color-border-primary": [
    "rgba(31, 30, 29, 0.4)",
    "rgba(222, 220, 209, 0.4)",
  ],
  "--color-border-secondary": [
    "rgba(31, 30, 29, 0.3)",
    "rgba(222, 220, 209, 0.3)",
  ],
  "--color-border-tertiary": [
    "rgba(31, 30, 29, 0.15)",
    "rgba(222, 220, 209, 0.15)",
  ],
  "--color-border-inverse": [
    "rgba(255, 255, 255, 0.3)",
    "rgba(20, 20, 19, 0.15)",
  ],
  "--color-border-ghost": ["rgba(31, 30, 29, 0)", "rgba(222, 220, 209, 0)"],
  "--color-border-info": ["rgba(70, 130, 213, 1)", "rgba(70, 130, 213, 1)"],
  "--color-border-danger": ["rgba(167, 61, 57, 1)", "rgba(205, 92, 88, 1)"],
  "--color-border-success": ["rgba(67, 116, 38, 1)", "rgba(89, 145, 48, 1)"],
  "--color-border-warning": ["rgba(128, 92, 31, 1)", "rgba(168, 120, 41, 1)"],
  "--color-border-disabled": [
    "rgba(31, 30, 29, 0.1)",
    "rgba(222, 220, 209, 0.1)",
  ],
  "--color-ring-primary": ["rgba(20, 20, 19, 0.7)", "rgba(250, 249, 245, 0.7)"],
  "--color-ring-secondary": [
    "rgba(61, 61, 58, 0.7)",
    "rgba(194, 192, 182, 0.7)",
  ],
  "--color-ring-inverse": ["rgba(255, 255, 255, 0.7)", "rgba(20, 20, 19, 0.7)"],
  "--color-ring-info": ["rgba(50, 102, 173, 0.5)", "rgba(128, 170, 221, 0.5)"],
  "--color-ring-danger": ["rgba(167, 61, 57, 0.5)", "rgba(205, 92, 88, 0.5)"],
  "--color-ring-success": ["rgba(67, 116, 38, 0.5)", "rgba(89, 145, 48, 0.5)"],
  "--color-ring-warning": ["rgba(128, 92, 31, 0.5)", "rgba(168, 120, 41, 0.5)"],
};

const CLAUDE_DESKTOP_STATIC_VARS: Record<string, string> = {
  "--font-sans": "Anthropic Sans, sans-serif",
  "--font-mono": "ui-monospace, monospace",
  "--font-weight-normal": "400",
  "--font-weight-medium": "500",
  "--font-weight-semibold": "600",
  "--font-weight-bold": "700",
  "--font-text-xs-size": "12px",
  "--font-text-sm-size": "14px",
  "--font-text-md-size": "16px",
  "--font-text-lg-size": "20px",
  "--font-heading-xs-size": "12px",
  "--font-heading-sm-size": "14px",
  "--font-heading-md-size": "16px",
  "--font-heading-lg-size": "20px",
  "--font-heading-xl-size": "24px",
  "--font-heading-2xl-size": "28px",
  "--font-heading-3xl-size": "36px",
  "--font-text-xs-line-height": "1.4",
  "--font-text-sm-line-height": "1.4",
  "--font-text-md-line-height": "1.4",
  "--font-text-lg-line-height": "1.25",
  "--font-heading-xs-line-height": "1.4",
  "--font-heading-sm-line-height": "1.4",
  "--font-heading-md-line-height": "1.4",
  "--font-heading-lg-line-height": "1.25",
  "--font-heading-xl-line-height": "1.25",
  "--font-heading-2xl-line-height": "1.1",
  "--font-heading-3xl-line-height": "1",
  "--border-radius-xs": "4px",
  "--border-radius-sm": "6px",
  "--border-radius-md": "8px",
  "--border-radius-lg": "10px",
  "--border-radius-xl": "12px",
  "--border-radius-full": "9999px",
  "--border-width-regular": "0.5px",
  "--shadow-hairline": "0 1px 2px 0 rgba(0, 0, 0, 0.05)",
  "--shadow-sm":
    "0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px -1px rgba(0, 0, 0, 0.1)",
  "--shadow-md":
    "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1)",
  "--shadow-lg":
    "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1)",
};

/**
 * Returns Claude Desktop style variables resolved to concrete RGBA values
 * for the given theme.
 */
export function getClaudeDesktopStyleVariables(
  theme: "light" | "dark",
): McpUiStyles {
  const idx = theme === "light" ? 0 : 1;
  const resolved: Record<string, string> = {};
  for (const [key, [light, dark]] of Object.entries(
    CLAUDE_DESKTOP_LIGHT_DARK_VARS,
  )) {
    resolved[key] = idx === 0 ? light : dark;
  }
  return { ...resolved, ...CLAUDE_DESKTOP_STATIC_VARS } as McpUiStyles;
}

// Empty: Anthropic Sans requires external URLs (assets.claude.ai) blocked by the
// sandbox CSP (font-src data:). All font sizes, weights (400–700), and styles
// (normal/italic) still work — --font-sans falls back to the system sans-serif font.
export const CLAUDE_DESKTOP_FONT_CSS = ``;

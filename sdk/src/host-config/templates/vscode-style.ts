/**
 * Visual Studio Code 1.130.0 resolved MCP Apps style variables.
 *
 * Captured from live light and dark `ui/initialize` host contexts on
 * 2026-07-23. VS Code sends `var(--vscode-...)` references; these are the
 * browser-resolved values so MCPJam can reproduce the host outside VS Code.
 */

const VSCODE_LIGHT_DARK_VARS: Record<string, [light: string, dark: string]> = {
  "--border-radius-full": ["9999px", "9999px"],
  "--border-radius-lg": ["6px", "6px"],
  "--border-radius-md": ["4px", "4px"],
  "--border-radius-sm": ["3px", "3px"],
  "--border-radius-xl": ["8px", "8px"],
  "--border-radius-xs": ["2px", "2px"],
  "--border-width-regular": ["1px", "1px"],
  "--color-background-danger": ["#fdeded", "#5a1d1d"],
  "--color-background-disabled": ["rgba(0, 105, 204, 0.1)", "#3a3d41"],
  "--color-background-ghost": ["transparent", "transparent"],
  "--color-background-info": ["#e6f2fa", "#063b49"],
  "--color-background-inverse": ["#202020", "#d4d4d4"],
  "--color-background-primary": ["#ffffff", "#1e1e1e"],
  "--color-background-secondary": ["#fafafd", "#252526"],
  "--color-background-success": [
    "rgba(88, 124, 12, 0.15)",
    "rgba(156, 204, 44, 0.2)",
  ],
  "--color-background-tertiary": ["#fafafd", "#333333"],
  "--color-background-warning": ["#fdf6e3", "#352a05"],
  "--color-border-danger": ["#ad0707", "#be1100"],
  "--color-border-disabled": ["#bbbbbb", "rgba(204, 204, 204, 0.5)"],
  "--color-border-ghost": ["transparent", "transparent"],
  "--color-border-info": ["#0069cc", "#007acc"],
  "--color-border-inverse": ["#202020", "#cccccc"],
  "--color-border-primary": ["#e2e2e5", "#303031"],
  "--color-border-secondary": ["#e4e5e6", "rgba(204, 204, 204, 0.2)"],
  "--color-border-success": ["#73c991", "#73c991"],
  "--color-border-tertiary": ["#f0f1f2", "rgba(128, 128, 128, 0.35)"],
  "--color-border-warning": ["#b69500", "#b89500"],
  "--color-ring-danger": ["#ad0707", "#be1100"],
  "--color-ring-info": ["#0069cc", "#007acc"],
  "--color-ring-inverse": ["#0069cc", "#007fd4"],
  "--color-ring-primary": ["#0069cc", "#007fd4"],
  "--color-ring-secondary": ["#0069cc", "#007fd4"],
  "--color-ring-success": ["#73c991", "#73c991"],
  "--color-ring-warning": ["#b69500", "#b89500"],
  "--color-text-danger": ["#ad0707", "#f48771"],
  "--color-text-disabled": ["#bbbbbb", "rgba(204, 204, 204, 0.5)"],
  "--color-text-ghost": ["#606060", "rgba(204, 204, 204, 0.7)"],
  "--color-text-info": ["#0069cc", "#3794ff"],
  "--color-text-inverse": ["#ffffff", "#1e1e1e"],
  "--color-text-primary": ["#202020", "#cccccc"],
  "--color-text-secondary": ["#606060", "rgba(204, 204, 204, 0.7)"],
  "--color-text-success": ["#73c991", "#73c991"],
  "--color-text-tertiary": ["#bbbbbb", "rgba(204, 204, 204, 0.5)"],
  "--color-text-warning": ["#bf8803", "#cca700"],
  "--font-heading-2xl-line-height": ["1.25", "1.25"],
  "--font-heading-2xl-size": ["40px", "40px"],
  "--font-heading-3xl-line-height": ["1.25", "1.25"],
  "--font-heading-3xl-size": ["48px", "48px"],
  "--font-heading-lg-line-height": ["1.25", "1.25"],
  "--font-heading-lg-size": ["24px", "24px"],
  "--font-heading-md-line-height": ["1.25", "1.25"],
  "--font-heading-md-size": ["20px", "20px"],
  "--font-heading-sm-line-height": ["1.25", "1.25"],
  "--font-heading-sm-size": ["18px", "18px"],
  "--font-heading-xl-line-height": ["1.25", "1.25"],
  "--font-heading-xl-size": ["32px", "32px"],
  "--font-heading-xs-line-height": ["1.25", "1.25"],
  "--font-heading-xs-size": ["16px", "16px"],
  "--font-mono": [
    "Menlo, Monaco, 'Courier New', monospace",
    "Menlo, Monaco, 'Courier New', monospace",
  ],
  "--font-sans": [
    "-apple-system, BlinkMacSystemFont, sans-serif",
    "-apple-system, BlinkMacSystemFont, sans-serif",
  ],
  "--font-text-lg-line-height": ["1.5", "1.5"],
  "--font-text-lg-size": ["14px", "14px"],
  "--font-text-md-line-height": ["1.5", "1.5"],
  "--font-text-md-size": ["13px", "13px"],
  "--font-text-sm-line-height": ["1.5", "1.5"],
  "--font-text-sm-size": ["11px", "11px"],
  "--font-text-xs-line-height": ["1.5", "1.5"],
  "--font-text-xs-size": ["10px", "10px"],
  "--font-weight-bold": ["bold", "bold"],
  "--font-weight-medium": ["500", "500"],
  "--font-weight-normal": ["normal", "normal"],
  "--font-weight-semibold": ["600", "600"],
  "--shadow-hairline": [
    "0 0 0 1px rgba(0, 0, 0, 0)",
    "0 0 0 1px rgba(0, 0, 0, 0.36)",
  ],
  "--shadow-lg": [
    "0 10px 15px -3px rgba(0, 0, 0, 0)",
    "0 10px 15px -3px rgba(0, 0, 0, 0.36)",
  ],
  "--shadow-md": [
    "0 4px 6px -1px rgba(0, 0, 0, 0)",
    "0 4px 6px -1px rgba(0, 0, 0, 0.36)",
  ],
  "--shadow-sm": [
    "0 1px 2px 0 rgba(0, 0, 0, 0)",
    "0 1px 2px 0 rgba(0, 0, 0, 0.36)",
  ],
};

export function getVscodeStyleVariables(
  theme: "light" | "dark"
): Record<string, string> {
  const index = theme === "light" ? 0 : 1;
  return Object.fromEntries(
    Object.entries(VSCODE_LIGHT_DARK_VARS).map(([key, values]) => [
      key,
      values[index],
    ])
  );
}

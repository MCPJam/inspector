/**
 * Slackbot MCP Apps host style variables — Node-safe copy.
 *
 * Captured from Slackbot's `ui/initialize.hostContext.styles` on 2026-06-24.
 * Light and dark maps are both real Slackbot captures from the same probe app.
 */

const SLACK_SHARED_STYLE_VARIABLES: Record<string, string> = {
  "--color-background-ghost": "transparent",
  "--color-text-ghost": "transparent",
  "--color-border-ghost": "transparent",
  "--font-sans": '"Slack-Lato", "Slack-Fractions", "appleLogo", sans-serif',
  "--font-mono": '"Monaco", "Menlo", "Consolas", "Courier New", monospace',
  "--font-weight-normal": "400",
  "--font-weight-medium": "500",
  "--font-weight-semibold": "600",
  "--font-weight-bold": "700",
  "--font-text-xs-size": "12px",
  "--font-text-sm-size": "13px",
  "--font-text-md-size": "15px",
  "--font-text-lg-size": "18px",
  "--font-heading-xs-size": "18px",
  "--font-heading-sm-size": "22px",
  "--font-heading-md-size": "28px",
  "--font-heading-lg-size": "32px",
  "--font-heading-xl-size": "36px",
  "--font-heading-2xl-size": "42px",
  "--font-heading-3xl-size": "48px",
  "--font-text-xs-line-height": "1.25",
  "--font-text-sm-line-height": "1.25",
  "--font-text-md-line-height": "1.5",
  "--font-text-lg-line-height": "1.5",
  "--font-heading-xs-line-height": "1.25",
  "--font-heading-sm-line-height": "1.25",
  "--font-heading-md-line-height": "1.25",
  "--font-heading-lg-line-height": "1.25",
  "--font-heading-xl-line-height": "1.2",
  "--font-heading-2xl-line-height": "1.2",
  "--font-heading-3xl-line-height": "1.15",
  "--border-radius-xs": "0px",
  "--border-radius-sm": "2px",
  "--border-radius-md": "4px",
  "--border-radius-lg": "8px",
  "--border-radius-xl": "12px",
  "--border-radius-full": "9999px",
  "--border-width-regular": "1px",
  "--shadow-hairline": "0 0 0 1px currentColor",
  "--shadow-sm": "0 1px 2px 0 #0000000c",
  "--shadow-md": "0 2px 4px -2px #00000019, 0 4px 6px -1px #00000019",
  "--shadow-lg": "0 4px 6px -4px #00000019, 0 10px 15px -3px #00000019",
};

export const SLACK_LIGHT_STYLE_VARIABLES: Record<string, string> = {
  "--color-background-primary": "#fff",
  "--color-background-secondary": "#f8f8f8",
  "--color-background-tertiary": "#eaeaea",
  "--color-background-inverse": "#1d1c1d",
  "--color-background-info": "#e3f8ff",
  "--color-background-danger": "#ffe8ef",
  "--color-background-success": "#e3fff3",
  "--color-background-warning": "#fffae0",
  "--color-background-disabled": "#1d1c1d0f",
  "--color-text-primary": "#1d1c1d",
  "--color-text-secondary": "#454447",
  "--color-text-tertiary": "#5e5d60",
  "--color-text-inverse": "#fff",
  "--color-text-info": "#1264a3",
  "--color-text-danger": "#c01343",
  "--color-text-success": "#007a5a",
  "--color-text-warning": "#6b5000",
  "--color-text-disabled": "#5e5d60",
  "--color-border-primary": "#7c7a7f",
  "--color-border-secondary": "#5e5d6073",
  "--color-border-tertiary": "#5e5d6021",
  "--color-border-inverse": "#f8f8f8d9",
  "--color-border-info": "#1264a3",
  "--color-border-danger": "#e01e5a",
  "--color-border-success": "#007a5a",
  "--color-border-warning": "#c79600",
  "--color-border-disabled": "#5e5d6021",
  "--color-ring-primary": "#7c7a7f",
  "--color-ring-secondary": "#5e5d6073",
  "--color-ring-inverse": "#f8f8f8d9",
  "--color-ring-info": "#1264a3",
  "--color-ring-danger": "#e01e5a",
  "--color-ring-success": "#007a5a",
  "--color-ring-warning": "#c79600",
  ...SLACK_SHARED_STYLE_VARIABLES,
};

export const SLACK_DARK_STYLE_VARIABLES: Record<string, string> = {
  "--color-background-primary": "#1a1d21",
  "--color-background-secondary": "#1a1d21",
  "--color-background-tertiary": "#212428",
  "--color-background-inverse": "#212428",
  "--color-background-info": "#001a2d",
  "--color-background-danger": "#300005",
  "--color-background-success": "#05241b",
  "--color-background-warning": "#2f1e00",
  "--color-background-disabled": "#f8f8f80f",
  "--color-text-primary": "#f8f8f8",
  "--color-text-secondary": "#b9babd",
  "--color-text-tertiary": "#9a9b9e",
  "--color-text-inverse": "#f8f8f8",
  "--color-text-info": "#2ba5ce",
  "--color-text-danger": "#de678a",
  "--color-text-success": "#3daa7c",
  "--color-text-warning": "#dea700",
  "--color-text-disabled": "#9a9b9e",
  "--color-border-primary": "#797c81",
  "--color-border-secondary": "#797c8180",
  "--color-border-tertiary": "#797c814d",
  "--color-border-inverse": "#797c81",
  "--color-border-info": "#2ba5ce",
  "--color-border-danger": "#d94c75",
  "--color-border-success": "#259b69",
  "--color-border-warning": "#d29c00",
  "--color-border-disabled": "#797c814d",
  "--color-ring-primary": "#797c81",
  "--color-ring-secondary": "#797c8180",
  "--color-ring-inverse": "#797c81",
  "--color-ring-info": "#2ba5ce",
  "--color-ring-danger": "#d94c75",
  "--color-ring-success": "#259b69",
  "--color-ring-warning": "#d29c00",
  ...SLACK_SHARED_STYLE_VARIABLES,
};

export function getSlackStyleVariables(
  theme: "light" | "dark"
): Record<string, string> {
  return {
    ...(theme === "light"
      ? SLACK_LIGHT_STYLE_VARIABLES
      : SLACK_DARK_STYLE_VARIABLES),
  };
}

export const SLACK_FONT_CSS =
  'body { font-family: "Slack-Lato", "Slack-Fractions", "appleLogo", sans-serif; }';

export const SLACK_PLATFORM = "web" as const;

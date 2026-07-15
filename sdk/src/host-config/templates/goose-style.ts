/**
 * Goose Desktop host context — Node-safe copy.
 *
 * Captured from Goose Desktop 1.38.0 on 2026-06-19. Goose renders MCP Apps
 * through `ui/initialize`, advertises the MCP UI extension at the base MCP
 * layer, and sends a Cash Sans themed HostContext. The raw hostContext
 * variables use CSS `light-dark()`, but MCPJam's own host chrome needs
 * concrete values so it does not depend on ambient `color-scheme`.
 */

export const GOOSE_PLATFORM = "desktop" as const;

const GOOSE_LIGHT_DARK_STYLE_VARIABLES: Record<
  string,
  [light: string, dark: string]
> = {
  "--color-background-primary": ["#ffffff", "#22252a"],
  "--color-background-secondary": ["#f4f6f7", "#3f434b"],
  "--color-background-tertiary": ["#e3e6ea", "#474e57"],
  "--color-background-inverse": ["#000000", "#cbd1d6"],
  "--color-background-ghost": ["transparent", "transparent"],
  "--color-background-info": ["#5c98f9", "#7cacff"],
  "--color-background-danger": ["#f94b4b", "#ff6b6b"],
  "--color-background-success": ["#91cb80", "#a3d795"],
  "--color-background-warning": ["#fbcd44", "#ffd966"],
  "--color-background-disabled": ["#e3e6ea", "#474e57"],
  "--color-text-primary": ["#3f434b", "#ffffff"],
  "--color-text-secondary": ["#878787", "#878787"],
  "--color-text-tertiary": ["#a7b0b9", "#606c7a"],
  "--color-text-inverse": ["#ffffff", "#000000"],
  "--color-text-ghost": ["#878787", "#878787"],
  "--color-text-info": ["#5c98f9", "#7cacff"],
  "--color-text-danger": ["#f94b4b", "#ff6b6b"],
  "--color-text-success": ["#91cb80", "#a3d795"],
  "--color-text-warning": ["#fbcd44", "#ffd966"],
  "--color-text-disabled": ["#cbd1d6", "#525b68"],
  "--color-border-primary": ["#e3e6ea", "#3f434b"],
  "--color-border-secondary": ["#e3e6ea", "#525b68"],
  "--color-border-tertiary": ["#cbd1d6", "#474e57"],
  "--color-border-inverse": ["#000000", "#ffffff"],
  "--color-border-ghost": ["transparent", "transparent"],
  "--color-border-info": ["#5c98f9", "#7cacff"],
  "--color-border-danger": ["#f94b4b", "#ff6b6b"],
  "--color-border-success": ["#91cb80", "#a3d795"],
  "--color-border-warning": ["#fbcd44", "#ffd966"],
  "--color-border-disabled": ["#e3e6ea", "#3f434b"],
  "--color-ring-primary": ["#e3e6ea", "#525b68"],
  "--color-ring-secondary": ["#cbd1d6", "#474e57"],
  "--color-ring-inverse": ["#ffffff", "#000000"],
  "--color-ring-info": ["#5c98f9", "#7cacff"],
  "--color-ring-danger": ["#f94b4b", "#ff6b6b"],
  "--color-ring-success": ["#91cb80", "#a3d795"],
  "--color-ring-warning": ["#fbcd44", "#ffd966"],
};

const GOOSE_STATIC_STYLE_VARIABLES: Record<string, string> = {
  "--font-sans": "'Cash Sans', sans-serif",
  "--font-mono": "monospace",
  "--font-weight-normal": "400",
  "--font-weight-medium": "500",
  "--font-weight-semibold": "600",
  "--font-weight-bold": "700",
  "--font-text-xs-size": "0.75rem",
  "--font-text-sm-size": "0.875rem",
  "--font-text-md-size": "1rem",
  "--font-text-lg-size": "1.125rem",
  "--font-heading-xs-size": "1rem",
  "--font-heading-sm-size": "1.125rem",
  "--font-heading-md-size": "1.25rem",
  "--font-heading-lg-size": "1.5rem",
  "--font-heading-xl-size": "1.875rem",
  "--font-heading-2xl-size": "2.25rem",
  "--font-heading-3xl-size": "3rem",
  "--font-text-xs-line-height": "1rem",
  "--font-text-sm-line-height": "1.25rem",
  "--font-text-md-line-height": "1.5rem",
  "--font-text-lg-line-height": "1.75rem",
  "--font-heading-xs-line-height": "1.5rem",
  "--font-heading-sm-line-height": "1.75rem",
  "--font-heading-md-line-height": "1.75rem",
  "--font-heading-lg-line-height": "2rem",
  "--font-heading-xl-line-height": "2.25rem",
  "--font-heading-2xl-line-height": "2.5rem",
  "--font-heading-3xl-line-height": "3.5rem",
  "--border-radius-xs": "2px",
  "--border-radius-sm": "4px",
  "--border-radius-md": "8px",
  "--border-radius-lg": "12px",
  "--border-radius-xl": "16px",
  "--border-radius-full": "9999px",
  "--border-width-regular": "1px",
  "--shadow-hairline": "0 0 0 1px rgba(0, 0, 0, 0.05)",
  "--shadow-sm": "0 1px 2px 0 rgba(0, 0, 0, 0.05)",
  "--shadow-md":
    "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1)",
  "--shadow-lg":
    "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1)",
};

export const GOOSE_HOST_STYLE_VARIABLES: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(GOOSE_LIGHT_DARK_STYLE_VARIABLES).map(
      ([key, [light, dark]]) => [key, `light-dark(${light}, ${dark})`],
    ),
  ),
  ...GOOSE_STATIC_STYLE_VARIABLES,
};

export function getGooseStyleVariables(
  theme: "light" | "dark",
): Record<string, string> {
  const idx = theme === "light" ? 0 : 1;
  const resolved: Record<string, string> = {};
  for (const [key, [light, dark]] of Object.entries(
    GOOSE_LIGHT_DARK_STYLE_VARIABLES,
  )) {
    resolved[key] = idx === 0 ? light : dark;
  }
  return { ...resolved, ...GOOSE_STATIC_STYLE_VARIABLES };
}

export const GOOSE_FONT_CSS = `
@font-face {
  font-family: 'Cash Sans';
  src: url(https://cash-f.squarecdn.com/static/fonts/cashsans/woff2/CashSans-Light.woff2) format('woff2'),
       url(https://cash-f.squarecdn.com/static/fonts/cashsans/woff/CashSans-Light.woff) format('woff');
  font-weight: 300;
  font-style: normal;
}
@font-face {
  font-family: 'Cash Sans';
  src: url(https://cash-f.squarecdn.com/static/fonts/cashsans/woff2/CashSans-Regular.woff2) format('woff2'),
       url(https://cash-f.squarecdn.com/static/fonts/cashsans/woff/CashSans-Regular.woff) format('woff');
  font-weight: 400;
  font-style: normal;
}
@font-face {
  font-family: 'Cash Sans';
  src: url(https://cash-f.squarecdn.com/static/fonts/cashsans/woff2/CashSans-Medium.woff2) format('woff2'),
       url(https://cash-f.squarecdn.com/static/fonts/cashsans/woff/CashSans-Medium.woff) format('woff');
  font-weight: 500;
  font-style: normal;
}
@font-face {
  font-family: 'Cash Sans';
  src: url(https://cash-f.squarecdn.com/static/fonts/cashsans/woff2/CashSans-Bold.woff2) format('woff2'),
       url(https://cash-f.squarecdn.com/static/fonts/cashsans/woff/CashSans-Bold.woff) format('woff');
  font-weight: 700;
  font-style: normal;
}
`;

/**
 * Goose Desktop host context — Node-safe copy.
 *
 * Captured from Goose Desktop 1.38.0 on 2026-06-19. Goose renders MCP Apps
 * through `ui/initialize`, advertises the MCP UI extension at the base MCP
 * layer, and sends a Cash Sans themed HostContext. The style variables use
 * CSS `light-dark()`, so the returned map is the same for both inspector
 * theme modes.
 */

export const GOOSE_PLATFORM = "desktop" as const;

export const GOOSE_HOST_STYLE_VARIABLES: Record<string, string> = {
  "--color-background-primary": "light-dark(#ffffff, #22252a)",
  "--color-background-secondary": "light-dark(#f4f6f7, #3f434b)",
  "--color-background-tertiary": "light-dark(#e3e6ea, #474e57)",
  "--color-background-inverse": "light-dark(#000000, #cbd1d6)",
  "--color-background-ghost": "light-dark(transparent, transparent)",
  "--color-background-info": "light-dark(#5c98f9, #7cacff)",
  "--color-background-danger": "light-dark(#f94b4b, #ff6b6b)",
  "--color-background-success": "light-dark(#91cb80, #a3d795)",
  "--color-background-warning": "light-dark(#fbcd44, #ffd966)",
  "--color-background-disabled": "light-dark(#e3e6ea, #474e57)",
  "--color-text-primary": "light-dark(#3f434b, #ffffff)",
  "--color-text-secondary": "light-dark(#878787, #878787)",
  "--color-text-tertiary": "light-dark(#a7b0b9, #606c7a)",
  "--color-text-inverse": "light-dark(#ffffff, #000000)",
  "--color-text-ghost": "light-dark(#878787, #878787)",
  "--color-text-info": "light-dark(#5c98f9, #7cacff)",
  "--color-text-danger": "light-dark(#f94b4b, #ff6b6b)",
  "--color-text-success": "light-dark(#91cb80, #a3d795)",
  "--color-text-warning": "light-dark(#fbcd44, #ffd966)",
  "--color-text-disabled": "light-dark(#cbd1d6, #525b68)",
  "--color-border-primary": "light-dark(#e3e6ea, #3f434b)",
  "--color-border-secondary": "light-dark(#e3e6ea, #525b68)",
  "--color-border-tertiary": "light-dark(#cbd1d6, #474e57)",
  "--color-border-inverse": "light-dark(#000000, #ffffff)",
  "--color-border-ghost": "light-dark(transparent, transparent)",
  "--color-border-info": "light-dark(#5c98f9, #7cacff)",
  "--color-border-danger": "light-dark(#f94b4b, #ff6b6b)",
  "--color-border-success": "light-dark(#91cb80, #a3d795)",
  "--color-border-warning": "light-dark(#fbcd44, #ffd966)",
  "--color-border-disabled": "light-dark(#e3e6ea, #3f434b)",
  "--color-ring-primary": "light-dark(#e3e6ea, #525b68)",
  "--color-ring-secondary": "light-dark(#cbd1d6, #474e57)",
  "--color-ring-inverse": "light-dark(#ffffff, #000000)",
  "--color-ring-info": "light-dark(#5c98f9, #7cacff)",
  "--color-ring-danger": "light-dark(#f94b4b, #ff6b6b)",
  "--color-ring-success": "light-dark(#91cb80, #a3d795)",
  "--color-ring-warning": "light-dark(#fbcd44, #ffd966)",
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

export function getGooseStyleVariables(
  _theme: "light" | "dark",
): Record<string, string> {
  return { ...GOOSE_HOST_STYLE_VARIABLES };
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

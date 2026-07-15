/**
 * MCPJam host context — the inspector's own house chrome (Node-safe copy).
 *
 * Verbatim port of the style-variable maps from the inspector client's
 * `client/src/config/mcpjam-client-context.ts`. Lives in the SDK so the
 * host-template seeds (`seed-host-template.ts`) can run in Node (the server's
 * `--template` resolver) without importing browser-only client modules. The
 * client re-exports `getMcpJamStyleVariables` / `MCPJAM_FONT_CSS` /
 * `MCPJAM_PLATFORM` from here so there is a single source of truth; the
 * client keeps `MCPJAM_CHAT_BACKGROUND` (not needed by seeding) local.
 *
 * Values mirror `design-system/src/tokens.css` (the `@mcpjam/design-system`
 * package). Keep this in sync with the design system the same way the client
 * module did.
 */

export const MCPJAM_PLATFORM = "web" as const;

const MCPJAM_LIGHT_DARK_VARS: Record<
  string,
  [light: string, dark: string]
> = {
  // Surfaces — mirror design-system --background, --card, --popover, --accent.
  "--color-background-primary": [
    "oklch(0.9818 0.0054 95.0986)",
    "oklch(0.2679 0.0036 106.6427)",
  ],
  "--color-background-secondary": [
    "oklch(0.9341 0.0153 90.239)",
    "oklch(0.2213 0.0038 106.707)",
  ],
  "--color-background-tertiary": [
    "oklch(0.9245 0.0138 92.9892)",
    "oklch(0.213 0.0078 95.4245)",
  ],
  "--color-background-inverse": [
    "oklch(0.2679 0.0036 106.6427)",
    "oklch(0.9818 0.0054 95.0986)",
  ],
  "--color-background-ghost": [
    "oklch(0.9818 0.0054 95.0986 / 0)",
    "oklch(0.2679 0.0036 106.6427 / 0)",
  ],
  // Status background tints — kept on the design-system semantic palette
  // so MCP Apps widgets reading these match the inspector's info/danger/
  // success/warning surfaces.
  "--color-background-info": ["oklch(0.93 0.04 259)", "oklch(0.28 0.06 259)"],
  "--color-background-danger": [
    "oklch(0.94 0.04 25.331)",
    "oklch(0.32 0.08 25.331)",
  ],
  "--color-background-success": ["oklch(0.94 0.05 152.5)", "oklch(0.3 0.07 152)"],
  "--color-background-warning": [
    "oklch(0.95 0.06 85.3)",
    "oklch(0.3 0.09 55)",
  ],
  "--color-background-disabled": [
    "oklch(0.9818 0.0054 95.0986 / 0.5)",
    "oklch(0.2679 0.0036 106.6427 / 0.5)",
  ],
  // Text — mirror design-system --foreground / --muted-foreground.
  "--color-text-primary": [
    "oklch(0.3438 0.0269 95.7226)",
    "oklch(0.8074 0.0142 93.0137)",
  ],
  "--color-text-secondary": [
    "oklch(0.6059 0.0075 97.4233)",
    "oklch(0.7713 0.0169 99.0657)",
  ],
  "--color-text-tertiary": [
    "oklch(0.4334 0.0177 98.6048)",
    "oklch(0.7713 0.0169 99.0657 / 0.8)",
  ],
  "--color-text-inverse": [
    "oklch(1 0 0)",
    "oklch(0.2679 0.0036 106.6427)",
  ],
  "--color-text-ghost": [
    "oklch(0.6059 0.0075 97.4233 / 0.5)",
    "oklch(0.7713 0.0169 99.0657 / 0.5)",
  ],
  "--color-text-info": ["oklch(0.623 0.214 259)", "oklch(0.7 0.18 259)"],
  "--color-text-danger": ["oklch(0.627 0.208 25.331)", "oklch(0.74 0.18 25.331)"],
  "--color-text-success": ["oklch(0.696 0.17 152.5)", "oklch(0.78 0.16 152)"],
  "--color-text-warning": ["oklch(0.769 0.188 85.3)", "oklch(0.83 0.17 85.3)"],
  "--color-text-disabled": [
    "oklch(0.3438 0.0269 95.7226 / 0.5)",
    "oklch(0.8074 0.0142 93.0137 / 0.5)",
  ],
  // Borders — mirror design-system --border / --input.
  "--color-border-primary": [
    "oklch(0.7621 0.0156 98.3528)",
    "oklch(0.4336 0.0113 100.2195)",
  ],
  "--color-border-secondary": [
    "oklch(0.8847 0.0069 97.3627)",
    "oklch(0.3618 0.0101 106.8928)",
  ],
  "--color-border-tertiary": [
    "oklch(0.8847 0.0069 97.3627 / 0.6)",
    "oklch(0.3618 0.0101 106.8928 / 0.6)",
  ],
  "--color-border-inverse": [
    "oklch(1 0 0 / 0.3)",
    "oklch(0.2679 0.0036 106.6427 / 0.15)",
  ],
  "--color-border-ghost": [
    "oklch(0.8847 0.0069 97.3627 / 0)",
    "oklch(0.3618 0.0101 106.8928 / 0)",
  ],
  "--color-border-info": ["oklch(0.623 0.214 259)", "oklch(0.7 0.18 259)"],
  "--color-border-danger": ["oklch(0.627 0.208 25.331)", "oklch(0.74 0.18 25.331)"],
  "--color-border-success": ["oklch(0.696 0.17 152.5)", "oklch(0.78 0.16 152)"],
  // `--color-border-warning` is the source `getChatboxShellStyle` reads
  // to produce shadcn `--primary` for the claude visual family. We pipe
  // MCPJam's brand orange here so primary surfaces (Add Server button,
  // host accent pills, etc.) carry MCPJam orange when the previewed host
  // is MCPJam.
  "--color-border-warning": [
    "oklch(0.6832 0.1382 38.744)",
    "oklch(0.6724 0.1308 38.7559)",
  ],
  "--color-border-disabled": [
    "oklch(0.7621 0.0156 98.3528 / 0.4)",
    "oklch(0.4336 0.0113 100.2195 / 0.4)",
  ],
  // Rings — mirror design-system --ring (MCPJam orange).
  "--color-ring-primary": [
    "oklch(0.6171 0.1375 39.0427)",
    "oklch(0.6724 0.1308 38.7559)",
  ],
  "--color-ring-secondary": [
    "oklch(0.6059 0.0075 97.4233 / 0.5)",
    "oklch(0.7713 0.0169 99.0657 / 0.5)",
  ],
  "--color-ring-inverse": [
    "oklch(1 0 0 / 0.7)",
    "oklch(0.2679 0.0036 106.6427 / 0.7)",
  ],
  "--color-ring-info": ["oklch(0.623 0.214 259 / 0.5)", "oklch(0.7 0.18 259 / 0.5)"],
  "--color-ring-danger": [
    "oklch(0.627 0.208 25.331 / 0.5)",
    "oklch(0.74 0.18 25.331 / 0.5)",
  ],
  "--color-ring-success": [
    "oklch(0.696 0.17 152.5 / 0.5)",
    "oklch(0.78 0.16 152 / 0.5)",
  ],
  "--color-ring-warning": [
    "oklch(0.769 0.188 85.3 / 0.5)",
    "oklch(0.83 0.17 85.3 / 0.5)",
  ],
};

// Typography mirrors design-system tokens.css --font-sans / --font-mono.
const MCPJAM_STATIC_VARS: Record<string, string> = {
  "--font-sans":
    'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"',
  "--font-mono":
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  "--font-weight-normal": "400",
  "--font-weight-medium": "500",
  "--font-weight-semibold": "600",
  "--font-weight-bold": "700",
  "--font-text-xs-size": "12px",
  "--font-text-sm-size": "14px",
  "--font-text-md-size": "15px",
  "--font-text-lg-size": "18px",
  "--font-heading-xs-size": "12px",
  "--font-heading-sm-size": "14px",
  "--font-heading-md-size": "16px",
  "--font-heading-lg-size": "20px",
  "--font-heading-xl-size": "24px",
  "--font-heading-2xl-size": "30px",
  "--font-heading-3xl-size": "36px",
  "--font-text-xs-line-height": "1.4",
  "--font-text-sm-line-height": "1.5",
  "--font-text-md-line-height": "1.5",
  "--font-text-lg-line-height": "1.4",
  "--font-heading-xs-line-height": "1.4",
  "--font-heading-sm-line-height": "1.4",
  "--font-heading-md-line-height": "1.3",
  "--font-heading-lg-line-height": "1.25",
  "--font-heading-xl-line-height": "1.2",
  "--font-heading-2xl-line-height": "1.15",
  "--font-heading-3xl-line-height": "1.1",
  // Radius — design-system uses --radius: 0.5rem (8px) as the canonical
  // size; xs/sm/lg/xl interpolate around it.
  "--border-radius-xs": "4px",
  "--border-radius-sm": "6px",
  "--border-radius-md": "8px",
  "--border-radius-lg": "10px",
  "--border-radius-xl": "12px",
  "--border-radius-full": "9999px",
  "--border-width-regular": "1px",
  "--shadow-hairline": "0 1px 2px 0 rgba(0, 0, 0, 0.04)",
  "--shadow-sm":
    "0 1px 2px 0 rgba(0, 0, 0, 0.06), 0 1px 3px 0 rgba(0, 0, 0, 0.04)",
  "--shadow-md":
    "0 4px 6px -1px rgba(0, 0, 0, 0.08), 0 2px 4px -2px rgba(0, 0, 0, 0.06)",
  "--shadow-lg":
    "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.05)",
};

export function getMcpJamStyleVariables(
  theme: "light" | "dark",
): Record<string, string> {
  const idx = theme === "light" ? 0 : 1;
  const resolved: Record<string, string> = {};
  for (const [key, [light, dark]] of Object.entries(MCPJAM_LIGHT_DARK_VARS)) {
    resolved[key] = idx === 0 ? light : dark;
  }
  return { ...resolved, ...MCPJAM_STATIC_VARS };
}

// No external font URLs; --font-sans is the system stack above.
export const MCPJAM_FONT_CSS = ``;

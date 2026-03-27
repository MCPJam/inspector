import type { CSSProperties } from "react";

type ResolvedThemeMode = "light" | "dark";

type AppThemeScopeStyle = CSSProperties & Record<`--${string}`, string>;

const DEFAULT_APP_THEME_SCOPE_TOKENS: Record<
  ResolvedThemeMode,
  Record<`--${string}`, string>
> = {
  light: {
    "--background": "oklch(0.9818 0.0054 95.0986)",
    "--foreground": "oklch(0.3438 0.0269 95.7226)",
    "--card": "oklch(0.9818 0.0054 95.0986)",
    "--card-foreground": "oklch(0.1908 0.002 106.5859)",
    "--popover": "oklch(1 0 0)",
    "--popover-foreground": "oklch(0.2671 0.0196 98.939)",
    "--primary": "oklch(0.6832 0.1382 38.744)",
    "--primary-foreground": "oklch(1 0 0)",
    "--secondary": "oklch(0.9245 0.0138 92.9892)",
    "--secondary-foreground": "oklch(0.4334 0.0177 98.6048)",
    "--muted": "oklch(0.9341 0.0153 90.239)",
    "--muted-foreground": "oklch(0.6059 0.0075 97.4233)",
    "--accent": "oklch(0.9245 0.0138 92.9892)",
    "--accent-foreground": "oklch(0.2671 0.0196 98.939)",
    "--destructive": "oklch(0.55 0.22 27)",
    "--destructive-foreground": "oklch(0.25 0.1 25)",
    "--border": "oklch(0.8847 0.0069 97.3627)",
    "--input": "oklch(0.7621 0.0156 98.3528)",
    "--ring": "oklch(0.6171 0.1375 39.0427)",
    "--success": "oklch(0.696 0.17 152.5)",
    "--success-foreground": "oklch(1 0 0)",
    "--warning": "oklch(0.769 0.188 85.3)",
    "--warning-foreground": "oklch(0.239 0.06 60)",
    "--info": "oklch(0.623 0.214 259)",
    "--info-foreground": "oklch(1 0 0)",
    "--pending": "oklch(0.769 0.188 85.3)",
    "--pending-foreground": "oklch(0.239 0.06 60)",
  },
  dark: {
    "--background": "oklch(0.2679 0.0036 106.6427)",
    "--foreground": "oklch(0.8074 0.0142 93.0137)",
    "--card": "oklch(0.2679 0.0036 106.6427)",
    "--card-foreground": "oklch(0.9818 0.0054 95.0986)",
    "--popover": "oklch(0.3085 0.0035 106.6039)",
    "--popover-foreground": "oklch(0.9211 0.004 106.4781)",
    "--primary": "oklch(0.6724 0.1308 38.7559)",
    "--primary-foreground": "oklch(1 0 0)",
    "--secondary": "oklch(0.9818 0.0054 95.0986)",
    "--secondary-foreground": "oklch(0.3085 0.0035 106.6039)",
    "--muted": "oklch(0.2213 0.0038 106.707)",
    "--muted-foreground": "oklch(0.7713 0.0169 99.0657)",
    "--accent": "oklch(0.213 0.0078 95.4245)",
    "--accent-foreground": "oklch(0.9663 0.008 98.8792)",
    "--destructive": "oklch(0.6368 0.2078 25.3313)",
    "--destructive-foreground": "oklch(1 0 0)",
    "--border": "oklch(0.3618 0.0101 106.8928)",
    "--input": "oklch(0.4336 0.0113 100.2195)",
    "--ring": "oklch(0.6724 0.1308 38.7559)",
    "--success": "oklch(0.648 0.15 152)",
    "--success-foreground": "oklch(1 0 0)",
    "--warning": "oklch(0.75 0.183 55)",
    "--warning-foreground": "oklch(0.95 0.06 70)",
    "--info": "oklch(0.623 0.214 259)",
    "--info-foreground": "oklch(1 0 0)",
    "--pending": "oklch(0.75 0.183 55)",
    "--pending-foreground": "oklch(0.95 0.06 70)",
  },
};

export function getDefaultAppThemeScopeStyle(
  themeMode: ResolvedThemeMode,
): CSSProperties {
  return DEFAULT_APP_THEME_SCOPE_TOKENS[themeMode] as AppThemeScopeStyle;
}

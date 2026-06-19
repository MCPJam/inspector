import type { McpUiStyles } from "@modelcontextprotocol/ext-apps/app-bridge";

export const MISTRAL_PLATFORM = "web" as const;

// Dark values are captured from Le Chat's
// `ui/notifications/host-context-changed` payload on 2026-06-16. Light
// values mirror the same semantic slots so Mistral hosts follow MCPJam's
// global theme like the other built-in hosts.
const MISTRAL_LIGHT_DARK_VARS: Record<
  string,
  [light: string, dark: string]
> = {
  "--color-background-primary": ["#fff", "#111115"],
  "--color-background-secondary": ["#f7f7f8", "#18181b"],
  "--color-background-tertiary": ["#f0f0f2", "#09090b"],
  "--color-background-inverse": ["#111115", "#fff"],
  "--color-text-primary": ["#111115", "#fff"],
  "--color-text-secondary": ["#4f4f57", "#ffffffb2"],
  "--color-text-tertiary": ["#6f6f78", "#ffffff7f"],
  "--color-text-inverse": ["#fff", "#111115"],
  "--color-text-info": ["#0072ce", "#48bfff"],
  "--color-text-danger": ["#d92d20", "#ff5d59"],
  "--color-text-success": ["#2e7d32", "#7af526"],
  "--color-text-warning": ["#b85c00", "#fc783b"],
  "--color-border-primary": ["#00000019", "#ffffff19"],
  "--color-border-secondary": ["#00000026", "#ffffff26"],
  "--color-border-tertiary": ["#0000003f", "#ffffff3f"],
  "--bg-badge-orange": ["#faeee7", "#53330f"],
  "--bg-basic-orange-strong": ["#c4290a", "#ff8a00"],
  "--bg-brand-500": ["#fa500e", "#fa500f"],
  "--text-white-default": ["#fff", "#fff"],
};

export function getMistralStyleVariables(
  theme: "light" | "dark",
): McpUiStyles {
  const idx = theme === "light" ? 0 : 1;
  const resolved: Record<string, string> = {};
  for (const [key, [light, dark]] of Object.entries(MISTRAL_LIGHT_DARK_VARS)) {
    resolved[key] = idx === 0 ? light : dark;
  }
  return resolved as McpUiStyles;
}

export const MISTRAL_CHAT_BACKGROUND = {
  light: "#fff",
  dark: "#111115",
};

export const MISTRAL_FONT_CSS = ``;

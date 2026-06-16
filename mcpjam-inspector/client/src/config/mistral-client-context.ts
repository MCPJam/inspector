import type { McpUiStyles } from "@modelcontextprotocol/ext-apps/app-bridge";

export const MISTRAL_PLATFORM = "web" as const;

// Captured from Le Chat's `ui/notifications/host-context-changed`
// payload on 2026-06-16. Only a dark-theme capture is available today,
// so both theme branches return this exact token set instead of guessing
// a light palette.
export const MISTRAL_STYLE_VARIABLES: Record<string, string> = {
  "--color-background-primary": "#111115",
  "--color-background-secondary": "#18181b",
  "--color-background-tertiary": "#09090b",
  "--color-background-inverse": "#fff",
  "--color-text-primary": "#fff",
  "--color-text-secondary": "#ffffffb2",
  "--color-text-tertiary": "#ffffff7f",
  "--color-text-inverse": "#111115",
  "--color-text-info": "#48bfff",
  "--color-text-danger": "#ff5d59",
  "--color-text-success": "#7af526",
  "--color-text-warning": "#fc783b",
  "--color-border-primary": "#ffffff19",
  "--color-border-secondary": "#ffffff26",
  "--color-border-tertiary": "#ffffff3f",
  "--bg-badge-orange": "#53330f",
  "--bg-basic-orange-strong": "#ff8a00",
  "--bg-brand-500": "#ff8a00",
  "--text-white-default": "#fff",
};

export function getMistralStyleVariables(
  _theme: "light" | "dark",
): McpUiStyles {
  return { ...MISTRAL_STYLE_VARIABLES } as McpUiStyles;
}

export const MISTRAL_CHAT_BACKGROUND = {
  light: "#111115",
  dark: "#111115",
};

export const MISTRAL_FONT_CSS = ``;

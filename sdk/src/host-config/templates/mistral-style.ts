/**
 * Mistral (Le Chat) host style variables — Node-safe copy.
 *
 * Verbatim port of `getMistralStyleVariables` + its var map from the inspector
 * client's `client/src/config/mistral-client-context.ts`, so the mistral
 * host-template seed can run in Node. The client re-exports
 * `getMistralStyleVariables` from here for a single source of truth.
 *
 * Both themes are captured from Le Chat's
 * `ui/notifications/host-context-changed` payload, re-probed 2026-09-02. The
 * light column used to be hand-mirrored from dark; it is now measured, which
 * is why every light value moved in that pass.
 *
 * That capture also dropped Le Chat's four proprietary keys
 * (`--bg-badge-orange`, `--bg-basic-orange-strong`, `--bg-brand-500`,
 * `--text-white-default`) — the only ones outside the MCP Apps key list — so
 * the surface is 15 keys, down from 19.
 */

const MISTRAL_LIGHT_DARK_VARS: Record<string, [light: string, dark: string]> = {
  "--color-background-primary": ["#fff", "#101013"],
  "--color-background-secondary": ["#fbfbf8", "#1a1a1e"],
  "--color-background-tertiary": ["#f5f4ef", "#27272b"],
  "--color-background-inverse": ["#1a1a1e", "#fff"],
  "--color-text-primary": ["#201f1c", "#fff"],
  "--color-text-secondary": ["#615f57", "#ccccd1"],
  "--color-text-tertiary": ["#928f86", "#a1a1aa"],
  "--color-text-inverse": ["#fff", "#101013"],
  "--color-text-info": ["#0082e6", "#55b3fb"],
  "--color-text-danger": ["#e51300", "#f66c60"],
  "--color-text-success": ["#3aa475", "#44ba82"],
  "--color-text-warning": ["#de4408", "#ff6529"],
  "--color-border-primary": ["#0000001a", "#ffffff1a"],
  "--color-border-secondary": ["#00000026", "#ffffff26"],
  "--color-border-tertiary": ["#00000040", "#ffffff40"],
};

export function getMistralStyleVariables(
  theme: "light" | "dark"
): Record<string, string> {
  const idx = theme === "light" ? 0 : 1;
  const resolved: Record<string, string> = {};
  for (const [key, [light, dark]] of Object.entries(MISTRAL_LIGHT_DARK_VARS)) {
    resolved[key] = idx === 0 ? light : dark;
  }
  return resolved;
}

export const MISTRAL_FONT_CSS = ``;

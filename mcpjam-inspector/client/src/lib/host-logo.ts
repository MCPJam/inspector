import type { HostThemeMode } from "@/lib/client-styles";
import { resolveHostLogoByDisplayName } from "@/lib/scenario-client-style";
import { getHostLogoSrc, UNKNOWN_HOST_LOGO } from "@/lib/host-ui-metadata";

export { UNKNOWN_HOST_LOGO };

/**
 * Hosts don't persist which catalog template they came from, so a client's logo
 * has to be inferred from its display name.
 *
 * There were two inference strategies in the tree and they disagreed, which is
 * how the same custom client ended up with a different mark in each
 * single-select picker. Neither was a superset of the other:
 *
 * - The hint table places DECORATED names (`Cursor (staging)`), which an exact
 *   match cannot.
 * - The exact style-name pass places ids the hint table never listed (`codex`,
 *   `agentcore`, `n8n`).
 *
 * So this runs hints first — preserving what the canvas selector already
 * rendered for every name it covered — then the exact pass, then the generic MCP
 * mark. That mark is never wrong, just anonymous, which beats an empty circle.
 */
const LOGO_NAME_HINTS: Array<[RegExp, string]> = [
  [/mcpjam/i, "mcpjam"],
  [/claude[ -]?code/i, "claude-code"],
  [/claude/i, "claude"],
  [/chatgpt|openai/i, "chatgpt"],
  [/copilot/i, "copilot"],
  // BEFORE the bare /cursor/i, same ordering trap as claude-code above: a host
  // named "Cursor CLI" must resolve to the `cursor-cli` id, not to `cursor`.
  // The two happen to share a logo file today, so this is about the resolved ID
  // being right (theme-keyed lookups and anything else that keys off it), not
  // about the pixels.
  [/cursor[ -]?cli/i, "cursor-cli"],
  [/cursor/i, "cursor"],
  [/vs ?code/i, "vscode"],
  [/goose/i, "goose"],
  [/cline/i, "cline"],
  [/perplexity/i, "perplexity"],
  [/notion/i, "notion"],
  [/slack/i, "slack"],
  [/mistral/i, "mistral"],
];

export function resolveHostLogoByName(
  name: string,
  themeMode?: HostThemeMode | null,
): string {
  for (const [pattern, hostId] of LOGO_NAME_HINTS) {
    if (pattern.test(name)) return getHostLogoSrc(hostId, themeMode);
  }
  return resolveHostLogoByDisplayName(name, themeMode) ?? UNKNOWN_HOST_LOGO;
}

/**
 * VS Code host context — captured from a real Visual Studio Code 1.121.0
 * host probe.
 *
 * VS Code DOES publish a full `hostContext.styles.variables` block, but
 * every token is an indirection into VS Code's own theme vars (e.g.
 * `--color-background-primary: var(--vscode-editor-background)`). Those
 * `--vscode-*` vars only exist inside a real VS Code webview, so they
 * can't drive the inspector's own chrome. The faithful var-map is shipped
 * to widgets verbatim from the template's `hostContext.styles.variables`
 * (see `VSCODE_HOST_STYLE_VARIABLES` in `client-templates.ts`); here we
 * reuse ChatGPT's concrete neutral-gray IDE palette for the inspector
 * shell, exactly as the Cursor style does.
 *
 * Verified facts (from probe):
 *   - clientInfo.name / hostInfo.name: "Visual Studio Code", version "1.121.0"
 *   - protocolVersion: "2026-01-26"
 *   - platform: "desktop"
 *   - displayMode: "inline" (only)
 *   - window.openai: absent (pure MCP Apps host — no OpenAI SDK shim)
 *   - hostCapabilities: openLinks, serverTools (listChanged: true),
 *       serverResources (listChanged: true), logging, updateModelContext
 *       (audio/image/resourceLink/resource/structuredContent), downloadFile
 *       — NO message
 */

import type { McpUiStyles } from "@modelcontextprotocol/ext-apps/app-bridge";
import { getChatGPTStyleVariables } from "./chatgpt-client-context";

export const VSCODE_PLATFORM = "desktop" as const;

/**
 * VS Code's chat panel background. Mirrors VS Code's standard editor
 * surface (~#1e1e1e dark, white light). Independent from the widget token
 * set so we can iterate on it in isolation.
 */
export const VSCODE_CHAT_BACKGROUND = {
  light: "rgba(255, 255, 255, 1)",
  dark: "rgba(30, 30, 30, 1)",
};

// VS Code doesn't bundle custom @font-face — widgets inherit
// `var(--vscode-font-family)` (system + editor fonts). Leaving this empty
// means the iframe inherits the host's defaults.
export const VSCODE_FONT_CSS = ``;

/**
 * VS Code host style variables for the INSPECTOR shell. VS Code's real
 * published tokens are `var(--vscode-*)` indirections that don't resolve
 * outside a VS Code webview, so — like Cursor — reuse ChatGPT's resolved
 * neutral-gray palette here. (Widgets still receive VS Code's faithful
 * var-map via the template's `hostContext.styles.variables`.)
 */
export function getVSCodeStyleVariables(theme: "light" | "dark"): McpUiStyles {
  return getChatGPTStyleVariables(theme);
}

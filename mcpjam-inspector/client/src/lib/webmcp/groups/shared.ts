/**
 * Helpers shared by more than one tool group. Group-private helpers live in
 * their group's own module; only genuinely cross-group code belongs here.
 */

import { hasInspectorCommandHandler } from "@/lib/inspector-command-handlers";
import type { InspectorCommandType } from "@/shared/inspector-command.js";
import type { UiToolResult } from "../ui-tools-registry";
import { openPlaygroundAction, type UiActionResult } from "../ui-actions";

/** Keep serialized results well under context-bloating sizes. */
export const MAX_RESULT_CHARS = 16 * 1024;

export function clampText(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}… [truncated]`;
}

export function okResult(data: unknown): UiToolResult {
  let text: string;
  try {
    text = JSON.stringify(data === undefined ? { ok: true } : { ok: true, data });
  } catch {
    text = JSON.stringify({ ok: true, note: "Result was not serializable." });
  }
  return { content: [{ type: "text", text: clampText(text) }] };
}

export function errorResult(message: string): UiToolResult {
  return {
    content: [{ type: "text", text: clampText(message) }],
    isError: true,
  };
}

export function fromActionResult(result: UiActionResult): UiToolResult {
  return result.ok ? okResult(result.data) : errorResult(result.error);
}

export function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The playground-scoped command handlers only exist while the playground
 * surface is mounted (`usePlaygroundState` in `PlaygroundTab` on
 * `/playground`). Gate on the HANDLER being registered — not on UI store
 * flags, which track a different surface (`isPlaygroundActive` follows the
 * Views-tab preview) — and open the playground first when it is missing.
 * The bus's 2s late-registration wait bridges the mount after navigation.
 *
 * Cross-group on purpose: the playground group's mutating tools use it, and
 * so does core's `ui_set_app_context` (the emulated app context lives in the
 * playground store).
 */
export async function ensurePlaygroundOpen(
  commandType: InspectorCommandType,
  serverName?: string,
): Promise<UiToolResult | null> {
  if (hasInspectorCommandHandler(commandType)) return null;
  const opened = await openPlaygroundAction(serverName);
  if (!opened.ok) {
    return errorResult(`Could not open the playground first: ${opened.error}`);
  }
  return null;
}

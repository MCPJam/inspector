/**
 * Helpers shared by more than one tool group. Group-private helpers live in
 * their group's own module; only genuinely cross-group code belongs here.
 */

import { hasInspectorCommandHandler } from "@/lib/inspector-command-handlers";
import type { InspectorCommandType } from "@/shared/inspector-command.js";
import type {
  UiToolNativePublication,
  UiToolResult,
} from "../ui-tools-registry";
import { openPlaygroundAction, type UiActionResult } from "../ui-actions";
import { clampText, MAX_RESULT_CHARS } from "../bounded-size";

// --- Native publication (browser-native WebMCP agents) -----------------
//
// Every first-party definition states one of these. Shared constants rather
// than inline literals so the decision reads as a decision at each tool, and
// so the whole published set is one grep away.

/**
 * Publish this tool to browser-native WebMCP agents. Its result is MCPJam's
 * own reporting — a command outcome, a status, an id — so nothing in it came
 * from a third party.
 */
export const PUBLISH_NATIVE: UiToolNativePublication = {
  kind: "publish",
  untrustedContent: false,
};

/**
 * Publish, and say that the RESULT can carry somebody else's bytes: an MCP
 * server's tool output, a registry listing, an OAuth server's metadata, a
 * snapshot of a screen showing any of those. Chrome's guidance is to label
 * such payloads so an agent treats them as data rather than instructions
 * (https://developer.chrome.com/docs/ai/webmcp/secure-tools) — over-claiming
 * here is cheap, under-claiming is the failure that matters.
 */
export const PUBLISH_NATIVE_UNTRUSTED: UiToolNativePublication = {
  kind: "publish",
  untrustedContent: true,
};

/**
 * Keep this tool off the native surface, with the reason stated. Reserved for
 * tools whose meaning depends on an MCPJam conversation — there is no
 * conversation behind a native call, so publishing one would advertise a
 * capability that cannot work.
 */
export function nativeInternal(reason: string): UiToolNativePublication {
  return { kind: "internal", reason };
}

/**
 * Keep serialized results well under context-bloating sizes. Defined in
 * `bounded-size.ts` and re-exported here because both the builders below and
 * `ui-tool-execution.ts`'s backstop must clamp to the SAME number.
 */
export { MAX_RESULT_CHARS, clampText } from "../bounded-size";
// Stop serializing well before we've built a multi-megabyte string: a tool
// result can carry arbitrary provider content (e.g. a large resource read).
// The replacer throws once the running length passes this budget, so we never
// materialize the whole thing just to clamp it afterwards.
const SERIALIZE_BUDGET = MAX_RESULT_CHARS * 2;

/** JSON.stringify that aborts once it has emitted more than SERIALIZE_BUDGET. */
function budgetedStringify(value: unknown): string {
  let emitted = 0;
  const OVER = Symbol("over-budget");
  try {
    return JSON.stringify(value, function (_key, v) {
      if (typeof v === "string") {
        emitted += v.length;
        if (emitted > SERIALIZE_BUDGET) throw OVER;
        return v;
      }
      if (typeof v === "number" || typeof v === "boolean") {
        emitted += 8;
        if (emitted > SERIALIZE_BUDGET) throw OVER;
      }
      return v;
    });
  } catch (e) {
    if (e === OVER) {
      // Best-effort truncated head — clampText adds the marker.
      return JSON.stringify(value)?.slice(0, SERIALIZE_BUDGET) ?? "";
    }
    throw e;
  }
}

export function okResult(data: unknown): UiToolResult {
  let text: string;
  try {
    text = budgetedStringify(
      data === undefined ? { ok: true } : { ok: true, data },
    );
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
 * Validate an optional `string → string` record argument (resource/prompt
 * template variables). `undefined` is allowed (no variables); anything that
 * isn't a flat object of string values is rejected. Shared by the resources
 * and prompts groups so the shape is validated in exactly one place.
 */
export function asStringRecord(
  value: unknown,
): { ok: true; record?: Record<string, string> } | { ok: false } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false };
  }
  const record: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "string") return { ok: false };
    record[key] = raw;
  }
  return { ok: true, record };
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

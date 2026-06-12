/**
 * Hosted-aware, surface-agnostic UI actions backing the WebMCP UI tools.
 *
 * Actions dispatch through the inspector command bus
 * (`executeInspectorCommand`), whose handlers hold the App-level closures
 * (router, app-state context, agent sync) in BOTH local and hosted modes.
 * What lives here is the part the handlers can't own: target validation
 * (hosted tab policy) and the normalized result shape the tool catalog
 * serializes for the model.
 */

import { executeInspectorCommand } from "@/lib/inspector-command-handlers";
import {
  buildInspectorCommandError,
  INSPECTOR_COMMAND_DEFAULT_TIMEOUT_MS,
  type InspectorCommand,
  type InspectorCommandResponse,
} from "@/shared/inspector-command.js";
import {
  isKnownAppTabSegment,
  listKnownAppTabSegments,
  navigationTargetToPath,
} from "@/lib/app-navigation";
import {
  isHostedHashTabBlocked,
  normalizeHostedHashTab,
} from "@/lib/hosted-tab-policy";
import { HOSTED_MODE } from "@/lib/config";

export type UiActionResult =
  | { ok: true; data?: unknown }
  | { ok: false; error: string };

function newCommandId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `ui_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Distributive Omit so the command union keeps its type↔payload pairing. */
type InspectorCommandInput = InspectorCommand extends infer T
  ? T extends InspectorCommand
    ? Omit<T, "id"> & { id?: string }
    : never
  : never;

/**
 * Dispatch a command with a hard timeout. The bus itself only waits 2s for a
 * missing handler; the timeout here bounds slow handler bodies so a wedged
 * UI action can never hang a chat stream indefinitely.
 */
export async function dispatchInspectorCommand(
  command: InspectorCommandInput,
): Promise<InspectorCommandResponse> {
  const withId = { ...command, id: command.id ?? newCommandId() };
  const timeoutMs = withId.timeoutMs ?? INSPECTOR_COMMAND_DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      executeInspectorCommand(withId as InspectorCommand),
      new Promise<InspectorCommandResponse>((resolve) => {
        timer = setTimeout(() => {
          resolve({
            id: withId.id,
            status: "error",
            error: buildInspectorCommandError(
              "timeout",
              `Inspector command "${withId.type}" timed out after ${timeoutMs}ms. ` +
                "The action may still complete in the UI — observe state " +
                "(e.g. ui_snapshot_app) before retrying instead of re-running it blindly.",
            ),
          });
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function commandResponseToActionResult(
  response: InspectorCommandResponse,
): UiActionResult {
  if (response.status === "success") {
    return { ok: true, data: response.result };
  }
  return {
    ok: false,
    error: `${response.error.code}: ${response.error.message}`,
  };
}

export type ResolvedNavigationTarget =
  | { ok: true; path: string; tab: string }
  | { ok: false; reason: string };

/** Navigation targets valid for the current build mode. */
export function listUiNavigationTargets(): string[] {
  const all = listKnownAppTabSegments();
  if (!HOSTED_MODE) return all.sort();
  return all.filter((tab) => !isHostedHashTabBlocked(tab)).sort();
}

/**
 * Validate a navigation target ahead of dispatch. Unknown and hosted-blocked
 * targets are surfaced as errors the model can react to — never the silent
 * `/servers` fallback `navigationTargetToPath` applies on its own.
 */
export function resolveUiNavigationTarget(
  rawTarget: string,
): ResolvedNavigationTarget {
  const trimmed = rawTarget?.trim() ?? "";
  if (!trimmed) {
    return { ok: false, reason: "Navigation target is empty." };
  }
  const stripped = trimmed.replace(/^#/, "").replace(/^\/+/, "");
  const firstSegment = stripped.split(/[/?]/)[0] || "servers";
  const tab = normalizeHostedHashTab(firstSegment);
  if (!isKnownAppTabSegment(tab)) {
    return {
      ok: false,
      reason: `Unknown navigation target "${rawTarget}". Valid targets: ${listUiNavigationTargets().join(", ")}.`,
    };
  }
  if (HOSTED_MODE && isHostedHashTabBlocked(tab)) {
    return {
      ok: false,
      reason: `"${tab}" is not available in hosted mode. Valid targets: ${listUiNavigationTargets().join(", ")}.`,
    };
  }
  return { ok: true, path: navigationTargetToPath(trimmed), tab };
}

export async function navigateAction(target: string): Promise<UiActionResult> {
  const resolved = resolveUiNavigationTarget(target);
  if (!resolved.ok) {
    return { ok: false, error: resolved.reason };
  }
  const response = await dispatchInspectorCommand({
    type: "navigate",
    payload: { target: resolved.path },
  });
  return commandResponseToActionResult(response);
}

export async function selectServerAction(
  serverName: string,
): Promise<UiActionResult> {
  const response = await dispatchInspectorCommand({
    type: "selectServer",
    payload: { serverName },
  });
  return commandResponseToActionResult(response);
}

export async function openPlaygroundAction(
  serverName?: string,
): Promise<UiActionResult> {
  const response = await dispatchInspectorCommand({
    type: "openPlayground",
    payload: serverName ? { serverName } : {},
  });
  return commandResponseToActionResult(response);
}

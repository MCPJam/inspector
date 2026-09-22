/**
 * V1 ⇄ browserd translation.
 *
 * The WebMCP Inspector (V1) speaks `WebMcpCommand`; browserd speaks
 * `BrowserAction`. They overlap almost completely, which is the point of this
 * file: the hosted provider can be built on the daemon without either protocol
 * bending toward the other, and V1's local Playwright path keeps working
 * untouched.
 *
 * The mapping is EXHAUSTIVE by construction — a `never` check on both unions —
 * so adding a command to either protocol is a compile error here rather than a
 * silent fall-through at runtime. That matters more than usual: a dropped
 * command in a browser automation layer looks like a page that just did not
 * respond.
 *
 * Two deliberate asymmetries:
 *
 *   - `cancel_invocation` carries V1's `invokeId`, which is the RUNTIME's
 *     handle, not the daemon's. The caller maps it; this file only names the
 *     shape, because a bridge that invented an id would produce cancels that
 *     silently match nothing.
 *   - `capture_screenshot` becomes an `observe`, not an act. V1 treats a
 *     screenshot as a side-effect-free read and so does the daemon.
 */
import type {
  WebMcpCommand,
  WebMcpCommandResult,
} from "@/shared/webmcp-inspector-protocol";
import type { BrowserAction, BrowserCommandResult } from "./protocol";

/** A command the bridge cannot translate on its own. */
export type BridgeRefusal = {
  ok: false;
  reason: "unsupported_command";
  detail: string;
};

export type BridgedAction = { ok: true; action: BrowserAction } | BridgeRefusal;

/**
 * Translate one V1 command into a daemon action.
 *
 * `resolveInvocationId` maps V1's `invokeId` onto the daemon's invocation id.
 * It is a parameter rather than a lookup here because the correspondence lives
 * in the session that issued the invocation, and a bridge that guessed would
 * cancel the wrong thing or nothing at all.
 */
export function toBrowserAction(
  command: WebMcpCommand,
  resolveInvocationId?: (invokeId: string) => string | undefined,
): BridgedAction {
  switch (command.type) {
    case "navigate":
      return { ok: true, action: { kind: "navigate", url: command.url } };
    case "reload":
      return { ok: true, action: { kind: "reload" } };
    case "go_back":
      return { ok: true, action: { kind: "back" } };
    case "invoke_tool":
      return {
        ok: true,
        action: {
          kind: "webmcp_invoke",
          toolKey: command.toolKey,
          input: command.input,
        },
      };
    case "cancel_invocation": {
      const invocationId = resolveInvocationId?.(command.invokeId);
      if (!invocationId) {
        // Refuse rather than cancel-by-guess: a cancel that matches nothing
        // reads to the user as "the stop button does not work".
        return {
          ok: false,
          reason: "unsupported_command",
          detail: `no daemon invocation is known for invokeId ${command.invokeId}`,
        };
      }
      return { ok: true, action: { kind: "webmcp_cancel", invocationId } };
    }
    case "capture_screenshot":
      return { ok: true, action: { kind: "observe", mode: "screenshot" } };
    case "set_screencast":
    case "input":
      // LOCAL-ONLY, and refused rather than mapped. Both exist to serve the
      // in-app pane, which is fed by a CDP screencast on the machine running
      // the inspector. A hosted browser has its own viewport — the Browser
      // panel's stream, with a take-control lease arbitrating who is driving —
      // so translating these would mean streaming a desktop twice and driving
      // it from two places with nothing between them.
      return {
        ok: false,
        reason: "unsupported_command",
        detail: `${command.type} drives the in-app viewport, which a hosted browser does not have; use the Browser panel`,
      };
    default: {
      const exhaustive: never = command;
      return {
        ok: false,
        reason: "unsupported_command",
        detail: `unknown command ${JSON.stringify(exhaustive)}`,
      };
    }
  }
}

/**
 * Translate a daemon result back into V1's result shape, for the command that
 * produced it. The command type is needed because `WebMcpCommandResult` is a
 * union discriminated by nothing — `{ok:true}` and `{ok:true, cancelled}` are
 * distinguished only by which command was sent.
 */
export function toWebMcpCommandResult(
  command: WebMcpCommand,
  result: BrowserCommandResult,
): WebMcpCommandResult | BridgeRefusal {
  if (!result.ok) {
    return {
      ok: false,
      reason: "unsupported_command",
      detail: result.error ?? "the browser could not complete the command",
    };
  }
  switch (command.type) {
    case "navigate":
    case "reload":
    case "go_back":
      return { ok: true };
    case "invoke_tool": {
      const invokeId = readString(result.output, "invocationId");
      return invokeId ? { ok: true, invokeId } : { ok: true };
    }
    case "cancel_invocation":
      // The daemon reports whether the cancel actually landed; an invocation
      // that had already finished reports `false`, which V1 shows as "too
      // late" rather than pretending it stopped something.
      return { ok: true, cancelled: readBoolean(result.output, "cancelled") };
    case "capture_screenshot": {
      const screenshotBase64 = readString(result.output, "screenshot");
      return screenshotBase64 ? { ok: true, screenshotBase64 } : { ok: true };
    }
    case "set_screencast":
    case "input":
      // Unreachable in practice: `toBrowserAction` refuses these, so no daemon
      // result is ever produced for one. Named anyway rather than left to the
      // `never` arm, so the exhaustive check keeps meaning "every command was
      // considered" instead of "every command except the ones we forgot".
      return {
        ok: false,
        reason: "unsupported_command",
        detail: `${command.type} is never sent to a hosted browser`,
      };
    default: {
      const exhaustive: never = command;
      return {
        ok: false,
        reason: "unsupported_command",
        detail: `unknown command ${JSON.stringify(exhaustive)}`,
      };
    }
  }
}

function readString(output: unknown, key: string): string | undefined {
  if (typeof output !== "object" || output === null) return undefined;
  const value = (output as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readBoolean(output: unknown, key: string): boolean {
  if (typeof output !== "object" || output === null) return false;
  return (output as Record<string, unknown>)[key] === true;
}

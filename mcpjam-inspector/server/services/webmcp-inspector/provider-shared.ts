/**
 * The parts of a WebMCP provider that are the same wherever the browser is.
 *
 * Both providers that speak the WebMCP CDP domain — Playwright driving a
 * Chromium it launched, and the Electron one attaching to a `<webview>` the
 * app already has — translate the same bridge failures and live under the same
 * screenshot budget. Those are contracts with the layers ABOVE them (the
 * timeline shows what the translation produced; the export carries what the
 * budget allowed), so two copies would drift into two different behaviours
 * that each look right in their own tests.
 *
 * Deliberately small. Everything else about the two providers really is
 * different — one owns a browser process, the other borrows a surface — and
 * pulling more up here would mean one set of options meaning two things.
 */
import { WebMcpBridgeError } from "../browserd/daemon/webmcp-bridge";
import {
  WebMcpInvocationCancelledError,
  WebMcpToolGoneError,
} from "./provider";

/** Thumbnail width; small enough that a timeline of them stays cheap. */
export const SCREENSHOT_WIDTH = 640;
export const SCREENSHOT_MAX_BYTES = 64 * 1024;

/**
 * Turn a bridge failure into the error the provider interface's callers handle.
 *
 * The two that carry meaning are named; everything else becomes a plain Error
 * with the page's own message, which is what the timeline shows. Kept at module
 * scope rather than inline so the mapping is one readable table instead of a
 * `catch` block with four branches in the middle of an invocation.
 */
export function translateBridgeError(error: unknown, toolName: string): Error {
  if (!(error instanceof WebMcpBridgeError)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  switch (error.failure) {
    case "webmcp_tool_gone":
      return new WebMcpToolGoneError(
        `The page no longer offers a tool named "${toolName}".`,
      );
    case "webmcp_cancelled":
      // The reason is the point: the browser answers every cancel `Canceled`,
      // so without carrying it a timed-out invocation is recorded as a user
      // cancellation — the one place the difference matters to whoever reads
      // the timeline later.
      return new WebMcpInvocationCancelledError(
        error.message,
        error.cancelReason ?? "cancelled",
      );
    case "webmcp_unsupported":
    case "webmcp_error":
      return new Error(error.message);
  }
}

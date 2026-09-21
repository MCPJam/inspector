import { describe, expect, it } from "vitest";
import { WebMcpBridgeError } from "../../browserd/daemon/webmcp-bridge";
import { translateBridgeError } from "../provider-shared";
import {
  WebMcpInvocationCancelledError,
  WebMcpOutcomeUnknownError,
} from "../provider";

describe("WebMCP cancellation outcomes", () => {
  it.each(["cancelled", "timeout"] as const)(
    "preserves uncertainty after dispatch (%s)",
    (reason) => {
      const message =
        "Page execution may continue; verify the page state before retrying.";
      const error = translateBridgeError(
        new WebMcpBridgeError("webmcp_outcome_unknown", message, reason),
        "charge",
      );
      expect(error).toBeInstanceOf(WebMcpOutcomeUnknownError);
      expect(error.message).toBe(message);
    },
  );
  it("keeps cancellation before dispatch definite", () => {
    expect(
      translateBridgeError(
        new WebMcpBridgeError("webmcp_cancelled", "Nothing ran", "cancelled"),
        "charge",
      ),
    ).toBeInstanceOf(WebMcpInvocationCancelledError);
  });
});

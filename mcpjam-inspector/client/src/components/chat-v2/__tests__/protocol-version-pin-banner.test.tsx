import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ErrorBox } from "../error";
import {
  formatErrorMessage,
  PROTOCOL_VERSION_PIN_CODE,
  UPSTREAM_ERROR_PAGE_CODE,
} from "../shared/chat-helpers";

/**
 * The SDK's `ProtocolVersionPinUnsupported` message, verbatim.
 *
 * The whole mechanism rests on one clause of prose surviving from the SDK to
 * this bundle: the AI SDK collapses a failed chat response into
 * `new Error(await response.text())`, so the class, the `normalized` block and
 * the response headers are all gone by the time a chat surface sees anything.
 *
 * Copied rather than imported because this bundle resolves `@mcpjam/sdk` to
 * its BUILT output, which would make this suite pass against a stale `dist`
 * and quietly stop testing the pairing. The SDK side owns the guard instead:
 * `sdk/tests/error-describer/describe.test.ts` asserts this exact clause is in
 * the class's message, so a reword there fails loudly and names this file.
 */
const PIN_FAILURE_MESSAGE =
  'MCP server "github-mcp" doesn\'t support MCP protocol version 2026-07-28, which this client is pinned to.';

function pinFailureAsChatSees(): string {
  return PIN_FAILURE_MESSAGE;
}

describe("protocol version pin — formatter", () => {
  it("recognizes the SDK's pinned-version refusal", () => {
    const formatted = formatErrorMessage(new Error(pinFailureAsChatSees()));

    expect(formatted?.code).toBe(PROTOCOL_VERSION_PIN_CODE);
    // The SDK's sentence is passed through: it is the only place that names
    // the server, and rebuilding it here would need data this layer lacks.
    expect(formatted?.message).toContain("github-mcp");
    expect(formatted?.message).toContain("2026-07-28");
  });

  it("does NOT offer a retry", () => {
    // The pin is a stored setting. Resending the identical turn fails
    // identically until someone changes it, so a Retry button here would be a
    // button that cannot work — the opposite of the upstream-error-page case,
    // which is transient and where resending IS the fix.
    const formatted = formatErrorMessage(new Error(pinFailureAsChatSees()));

    expect(formatted?.isRetryable).toBe(false);
    expect(formatted?.code).not.toBe(UPSTREAM_ERROR_PAGE_CODE);
  });

  it("leaves ordinary errors alone", () => {
    const formatted = formatErrorMessage(new Error("fetch failed"));

    expect(formatted?.code).toBeUndefined();
    expect(formatted?.message).toBe("fetch failed");
  });
});

describe("protocol version pin — banner", () => {
  it("offers a way to the setting that caused it", () => {
    // The failure Prathmesh hit read "MCPJam was briefly unreachable" and
    // offered Reset chat: a dead end, for a problem one dropdown away.
    render(
      <ErrorBox
        message={pinFailureAsChatSees()}
        code={PROTOCOL_VERSION_PIN_CODE}
        onChangeProtocolVersion={() => {}}
        onResetChat={() => {}}
      />,
    );

    expect(
      screen.getByRole("button", { name: /change protocol version/i }),
    ).toBeInTheDocument();
  });

  it("navigates when clicked", async () => {
    const onChangeProtocolVersion = vi.fn();
    render(
      <ErrorBox
        message={pinFailureAsChatSees()}
        code={PROTOCOL_VERSION_PIN_CODE}
        onChangeProtocolVersion={onChangeProtocolVersion}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /change protocol version/i }),
    );

    expect(onChangeProtocolVersion).toHaveBeenCalledTimes(1);
  });

  it("stays absent when the caller offers no handler", () => {
    // Every other banner keeps its existing shape — the button appears only
    // where a caller can actually route somewhere.
    render(<ErrorBox message="Something else went wrong" onResetChat={() => {}} />);

    expect(
      screen.queryByRole("button", { name: /change protocol version/i }),
    ).not.toBeInTheDocument();
  });
});

describe("protocol version pin — real envelope shape", () => {
  it("recognizes it inside the JSON envelope a hosted turn actually sends", () => {
    // The bare-sentence case above is the one a test constructs by hand; a
    // real hosted failure arrives as the route's JSON envelope, and the
    // formatter returns from that branch before any string-shaped check runs.
    const envelope = JSON.stringify({
      code: "SERVER_UNREACHABLE",
      message: PIN_FAILURE_MESSAGE,
      statusCode: 424,
    });

    const formatted = formatErrorMessage(new Error(envelope));

    expect(formatted?.code).toBe(PROTOCOL_VERSION_PIN_CODE);
    expect(formatted?.isRetryable).toBe(false);
    expect(formatted?.statusCode).toBe(424);
  });

  it("leaves other envelopes on their existing path", () => {
    const envelope = JSON.stringify({
      code: "SERVER_UNREACHABLE",
      message: "Couldn't reach the MCP server (read ECONNRESET)",
    });

    expect(formatErrorMessage(new Error(envelope))?.code).toBe(
      "SERVER_UNREACHABLE",
    );
  });
});

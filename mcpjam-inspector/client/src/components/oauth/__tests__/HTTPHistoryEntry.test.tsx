import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HTTPHistoryEntry } from "../HTTPHistoryEntry";

const exchange = {
  method: "GET",
  url: "https://auth.example.com/.well-known/oauth-authorization-server",
  status: 200,
  statusText: "OK",
  requestHeaders: { Accept: "application/json" },
  responseHeaders: { "Content-Type": "application/json" },
  responseBody: { issuer: "https://auth.example.com" },
};

describe("HTTPHistoryEntry split views", () => {
  it("shows only response fields inside a response-only card", () => {
    render(<HTTPHistoryEntry {...exchange} view="response" defaultOpen />);

    expect(screen.queryByText("Response to request")).not.toBeInTheDocument();
    expect(screen.queryByText("Request URL")).not.toBeInTheDocument();
    expect(screen.queryByText("Request Headers")).not.toBeInTheDocument();
    expect(screen.getByText("Response Headers")).toBeInTheDocument();
    expect(screen.getByText("Response Body")).toBeInTheDocument();
  });

  it("shows only request fields inside a request-only card", () => {
    render(<HTTPHistoryEntry {...exchange} view="request" defaultOpen />);

    expect(screen.getByText("Request URL")).toBeInTheDocument();
    expect(screen.getByText("Request Headers")).toBeInTheDocument();
    expect(screen.queryByText("Response Headers")).not.toBeInTheDocument();
    expect(screen.queryByText("Response Body")).not.toBeInTheDocument();
  });
});

// The probe step advances on a 403 that carries a Bearer challenge, so the card
// recording that exchange must not read as a failure — the flow reports the
// status violation as a warning instead.
describe("HTTPHistoryEntry unauthenticated probe", () => {
  const PRM =
    "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";

  /**
   * Flagging an exchange as a failure is what surfaces the inline error
   * message, and that message repeats the status text — so the card renders
   * "Forbidden" once in its status line and a second time when it flags.
   * Asserting on the message rather than the error styling keeps this tied to
   * what the user reads, and `getAllByText` throws when the card did not render
   * at all, so a broken render fails instead of passing as "not flagged".
   */
  const isFlaggedAsError = (statusText: string) =>
    screen.getAllByText(statusText).length > 1;

  const renderProbe = (props: {
    step?: string;
    status: number;
    statusText: string;
    responseHeaders?: Record<string, string>;
  }) => {
    render(
      <HTTPHistoryEntry
        method="POST"
        url="https://mcp.example.com/mcp"
        view="response"
        step="request_without_token"
        {...props}
      />,
    );
    return isFlaggedAsError(props.statusText);
  };

  it("does not flag a 403 carrying a Bearer challenge", () => {
    expect(
      renderProbe({
        status: 403,
        statusText: "Forbidden",
        responseHeaders: {
          "www-authenticate": `Bearer resource_metadata="${PRM}"`,
        },
      }),
    ).toBe(false);
  });

  it("does not flag the spec-compliant 401", () => {
    expect(renderProbe({ status: 401, statusText: "Unauthorized" })).toBe(
      false,
    );
  });

  it("flags a bare 403, which the flow cannot continue from", () => {
    expect(renderProbe({ status: 403, statusText: "Forbidden" })).toBe(true);
  });

  it("flags a 403 whose only challenge is a scheme OAuth cannot use", () => {
    expect(
      renderProbe({
        status: 403,
        statusText: "Forbidden",
        responseHeaders: { "www-authenticate": 'Basic realm="admin"' },
      }),
    ).toBe(true);
  });

  it("flags a challenge-carrying 403 outside the probe step", () => {
    expect(
      renderProbe({
        step: "authenticated_mcp_request",
        status: 403,
        statusText: "Forbidden",
        responseHeaders: { "www-authenticate": "Bearer" },
      }),
    ).toBe(true);
  });
});

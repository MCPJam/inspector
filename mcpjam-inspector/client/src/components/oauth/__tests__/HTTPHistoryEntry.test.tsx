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

  const renderProbe = (props: {
    step?: string;
    status: number;
    responseHeaders?: Record<string, string>;
  }) =>
    render(
      <HTTPHistoryEntry
        method="POST"
        url="https://mcp.example.com/mcp"
        statusText="Forbidden"
        view="response"
        step="request_without_token"
        {...props}
      />,
    ).container;

  /** The card's failure styling, which also gates the inline error message. */
  const isFlaggedAsError = (container: HTMLElement) =>
    container.querySelector(".border-red-400") !== null;

  it("does not flag a 403 carrying a Bearer challenge", () => {
    expect(
      isFlaggedAsError(
        renderProbe({
          status: 403,
          responseHeaders: {
            "www-authenticate": `Bearer resource_metadata="${PRM}"`,
          },
        }),
      ),
    ).toBe(false);
  });

  it("does not flag the spec-compliant 401", () => {
    expect(isFlaggedAsError(renderProbe({ status: 401 }))).toBe(false);
  });

  it("flags a bare 403, which the flow cannot continue from", () => {
    expect(isFlaggedAsError(renderProbe({ status: 403 }))).toBe(true);
  });

  it("flags a 403 whose only challenge is a scheme OAuth cannot use", () => {
    expect(
      isFlaggedAsError(
        renderProbe({
          status: 403,
          responseHeaders: { "www-authenticate": 'Basic realm="admin"' },
        }),
      ),
    ).toBe(true);
  });

  it("flags a challenge-carrying 403 outside the probe step", () => {
    expect(
      isFlaggedAsError(
        renderProbe({
          step: "authenticated_mcp_request",
          status: 403,
          responseHeaders: { "www-authenticate": "Bearer" },
        }),
      ),
    ).toBe(true);
  });
});

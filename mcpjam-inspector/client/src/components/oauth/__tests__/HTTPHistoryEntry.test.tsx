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

/**
 * The bootstrap error branch is the actual claim of BB-118: an expected
 * host-denial 403 must show the self-serve guidance and NOT report to Sentry,
 * while any genuine failure must show the generic screen AND report. That
 * decision lives in resolveBootstrapErrorScreen (main.tsx can't be imported in a
 * test — it self-executes), so this pins both halves: the `report` flag and
 * which screen renders.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { resolveBootstrapErrorScreen } from "../SessionBootstrapError";
import { SessionTokenError } from "@/lib/session-token";

describe("resolveBootstrapErrorScreen", () => {
  it("403 host-denial: renders NetworkAccessError and does not report", () => {
    const { report, element } = resolveBootstrapErrorScreen(
      new SessionTokenError(403, { code: "HOST_NOT_ALLOWED" }),
    );

    expect(report).toBe(false);
    render(element);
    expect(
      screen.getByText("Network access needs configuration"),
    ).toBeInTheDocument();
  });

  it("access link required: renders AccessRequired and does not report", () => {
    const { report, extra } = resolveBootstrapErrorScreen(
      new SessionTokenError(401, { code: "ACCESS_LINK_REQUIRED" }),
    );

    expect(report).toBe(false);
    expect(extra).toBeUndefined();
  });

  it("ACCESS_LINK_REQUIRED on a 200: reports it instead of asking for the link", () => {
    const { report, element, extra } = resolveBootstrapErrorScreen(
      new SessionTokenError(200, {
        code: "ACCESS_LINK_REQUIRED",
        contentType: "application/json",
      }),
    );

    expect(report).toBe(true);
    expect(extra).toEqual({ httpStatus: 200, contentType: "application/json" });
    render(element);
    expect(screen.getByText("MCPJam couldn't start")).toBeInTheDocument();
  });

  it("403 page from another program: reports it instead of the network screen", () => {
    const { report, element, extra } = resolveBootstrapErrorScreen(
      new SessionTokenError(403, { contentType: "text/html" }),
    );

    expect(report).toBe(true);
    expect(extra).toEqual({ httpStatus: 403, contentType: "text/html" });
    render(element);
    expect(screen.getByText("MCPJam couldn't start")).toBeInTheDocument();
  });

  it("non-Inspector answer: reports its status and content type", () => {
    const { report, extra } = resolveBootstrapErrorScreen(
      new SessionTokenError(502, { restarted: true, contentType: "text/html" }),
    );

    expect(report).toBe(true);
    expect(extra).toEqual({ httpStatus: 502, contentType: "text/html" });
  });

  it("5xx failure: renders the generic screen and reports", () => {
    const { report, element, extra } = resolveBootstrapErrorScreen(
      new SessionTokenError(500),
    );

    expect(report).toBe(true);
    expect(extra).toEqual({ httpStatus: 500 });
    render(element);
    expect(screen.getByText("MCPJam couldn't start")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload MCPJam" })).toBeEnabled();
  });

  it("non-SessionTokenError failure: renders the generic screen and reports", () => {
    const { report, element, extra } = resolveBootstrapErrorScreen(
      new Error("network down"),
    );

    expect(report).toBe(true);
    expect(extra).toBeUndefined();
    render(element);
    expect(screen.getByText("MCPJam couldn't start")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload MCPJam" })).toBeEnabled();
  });
});

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
      new SessionTokenError(403),
    );

    expect(report).toBe(false);
    render(element);
    expect(
      screen.getByText("Network access needs configuration"),
    ).toBeInTheDocument();
  });

  it("5xx failure: renders the generic screen and reports", () => {
    const { report, element } = resolveBootstrapErrorScreen(
      new SessionTokenError(500),
    );

    expect(report).toBe(true);
    render(element);
    expect(screen.getByText("Authentication Error")).toBeInTheDocument();
  });

  it("non-SessionTokenError failure: renders the generic screen and reports", () => {
    const { report, element } = resolveBootstrapErrorScreen(
      new Error("network down"),
    );

    expect(report).toBe(true);
    render(element);
    expect(screen.getByText("Authentication Error")).toBeInTheDocument();
  });
});

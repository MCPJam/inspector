import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { MCPCheckResult, OAuthConformanceStepResult } from "@mcpjam/sdk";
import { CheckRow, OAuthStepRow } from "../ConformanceCheckRows";

function check(overrides: Partial<MCPCheckResult>): MCPCheckResult {
  return {
    id: "server-initialize",
    category: "core",
    title: "Server Initialize",
    description: "Server responds to initialize and reports capabilities.",
    status: "passed",
    durationMs: 420,
    ...overrides,
  };
}

describe("CheckRow", () => {
  it("shows how long a check that ran took", () => {
    render(<CheckRow check={check({})} />);
    expect(screen.getByText("420ms")).toBeInTheDocument();
  });

  it("leaves the duration off a skipped check", () => {
    render(
      <CheckRow
        check={check({
          status: "skipped",
          skipReason: "not-applicable",
          durationMs: 0,
        })}
      />,
    );
    expect(screen.queryByText("0ms")).not.toBeInTheDocument();
  });
});

function step(
  overrides: Partial<OAuthConformanceStepResult>,
): OAuthConformanceStepResult {
  return {
    step: "token_request",
    title: "Token request",
    summary: "Exchange the code for a token.",
    status: "passed",
    durationMs: 310,
    logs: [],
    httpAttempts: [],
    ...overrides,
  };
}

describe("OAuthStepRow", () => {
  it("shows how long a step that ran took", () => {
    render(<OAuthStepRow step={step({})} />);
    expect(screen.getByText("310ms")).toBeInTheDocument();
  });

  it("leaves the duration off a skipped step", () => {
    render(
      <OAuthStepRow
        step={step({
          status: "skipped",
          skipReason: "not-applicable",
          durationMs: 0,
        })}
      />,
    );
    expect(screen.queryByText("0ms")).not.toBeInTheDocument();
  });
});

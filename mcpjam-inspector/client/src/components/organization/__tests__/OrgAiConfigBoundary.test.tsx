import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ORG_AI_CONFIG_QUERY } from "@/hooks/useOrgAiConfig";
import {
  OrgAiConfigBoundary,
  isOrgAiConfigUnavailable,
} from "../OrgAiConfigBoundary";

const reportBoundaryError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/error-reporting", () => ({ reportBoundaryError }));

// What the browser client throws for this query when the deployment does not
// serve it. Production redacts "Could not find public function" to
// "Server Error"; the function name in the prefix survives.
const PROD_REDACTED = `[CONVEX Q(${ORG_AI_CONFIG_QUERY})] [Request ID: 5eb87f6c9d3ef8d5] Server Error\n  Called by client`;
const DEV_MISSING = `[CONVEX Q(${ORG_AI_CONFIG_QUERY})] [Request ID: abc] Could not find public function for '${ORG_AI_CONFIG_QUERY}'`;

function Throws({ error }: { error: Error }): never {
  throw error;
}

describe("isOrgAiConfigUnavailable", () => {
  it("matches the dev and production shapes of a missing function", () => {
    expect(isOrgAiConfigUnavailable(new Error(PROD_REDACTED))).toBe(true);
    expect(isOrgAiConfigUnavailable(new Error(DEV_MISSING))).toBe(true);
  });

  it("does not match another query's failure", () => {
    expect(
      isOrgAiConfigUnavailable(
        new Error("[CONVEX Q(servers:get)] [Request ID: x] Server Error"),
      ),
    ).toBe(false);
  });

  it("does not match a refusal the query worded itself", () => {
    expect(
      isOrgAiConfigUnavailable(
        new Error(
          `[CONVEX Q(${ORG_AI_CONFIG_QUERY})] [Request ID: x] Organization not found`,
        ),
      ),
    ).toBe(false);
  });
});

describe("OrgAiConfigBoundary", () => {
  it("renders its children normally", () => {
    render(
      <OrgAiConfigBoundary name="test">
        <p>AI keys</p>
      </OrgAiConfigBoundary>,
    );
    expect(screen.getByText("AI keys")).toBeInTheDocument();
  });

  it("renders nothing, and reports nothing, when the query is not deployed", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const { container } = render(
      <OrgAiConfigBoundary name="test">
        <Throws error={new Error(PROD_REDACTED)} />
      </OrgAiConfigBoundary>,
    );

    expect(container).toBeEmptyDOMElement();
    expect(reportBoundaryError).not.toHaveBeenCalled();
  });

  it("still reports a failure it does not expect", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(
      <OrgAiConfigBoundary name="test">
        <Throws error={new Error("Cannot read properties of undefined")} />
      </OrgAiConfigBoundary>,
    );

    expect(container).toBeEmptyDOMElement();
    expect(reportBoundaryError).toHaveBeenCalledTimes(1);
  });
});

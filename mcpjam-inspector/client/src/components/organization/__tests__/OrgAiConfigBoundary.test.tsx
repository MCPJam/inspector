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
// serve it.
const DEV_MISSING = `[CONVEX Q(${ORG_AI_CONFIG_QUERY})] [Request ID: abc] Could not find public function for '${ORG_AI_CONFIG_QUERY}'`;
// Production's redacted shape, which a real failure of the query shares.
const PROD_REDACTED = `[CONVEX Q(${ORG_AI_CONFIG_QUERY})] [Request ID: 5eb87f6c9d3ef8d5] Server Error\n  Called by client`;

function Throws({ error }: { error: Error }): never {
  throw error;
}

describe("isOrgAiConfigUnavailable", () => {
  it("matches a missing function", () => {
    expect(isOrgAiConfigUnavailable(new Error(DEV_MISSING))).toBe(true);
  });

  it("does not take a redacted Server Error for a missing function", () => {
    expect(isOrgAiConfigUnavailable(new Error(PROD_REDACTED))).toBe(false);
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
    reportBoundaryError.mockClear();
    const { container } = render(
      <OrgAiConfigBoundary name="test">
        <Throws error={new Error(DEV_MISSING)} />
      </OrgAiConfigBoundary>,
    );

    expect(container).toBeEmptyDOMElement();
    expect(reportBoundaryError).not.toHaveBeenCalled();
  });

  it.each([
    ["a redacted Server Error", PROD_REDACTED],
    ["an unrelated failure", "Cannot read properties of undefined"],
  ])("shows an error and reports %s", (_label, message) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    reportBoundaryError.mockClear();
    render(
      <OrgAiConfigBoundary name="test">
        <Throws error={new Error(message)} />
      </OrgAiConfigBoundary>,
    );

    expect(screen.getByTestId("org-ai-config-error")).toHaveTextContent(
      "Couldn't load the AI settings",
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
    expect(reportBoundaryError).toHaveBeenCalledTimes(1);
  });
});

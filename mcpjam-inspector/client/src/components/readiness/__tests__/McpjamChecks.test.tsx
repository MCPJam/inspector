/**
 * MCPJam's results under a field: each says what was found and, where the
 * check gave one, what to do about it.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PlacedFinding } from "@mcpjam/sdk/browser";
import { McpjamChecks } from "../McpjamChecks";

function informational(
  detail: Partial<PlacedFinding["finding"]>,
): PlacedFinding {
  return {
    step: "listing",
    evidenceStatus: "established",
    finding: {
      id: "claude.submission.listing-fields",
      title: "Listing fields follow the portal's rules",
      lane: "submission-artifacts",
      class: "recommended",
      status: "informational",
      source: {},
      provenance: "declared",
      intrusiveness: "passive",
      evaluatedAt: "2026-01-01T00:00:00.000Z",
      engineVersion: "test",
      ...detail,
    },
  };
}

describe("McpjamChecks", () => {
  it("shows an informational finding's remediation", () => {
    render(
      <McpjamChecks
        findings={[
          informational({
            remediation: "Add a privacy policy link to the listing.",
            notEvaluatedReason: "No privacy policy was given.",
          }),
        ]}
      />,
    );
    expect(
      screen.getByText("Add a privacy policy link to the listing."),
    ).toBeVisible();
    expect(screen.queryByText("No privacy policy was given.")).toBeNull();
  });

  it("falls back to why it was not evaluated when there is no remediation", () => {
    render(
      <McpjamChecks
        findings={[
          informational({ notEvaluatedReason: "No privacy policy was given." }),
        ]}
      />,
    );
    expect(screen.getByText("No privacy policy was given.")).toBeVisible();
  });
});

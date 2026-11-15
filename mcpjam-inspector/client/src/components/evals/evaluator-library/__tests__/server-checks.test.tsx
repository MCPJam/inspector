import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen } from "@/test";
import { OwaspCoverageCell } from "../owasp-coverage-cell";
import { ProbeRow, type ProbeRowProps } from "../probe-row";
import { SpecKeyword } from "../spec-keyword";

const failing: ProbeRowProps = {
  name: "Token Audience Check",
  attack: "Token passthrough",
  owasp: "MCP07",
  requirement: {
    keyword: "MUST NOT",
    text: "accept tokens not issued for this server",
  },
  method: "Sends a valid token issued for a different resource.",
  result: "failed",
  resultDetail: "200 OK, 14 tools listed",
  steps: [
    { label: "Token for api.other.example", passed: true },
    {
      label: "initialize with it",
      detail: "Expected 401, got 200",
      passed: false,
    },
  ],
  fix: "Reject the request unless the token's aud is this server's URI.",
  reproduce:
    'curl -i https://mcp.example.dev/mcp -H "Authorization: Bearer $OTHER_TOKEN"',
};

describe("SpecKeyword", () => {
  it("renders the keyword as written in the spec", () => {
    renderWithProviders(<SpecKeyword keyword="MUST NOT" />);
    expect(screen.getByText("MUST NOT")).toBeInTheDocument();
  });
});

describe("ProbeRow", () => {
  it("shows the requirement, method and result while collapsed", () => {
    renderWithProviders(<ProbeRow {...failing} />);
    const row = screen.getByRole("region", { name: "Token Audience Check" });
    expect(row).toHaveTextContent("Token passthrough · MCP07");
    expect(row).toHaveTextContent("MUST NOT");
    expect(row).toHaveTextContent("Failed");
    expect(row).toHaveTextContent("200 OK, 14 tools listed");
    expect(screen.queryByText("How to fix")).not.toBeInTheDocument();
  });

  it("expands to the steps, fix and reproduce command", () => {
    renderWithProviders(<ProbeRow {...failing} />);
    const toggle = screen.getByRole("button", {
      name: "Expand Token Audience Check",
    });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Expected 401, got 200")).toBeInTheDocument();
    expect(screen.getByText("Unexpected:")).toHaveClass("sr-only");
    expect(screen.getByText("How to fix")).toBeInTheDocument();
    expect(screen.getByText(/\$OTHER_TOKEN/)).toBeInTheDocument();
  });

  it("offers Accept risk only on a failed probe", () => {
    const onAcceptRisk = vi.fn();
    const { rerender } = renderWithProviders(
      <ProbeRow
        {...failing}
        defaultOpen
        onRerun={() => {}}
        onAcceptRisk={onAcceptRisk}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Accept risk" }));
    expect(onAcceptRisk).toHaveBeenCalledTimes(1);
    rerender(
      <ProbeRow
        {...failing}
        result="passed"
        defaultOpen
        onRerun={() => {}}
        onAcceptRisk={onAcceptRisk}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Accept risk" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Re-run" })).toBeInTheDocument();
  });

  it("has no expand control when there is nothing to expand", () => {
    renderWithProviders(
      <ProbeRow
        name="Per-client Consent"
        attack="Confused deputy"
        requirement={{ text: "Only for OAuth proxies" }}
        method="Registers two clients."
        result="not_applicable"
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("Not applicable")).toBeInTheDocument();
  });
});

describe("OwaspCoverageCell", () => {
  it("says what covers the item and how it is doing", () => {
    renderWithProviders(
      <OwaspCoverageCell
        id="MCP04"
        title="Supply chain and dependency tampering"
        coveredBy="Outside MCPJam"
        coverage="not_covered"
      />,
    );
    const cell = screen.getByRole("group", { name: "MCP04: Not covered here" });
    expect(cell).toHaveTextContent("Supply chain and dependency tampering");
    expect(cell).toHaveTextContent("Outside MCPJam");
  });
});

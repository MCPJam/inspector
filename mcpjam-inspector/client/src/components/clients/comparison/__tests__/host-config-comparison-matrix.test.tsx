import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";
import type { HostComparisonSubject } from "@/lib/host-config-field-schema";
import { HostConfigComparisonMatrix } from "../host-config-comparison-matrix";

function makeConfig(overrides: Partial<HostConfigDtoV2> = {}): HostConfigDtoV2 {
  return {
    id: "hc_test",
    schemaVersion: 2,
    hostStyle: "mcpjam",
    modelId: "claude-sonnet-4-6",
    systemPrompt: "You are a helpful assistant.",
    temperature: 0.2,
    requireToolApproval: false,
    respectToolVisibility: true,
    serverIds: [],
    optionalServerIds: [],
    connectionDefaults: { headers: {}, requestTimeout: 60_000 },
    clientCapabilities: {},
    hostContext: {},
    ...overrides,
  } as HostConfigDtoV2;
}

function makeSubject(
  hostId: string,
  hostName: string,
  overrides: Partial<HostConfigDtoV2> = {},
  configHashShort?: string,
): HostComparisonSubject {
  return {
    hostId,
    hostName,
    hostStyle: overrides.hostStyle ?? "mcpjam",
    configHashShort: configHashShort ?? hostId.slice(-6),
    config: makeConfig(overrides),
  };
}

describe("HostConfigComparisonMatrix", () => {
  it("renders the empty-state hint when no subjects are passed", () => {
    render(<HostConfigComparisonMatrix subjects={[]} />);
    expect(
      screen.getByText(/No hosts to compare/i),
    ).toBeInTheDocument();
  });

  it("renders the three section bands in the canonical order", () => {
    render(
      <HostConfigComparisonMatrix
        subjects={[makeSubject("h_a3f9d2_claude", "Claude Code")]}
      />,
    );
    const sections = screen.getAllByRole("columnheader", { hidden: true })
      .map((el) => el.textContent ?? "")
      .filter((text) =>
        /^Agent|^MCP Protocol|^Apps/.test(text.trim()),
      );
    // The first three matching headers should be Agent → MCP Protocol → Apps.
    expect(sections.length).toBeGreaterThanOrEqual(3);
    expect(sections[0]).toMatch(/^Agent/);
    expect(sections[1]).toMatch(/^MCP Protocol/);
    expect(sections[2]).toMatch(/^Apps/);
  });

  it("renders a column header per subject with name and configHashShort", () => {
    render(
      <HostConfigComparisonMatrix
        subjects={[
          makeSubject("h_claude_001", "Claude Code", {}, "a3f9d2"),
          makeSubject("h_cursor_002", "Cursor", { hostStyle: "cursor" }, "1b8e44"),
        ]}
      />,
    );
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("Cursor")).toBeInTheDocument();
    expect(screen.getByText(/·a3f9d2/)).toBeInTheDocument();
    expect(screen.getByText(/·1b8e44/)).toBeInTheDocument();
  });

  it("paints the diverge gutter on rows whose value differs across hosts", () => {
    render(
      <HostConfigComparisonMatrix
        subjects={[
          makeSubject("h_a", "A", { temperature: 0.2 }),
          makeSubject("h_b", "B", { temperature: 0.7 }),
        ]}
      />,
    );
    expect(screen.getByTestId("diverge-gutter-temperature")).toBeInTheDocument();
  });

  it("omits the diverge gutter on rows that agree", () => {
    render(
      <HostConfigComparisonMatrix
        subjects={[
          makeSubject("h_a", "A"),
          makeSubject("h_b", "B"),
        ]}
      />,
    );
    expect(
      screen.queryByTestId("diverge-gutter-temperature"),
    ).not.toBeInTheDocument();
  });

  it("hides non-diverging rows when divergingOnly is set", () => {
    render(
      <HostConfigComparisonMatrix
        subjects={[
          makeSubject("h_a", "A", { temperature: 0.2 }),
          makeSubject("h_b", "B", { temperature: 0.7 }),
        ]}
        divergingOnly
      />,
    );
    // temperature differs → still visible
    expect(screen.getByTestId("diverge-gutter-temperature")).toBeInTheDocument();
    // modelId is identical across both → row hidden
    expect(screen.queryByText("modelId")).not.toBeInTheDocument();
  });

  it("renders boolean values as on/off pills", () => {
    render(
      <HostConfigComparisonMatrix
        subjects={[
          makeSubject("h_a", "A", { requireToolApproval: true }),
          makeSubject("h_b", "B", { requireToolApproval: false }),
        ]}
      />,
    );
    expect(screen.getAllByText("on").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("off").length).toBeGreaterThanOrEqual(1);
  });

  it("renders progressiveToolDiscovery=undefined as 'auto' (tri-state)", () => {
    render(
      <HostConfigComparisonMatrix
        subjects={[makeSubject("h_a", "A")]}
      />,
    );
    expect(screen.getAllByText("auto").length).toBeGreaterThanOrEqual(1);
  });
});

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";
import type { HostComparisonSubject } from "@/lib/host-config-field-schema";
import { HostCapabilityListView } from "../HostCapabilityListView";

function makeSubject(
  hostId: string,
  hostName: string,
  overrides: Partial<HostConfigDtoV2> = {},
): HostComparisonSubject {
  return {
    hostId,
    hostName,
    hostStyle: overrides.hostStyle ?? "claude",
    configHashShort: hostId.slice(-6),
    config: {
      id: "hc_test",
      schemaVersion: 2,
      hostStyle: "claude",
      modelId: "claude-sonnet-4-6",
      systemPrompt: "",
      temperature: 0.2,
      requireToolApproval: false,
      respectToolVisibility: true,
      serverIds: [],
      optionalServerIds: [],
      connectionDefaults: { headers: {}, requestTimeout: 60_000 },
      clientCapabilities: {},
      hostContext: {},
      ...overrides,
    } as HostConfigDtoV2,
  };
}

describe("HostCapabilityListView", () => {
  it("renders a column per host with grouped support walls", () => {
    render(
      <HostCapabilityListView subjects={[makeSubject("h_a", "Claude Code")]} />,
    );
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    // At least one group heading appears, and capability chips render in walls.
    const groups = screen.queryAllByText(/Supported|Not advertised|Partial/);
    expect(groups.length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("openLinks").length).toBeGreaterThanOrEqual(1);
  });

  it("renders the empty-hosts state without crashing while subjects hydrate", () => {
    // Regression: the `fields` memo must not read `configs[0]` when subjects
    // is empty (selected-but-still-loading) — that would crash the render.
    render(<HostCapabilityListView subjects={[]} />);
    expect(screen.getByText(/No hosts to compare/i)).toBeInTheDocument();
  });

  it("shows an empty state when the search matches nothing", () => {
    render(
      <HostCapabilityListView
        subjects={[makeSubject("h_a", "Claude Code")]}
        searchQuery="zzz-no-such-capability"
      />,
    );
    expect(screen.getByText(/No capabilities match/i)).toBeInTheDocument();
  });
});

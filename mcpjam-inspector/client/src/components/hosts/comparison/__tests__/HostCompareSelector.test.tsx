import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { HostListItem } from "@/hooks/useClients";
import { HostCompareSelector } from "../HostCompareSelector";

function makeHost(hostId: string, name: string): HostListItem {
  return {
    hostId,
    name,
    hostConfigId: `hc_${hostId}`,
    modelId: "claude-sonnet-4-6",
    serverCount: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("HostCompareSelector", () => {
  it("renders a chip per host and toggles selection on click", async () => {
    const user = userEvent.setup();
    const onToggleHost = vi.fn();

    render(
      <HostCompareSelector
        hosts={[
          makeHost("h_a", "Claude"),
          makeHost("h_b", "Cursor"),
        ]}
        selectedHostIds={["h_a"]}
        subjectsByHost={{}}
        onToggleHost={onToggleHost}
        divergingOnly={false}
        onDivergingOnlyChange={vi.fn()}
        supportFilter="all"
        onSupportFilterChange={vi.fn()}
        showDescriptions={false}
        onShowDescriptionsChange={vi.fn()}
      />,
    );

    expect(screen.getByTestId("host-compare-chip-h_a")).toHaveAttribute(
      "data-selected",
      "true",
    );
    expect(screen.getByTestId("host-compare-chip-h_b")).toHaveAttribute(
      "data-selected",
      "false",
    );

    await user.click(screen.getByTestId("host-compare-chip-h_b"));
    expect(onToggleHost).toHaveBeenCalledWith("h_b");
  });

  it("shows a More menu when there are more than six hosts", () => {
    const hosts = Array.from({ length: 7 }, (_, index) =>
      makeHost(`h_${index}`, `Host ${index}`),
    );

    render(
      <HostCompareSelector
        hosts={hosts}
        selectedHostIds={hosts.map((host) => host.hostId)}
        subjectsByHost={{}}
        onToggleHost={vi.fn()}
        divergingOnly={false}
        onDivergingOnlyChange={vi.fn()}
        supportFilter="all"
        onSupportFilterChange={vi.fn()}
        showDescriptions={false}
        onShowDescriptionsChange={vi.fn()}
      />,
    );

    expect(screen.getByTestId("host-compare-overflow-trigger")).toBeInTheDocument();
    expect(
      screen.queryByTestId("host-compare-chip-h_6"),
    ).not.toBeInTheDocument();
  });

  it("emits the chosen support filter mode", async () => {
    const user = userEvent.setup();
    const onSupportFilterChange = vi.fn();

    render(
      <HostCompareSelector
        hosts={[makeHost("h_a", "Claude")]}
        selectedHostIds={["h_a"]}
        subjectsByHost={{}}
        onToggleHost={vi.fn()}
        divergingOnly={false}
        onDivergingOnlyChange={vi.fn()}
        supportFilter="all"
        onSupportFilterChange={onSupportFilterChange}
        showDescriptions={false}
        onShowDescriptionsChange={vi.fn()}
      />,
    );

    await user.click(screen.getByTestId("support-filter-missing"));
    expect(onSupportFilterChange).toHaveBeenCalledWith("missing");
  });

  it("disables the diverging toggle when the selector is disabled", () => {
    render(
      <HostCompareSelector
        hosts={[makeHost("h_a", "Claude")]}
        selectedHostIds={["h_a"]}
        subjectsByHost={{}}
        onToggleHost={vi.fn()}
        divergingOnly={false}
        onDivergingOnlyChange={vi.fn()}
        supportFilter="all"
        onSupportFilterChange={vi.fn()}
        showDescriptions={false}
        onShowDescriptionsChange={vi.fn()}
        disabled
      />
    );

    expect(screen.getByLabelText("Show only diverging fields")).toBeDisabled();
  });
});

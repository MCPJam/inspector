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
  it("shows built-in logos before a live host config loads", () => {
    render(
      <HostCompareSelector
        hosts={[
          makeHost("h_chatgpt", "ChatGPT"),
          makeHost("h_custom", "My custom client"),
        ]}
        selectedHostIds={[]}
        subjectsByHost={{}}
        onToggleHost={vi.fn()}
        divergingOnly={false}
        onDivergingOnlyChange={vi.fn()}
        supportFilter="all"
        onSupportFilterChange={vi.fn()}
        showDescriptions={false}
        onShowDescriptionsChange={vi.fn()}
      />
    );

    expect(
      screen.getByTestId("host-compare-chip-h_chatgpt").querySelector("img")
    ).toHaveAttribute("src", "/openai_logo.png");
    expect(
      screen.getByTestId("host-compare-chip-h_custom").querySelector("img")
    ).not.toBeInTheDocument();
    expect(
      screen
        .getByTestId("host-compare-chip-h_custom")
        .querySelector('[aria-hidden="true"]')
    ).toHaveTextContent("My");
  });

  it("renders a chip per host and toggles selection on click", async () => {
    const user = userEvent.setup();
    const onToggleHost = vi.fn();

    render(
      <HostCompareSelector
        hosts={[makeHost("h_a", "Claude"), makeHost("h_b", "Cursor")]}
        selectedHostIds={["h_a"]}
        subjectsByHost={{}}
        onToggleHost={onToggleHost}
        divergingOnly={false}
        onDivergingOnlyChange={vi.fn()}
        supportFilter="all"
        onSupportFilterChange={vi.fn()}
        showDescriptions={false}
        onShowDescriptionsChange={vi.fn()}
      />
    );

    expect(screen.getByTestId("host-compare-chip-h_a")).toHaveAttribute(
      "data-selected",
      "true"
    );
    expect(screen.getByTestId("host-compare-chip-h_b")).toHaveAttribute(
      "data-selected",
      "false"
    );

    await user.click(screen.getByTestId("host-compare-chip-h_b"));
    expect(onToggleHost).toHaveBeenCalledWith("h_b");
  });

  it("shows a saved client's derived display name", () => {
    const savedCursor = {
      ...makeHost("h_cursor", "Cursor"),
      displayName: "Cursor #2",
    };

    render(
      <HostCompareSelector
        hosts={[savedCursor]}
        selectedHostIds={[savedCursor.hostId]}
        subjectsByHost={{}}
        onToggleHost={vi.fn()}
        divergingOnly={false}
        onDivergingOnlyChange={vi.fn()}
        supportFilter="all"
        onSupportFilterChange={vi.fn()}
        showDescriptions={false}
        onShowDescriptionsChange={vi.fn()}
      />
    );

    expect(screen.getByText("Cursor #2")).toBeInTheDocument();
  });

  it("shows a More menu initially when there are more than six hosts", () => {
    const hosts = Array.from({ length: 7 }, (_, index) =>
      makeHost(`h_${index}`, `Host ${index}`)
    );

    render(
      <HostCompareSelector
        hosts={hosts}
        selectedHostIds={[]}
        subjectsByHost={{}}
        onToggleHost={vi.fn()}
        divergingOnly={false}
        onDivergingOnlyChange={vi.fn()}
        supportFilter="all"
        onSupportFilterChange={vi.fn()}
        showDescriptions={false}
        onShowDescriptionsChange={vi.fn()}
      />
    );

    expect(
      screen.getByTestId("host-compare-overflow-trigger")
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("host-compare-chip-h_6")
    ).not.toBeInTheDocument();
  });

  it("shows initials instead of an empty dot in the More menu", async () => {
    const user = userEvent.setup();
    const hosts = Array.from({ length: 7 }, (_, index) =>
      makeHost(`h_${index}`, index === 6 ? "Custom seventh" : `Host ${index}`)
    );

    render(
      <HostCompareSelector
        hosts={hosts}
        selectedHostIds={[]}
        subjectsByHost={{}}
        onToggleHost={vi.fn()}
        divergingOnly={false}
        onDivergingOnlyChange={vi.fn()}
        supportFilter="all"
        onSupportFilterChange={vi.fn()}
        showDescriptions={false}
        onShowDescriptionsChange={vi.fn()}
      />
    );

    await user.click(screen.getByTestId("host-compare-overflow-trigger"));
    expect(
      screen
        .getByTestId("host-compare-overflow-h_6")
        .querySelector('[aria-hidden="true"]')
    ).toHaveTextContent("Cu");
  });

  it("shows selected hosts inline even past the initial compact limit", () => {
    const hosts = Array.from({ length: 8 }, (_, index) =>
      makeHost(`h_${index}`, `Host ${index}`)
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
      />
    );

    expect(screen.getByTestId("host-compare-chip-h_7")).toBeInTheDocument();
    expect(
      screen.queryByTestId("host-compare-overflow-trigger")
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
      />
    );

    await user.click(screen.getByTestId("support-filter-missing"));
    expect(onSupportFilterChange).toHaveBeenCalledWith("missing");
  });

  it("does not emit support filter changes while support filters are disabled", async () => {
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
        supportFiltersDisabled
        showDescriptions={false}
        onShowDescriptionsChange={vi.fn()}
      />
    );

    const missingFilter = screen.getByTestId("support-filter-missing");
    expect(missingFilter).toBeDisabled();

    await user.click(missingFilter);
    expect(onSupportFilterChange).not.toHaveBeenCalled();
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

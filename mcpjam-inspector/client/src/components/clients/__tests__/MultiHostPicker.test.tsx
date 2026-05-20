import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "@testing-library/react";
import { MultiHostPicker } from "@/components/clients/MultiHostPicker";
import type { HostListItem } from "@/hooks/useClients";

const hostA: HostListItem = {
  hostId: "host-a",
  name: "MCPJam",
  hostConfigId: "cfg-a",
  modelId: "m-a",
  serverCount: 0,
  createdAt: 1,
  updatedAt: 1,
};

const hostB: HostListItem = {
  hostId: "host-b",
  name: "Claude",
  hostConfigId: "cfg-b",
  modelId: "m-b",
  serverCount: 0,
  createdAt: 2,
  updatedAt: 2,
};

const hostC: HostListItem = {
  hostId: "host-c",
  name: "Codex",
  hostConfigId: "cfg-c",
  modelId: "m-c",
  serverCount: 0,
  createdAt: 3,
  updatedAt: 3,
};

const hostD: HostListItem = {
  hostId: "host-d",
  name: "ChatGPT",
  hostConfigId: "cfg-d",
  modelId: "m-d",
  serverCount: 0,
  createdAt: 4,
  updatedAt: 4,
};

interface RenderOptions {
  hosts: HostListItem[];
  currentHostId: string | null;
  selectedHostIds?: string[];
  multiHostEnabled?: boolean;
  onMultiHostEnabledChange?: ReturnType<typeof vi.fn>;
  onSelectedHostIdsChange?: ReturnType<typeof vi.fn>;
  onPromoteLead?: ReturnType<typeof vi.fn>;
  maxSelectedHosts?: number;
}

function renderPicker(opts: RenderOptions) {
  const onPromoteLead = opts.onPromoteLead ?? vi.fn();
  const onMultiHostEnabledChange = opts.onMultiHostEnabledChange ?? vi.fn();
  const onSelectedHostIdsChange = opts.onSelectedHostIdsChange ?? vi.fn();
  const utils = render(
    <MultiHostPicker
      projectId="proj-1"
      hosts={opts.hosts}
      currentHostId={opts.currentHostId}
      selectedHostIds={opts.selectedHostIds ?? []}
      multiHostEnabled={opts.multiHostEnabled ?? false}
      onMultiHostEnabledChange={onMultiHostEnabledChange}
      onSelectedHostIdsChange={onSelectedHostIdsChange}
      onPromoteLead={onPromoteLead}
      maxSelectedHosts={opts.maxSelectedHosts}
    />,
  );
  return { ...utils, onPromoteLead, onMultiHostEnabledChange, onSelectedHostIdsChange };
}

describe("MultiHostPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the lead host name in the trigger", () => {
    renderPicker({ hosts: [hostA], currentHostId: "host-a" });
    expect(screen.getByTestId("multi-host-picker-trigger")).toHaveTextContent(
      "MCPJam",
    );
  });

  it("disables the Multiple hosts switch with a tooltip when only one host exists", async () => {
    const user = userEvent.setup();
    renderPicker({ hosts: [hostA], currentHostId: "host-a" });

    await user.click(screen.getByTestId("multi-host-picker-trigger"));

    const toggle = await screen.findByTestId("multi-host-toggle");
    expect(toggle).toBeDisabled();
  });

  it("calls onPromoteLead when picking another host in single-mode", async () => {
    const user = userEvent.setup();
    const { onPromoteLead } = renderPicker({
      hosts: [hostA, hostB],
      currentHostId: "host-a",
    });

    await user.click(screen.getByTestId("multi-host-picker-trigger"));

    await waitFor(() =>
      expect(screen.getByTestId("multi-host-row-host-b")).toBeInTheDocument(),
    );

    await user.click(screen.getByTestId("multi-host-row-host-b"));

    expect(onPromoteLead).toHaveBeenCalledWith("host-b");
  });

  it("toggles Multiple hosts on, shows chip strip with current lead, and renders checkboxes", async () => {
    const user = userEvent.setup();
    const onMultiHostEnabledChange = vi.fn();
    const onSelectedHostIdsChange = vi.fn();
    renderPicker({
      hosts: [hostA, hostB],
      currentHostId: "host-a",
      onMultiHostEnabledChange,
      onSelectedHostIdsChange,
    });

    await user.click(screen.getByTestId("multi-host-picker-trigger"));

    const toggle = await screen.findByTestId("multi-host-toggle");
    expect(toggle).not.toBeDisabled();

    await user.click(toggle);

    expect(onMultiHostEnabledChange).toHaveBeenCalledWith(true);
    expect(onSelectedHostIdsChange).toHaveBeenCalledWith(["host-a"]);
  });

  it("with multi-host enabled, shows the chip strip including the lead and renders checkbox affordances", async () => {
    const user = userEvent.setup();
    renderPicker({
      hosts: [hostA, hostB],
      currentHostId: "host-a",
      selectedHostIds: ["host-a"],
      multiHostEnabled: true,
    });

    await user.click(screen.getByTestId("multi-host-picker-trigger"));

    await waitFor(() =>
      expect(screen.getByTestId("multi-host-chip-strip")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("multi-host-chip-host-a")).toHaveTextContent(
      "MCPJam",
    );
    expect(
      screen.getByTestId("multi-host-checkbox-host-a"),
    ).toHaveAttribute("data-checked", "true");
    expect(
      screen.getByTestId("multi-host-checkbox-host-b"),
    ).toHaveAttribute("data-checked", "false");
  });

  it("selecting a second host in multi-mode appends it to selectedHostIds", async () => {
    const user = userEvent.setup();
    const onSelectedHostIdsChange = vi.fn();
    renderPicker({
      hosts: [hostA, hostB],
      currentHostId: "host-a",
      selectedHostIds: ["host-a"],
      multiHostEnabled: true,
      onSelectedHostIdsChange,
    });

    await user.click(screen.getByTestId("multi-host-picker-trigger"));

    await waitFor(() =>
      expect(screen.getByTestId("multi-host-row-host-b")).toBeInTheDocument(),
    );

    await user.click(screen.getByTestId("multi-host-row-host-b"));

    expect(onSelectedHostIdsChange).toHaveBeenCalledWith(["host-a", "host-b"]);
  });

  it("blocks deselecting the last selected host (length never reaches zero)", async () => {
    const user = userEvent.setup();
    const onSelectedHostIdsChange = vi.fn();
    renderPicker({
      hosts: [hostA, hostB],
      currentHostId: "host-a",
      selectedHostIds: ["host-a"],
      multiHostEnabled: true,
      onSelectedHostIdsChange,
    });

    await user.click(screen.getByTestId("multi-host-picker-trigger"));

    await waitFor(() =>
      expect(screen.getByTestId("multi-host-row-host-a")).toBeInTheDocument(),
    );

    await user.click(screen.getByTestId("multi-host-row-host-a"));

    expect(onSelectedHostIdsChange).not.toHaveBeenCalled();
  });

  it("clicking a non-lead chip promotes that host to lead", async () => {
    const user = userEvent.setup();
    const onPromoteLead = vi.fn();
    renderPicker({
      hosts: [hostA, hostB],
      currentHostId: "host-a",
      selectedHostIds: ["host-a", "host-b"],
      multiHostEnabled: true,
      onPromoteLead,
    });

    await user.click(screen.getByTestId("multi-host-picker-trigger"));

    await waitFor(() =>
      expect(screen.getByTestId("multi-host-chip-host-b")).toBeInTheDocument(),
    );

    await user.click(screen.getByTestId("multi-host-chip-host-b"));

    expect(onPromoteLead).toHaveBeenCalledWith("host-b");
  });

  it("disables unselected rows when selection has hit the max-selected limit", async () => {
    const user = userEvent.setup();
    renderPicker({
      hosts: [hostA, hostB, hostC, hostD],
      currentHostId: "host-a",
      selectedHostIds: ["host-a", "host-b", "host-c"],
      multiHostEnabled: true,
      maxSelectedHosts: 3,
    });

    await user.click(screen.getByTestId("multi-host-picker-trigger"));

    await waitFor(() =>
      expect(screen.getByTestId("multi-host-row-host-d")).toBeInTheDocument(),
    );

    const rowD = screen.getByTestId("multi-host-row-host-d");
    expect(rowD).toHaveAttribute("data-disabled", "true");

    // Already-selected rows stay enabled so the user can deselect them.
    const rowA = screen.getByTestId("multi-host-row-host-a");
    expect(rowA).not.toHaveAttribute("data-disabled", "true");
  });

  it("does not render an X (remove) affordance on the lead chip, but does on secondary chips", async () => {
    const user = userEvent.setup();
    renderPicker({
      hosts: [hostA, hostB, hostC],
      currentHostId: "host-a",
      selectedHostIds: ["host-a", "host-b", "host-c"],
      multiHostEnabled: true,
    });

    await user.click(screen.getByTestId("multi-host-picker-trigger"));

    await waitFor(() =>
      expect(screen.getByTestId("multi-host-chip-strip")).toBeInTheDocument(),
    );

    // Lead (slot 0) has NO remove button.
    expect(
      screen.queryByTestId("multi-host-chip-remove-host-a"),
    ).not.toBeInTheDocument();
    // Secondaries DO have remove buttons.
    expect(
      screen.getByTestId("multi-host-chip-remove-host-b"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("multi-host-chip-remove-host-c"),
    ).toBeInTheDocument();
  });

  it("clicking a secondary chip's X removes only that host from selectedHostIds", async () => {
    const user = userEvent.setup();
    const onSelectedHostIdsChange = vi.fn();
    renderPicker({
      hosts: [hostA, hostB, hostC],
      currentHostId: "host-a",
      selectedHostIds: ["host-a", "host-b", "host-c"],
      multiHostEnabled: true,
      onSelectedHostIdsChange,
    });

    await user.click(screen.getByTestId("multi-host-picker-trigger"));

    await waitFor(() =>
      expect(
        screen.getByTestId("multi-host-chip-remove-host-b"),
      ).toBeInTheDocument(),
    );

    await user.click(screen.getByTestId("multi-host-chip-remove-host-b"));

    expect(onSelectedHostIdsChange).toHaveBeenCalledWith(["host-a", "host-c"]);
  });

  it("shows +N in the trigger when multi-host has more than one selected", () => {
    renderPicker({
      hosts: [hostA, hostB, hostC],
      currentHostId: "host-a",
      selectedHostIds: ["host-a", "host-b", "host-c"],
      multiHostEnabled: true,
    });

    expect(screen.getByTestId("multi-host-picker-trigger")).toHaveTextContent(
      "MCPJam +2",
    );
  });
});

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

  it("renders a 'Compare' affordance in the trigger when not actively comparing (single-host or multi-host with <=1 selected)", () => {
    // The navbar `ClientOverlayBar` already shows the lead host name +
    // cycle controls. Repeating the name here would just duplicate it,
    // so the playground trigger collapses to a `Compare` affordance
    // until the user actually has >1 host selected.
    renderPicker({ hosts: [hostA], currentHostId: "host-a" });
    const trigger = screen.getByTestId("multi-host-picker-trigger");
    expect(trigger).toHaveTextContent("Compare");
    expect(trigger).not.toHaveTextContent("MCPJam");
    expect(trigger).toHaveAttribute("data-compare-mode", "idle");
  });

  it("trigger flips to the 'lead +N' label only once multi-host has >1 selected", () => {
    renderPicker({
      hosts: [hostA, hostB],
      currentHostId: "host-a",
      // Multi-host enabled but only the lead is in the slot — still
      // shows "Compare" (no comparison happening yet).
      selectedHostIds: ["host-a"],
      multiHostEnabled: true,
    });
    expect(screen.getByTestId("multi-host-picker-trigger")).toHaveTextContent(
      "Compare",
    );
    expect(screen.getByTestId("multi-host-picker-trigger")).toHaveAttribute(
      "data-compare-mode",
      "idle",
    );
  });

  it("shows an empty-state hint inside the popover when the project has only one client", async () => {
    // The 'Multiple hosts' toggle was removed — compare mode is now
    // implicit on selection count. With only one client there's
    // nothing to compare against, so we surface a hint instead of a
    // disabled toggle.
    const user = userEvent.setup();
    renderPicker({ hosts: [hostA], currentHostId: "host-a" });

    await user.click(screen.getByTestId("multi-host-picker-trigger"));

    expect(
      await screen.findByText("Add a second client to start comparing."),
    ).toBeInTheDocument();
    // The old toggle is gone entirely.
    expect(screen.queryByTestId("multi-host-toggle")).toBeNull();
  });

  it("selecting a second client from single-host implicitly enters compare mode", async () => {
    // Old behavior: a separate toggle had to be flipped first. New
    // behavior: the trigger is a "Compare" affordance and the popover
    // is multi-select from the jump — adding a 2nd client both grows
    // `selectedHostIds` and enables `multiHostEnabled`.
    const user = userEvent.setup();
    const { onPromoteLead, onMultiHostEnabledChange, onSelectedHostIdsChange } =
      renderPicker({
        hosts: [hostA, hostB],
        currentHostId: "host-a",
      });

    await user.click(screen.getByTestId("multi-host-picker-trigger"));

    await waitFor(() =>
      expect(screen.getByTestId("multi-host-row-host-b")).toBeInTheDocument(),
    );

    await user.click(screen.getByTestId("multi-host-row-host-b"));

    expect(onSelectedHostIdsChange).toHaveBeenCalledWith(["host-a", "host-b"]);
    expect(onMultiHostEnabledChange).toHaveBeenCalledWith(true);
    // Lead-swap is the navbar's job now; the playground popover never
    // calls `onPromoteLead` from row clicks.
    expect(onPromoteLead).not.toHaveBeenCalled();
  });

  it("removing back to a single client exits compare mode (multi-host disabled)", async () => {
    const user = userEvent.setup();
    const { onMultiHostEnabledChange, onSelectedHostIdsChange } = renderPicker({
      hosts: [hostA, hostB],
      currentHostId: "host-a",
      selectedHostIds: ["host-a", "host-b"],
      multiHostEnabled: true,
    });

    await user.click(screen.getByTestId("multi-host-picker-trigger"));

    await waitFor(() =>
      expect(screen.getByTestId("multi-host-row-host-b")).toBeInTheDocument(),
    );

    // Deselecting host-b leaves just the lead → compare collapses.
    await user.click(screen.getByTestId("multi-host-row-host-b"));

    expect(onSelectedHostIdsChange).toHaveBeenCalledWith(["host-a"]);
    expect(onMultiHostEnabledChange).toHaveBeenCalledWith(false);
  });

  it("chip strip only appears once compare is active (>1 selected)", async () => {
    // With only the lead present, the strip is hidden — there's
    // nothing to compare yet, so showing a single chip would be
    // visual noise.
    const user = userEvent.setup();
    renderPicker({
      hosts: [hostA, hostB],
      currentHostId: "host-a",
      selectedHostIds: ["host-a"],
      multiHostEnabled: true,
    });

    await user.click(screen.getByTestId("multi-host-picker-trigger"));

    await waitFor(() =>
      expect(screen.getByTestId("multi-host-row-host-a")).toBeInTheDocument(),
    );

    expect(screen.queryByTestId("multi-host-chip-strip")).toBeNull();
    // Checkboxes still render (popover is always multi-select).
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

  it("shows the lead name + N badge in the trigger when multi-host has more than one selected", () => {
    renderPicker({
      hosts: [hostA, hostB, hostC],
      currentHostId: "host-a",
      selectedHostIds: ["host-a", "host-b", "host-c"],
      multiHostEnabled: true,
    });

    const trigger = screen.getByTestId("multi-host-picker-trigger");
    expect(trigger).toHaveTextContent("MCPJam +2");
    expect(trigger).toHaveAttribute("data-compare-mode", "active");
  });
});

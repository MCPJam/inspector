/**
 * The `writing` latch, at the only level it is reachable.
 *
 * Every control that reaches these handlers carries `disabled={busy}`, and
 * React flushes a discrete event synchronously — so by the time a second
 * `fireEvent` runs, the DOM already refuses it and jsdom fires nothing. That
 * is why the sibling suite's four "freezes the rows" tests pass with the latch
 * deleted: they prove the freeze, which is a different mechanism.
 *
 * The latch guards the other side of the same door. `ServerPicker` hands three
 * async callbacks to a component in ANOTHER package; nothing in its own types
 * says that component will freeze its controls, and a panel that stopped doing
 * so would reopen the window in silence. So the panel is replaced here with
 * one that does not freeze anything, and the callbacks are invoked the way a
 * careless panel would — twice, before the first write lands.
 *
 * Mocking the panel is the whole point rather than a shortcut: it is the
 * boundary the latch defends, and it cannot be crossed through the real one.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockState } = vi.hoisted(() => ({
  mockState: {
    attachments: [] as any[],
    createSpy: vi.fn(),
    deleteSpy: vi.fn(),
    panel: null as Record<string, any> | null,
  },
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useMutation: (name: string) =>
    name.includes("delete") ? mockState.deleteSpy : mockState.createSpy,
}));

vi.mock("@/hooks/useViews", () => ({
  useProjectServerAttachments: () => ({
    serverAttachments: mockState.attachments,
    isLoading: false,
    isBootstrapping: false,
  }),
  useProjectServers: () => ({
    servers: [{ _id: "srv_1", name: "alpha" }],
    isLoading: false,
    isBootstrapping: false,
  }),
}));

vi.mock("@/state/app-state-context", () => ({
  useOptionalSharedAppState: () => ({
    servers: { alpha: { connectionStatus: "connected" } },
  }),
}));

vi.mock("@/state/server-actions-context", () => ({
  useServerActionsOptional: () => null,
}));

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/app-navigation", () => ({
  navigateApp: vi.fn(),
  routePaths: { servers: "/servers" },
}));

// A panel that freezes NOTHING. It renders no controls at all — the test
// calls the callbacks directly, which is precisely what a panel with a broken
// `disabled` would end up doing.
vi.mock("@mcpjam/design-system/server-picker-panel", () => ({
  ServerPickerPanel: (props: Record<string, any>) => {
    mockState.panel = props;
    return null;
  },
}));

import { ServerPicker } from "../server-picker";

const GROUP = {
  _id: "att_1",
  name: "group one",
  serverIds: ["srv_1"],
  resolvedServerNames: ["alpha"],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockState.attachments = [];
  mockState.panel = null;
  // Never settles, so the first call is still in flight when the second
  // arrives — the window the latch exists to close.
  mockState.createSpy = vi.fn(() => new Promise(() => {}));
  mockState.deleteSpy = vi.fn(() => new Promise(() => {}));
});

/** Render, open the popover so the panel mounts, and hand back its props. */
function panel(onChange = vi.fn(() => new Promise(() => {}))) {
  render(
    <ServerPicker
      projectId="p_1"
      value={null}
      onChange={onChange as any}
      onClearSelection={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByTestId("server-picker-trigger"));
  if (!mockState.panel) throw new Error("panel never rendered");
  return mockState.panel;
}

describe("ServerPicker — a panel that does not freeze its own controls", () => {
  it("mints once when onSelectServer fires twice before the write lands", async () => {
    const { onSelectServer } = panel();

    await act(async () => {
      onSelectServer("srv_1");
      onSelectServer("srv_1");
    });

    // Twice would write the duplicate row the backend then rejects on its name.
    expect(mockState.createSpy).toHaveBeenCalledTimes(1);
  });

  it("reports one selection when onSelectGroup fires twice", async () => {
    mockState.attachments = [GROUP, { ...GROUP, _id: "att_2", name: "two" }];
    const onChange = vi.fn(() => new Promise(() => {}));
    const { onSelectGroup } = panel(onChange);

    await act(async () => {
      onSelectGroup("att_1");
      onSelectGroup("att_2");
    });

    // The second `onChange` would land last and overwrite the first — the
    // picker would show a group the user's second click never settled on.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("att_1", expect.anything());
  });

  it("deletes once when onDeleteGroup fires twice", async () => {
    mockState.attachments = [GROUP];
    const { onDeleteGroup } = panel();

    await act(async () => {
      onDeleteGroup("att_1");
      onDeleteGroup("att_1");
    });

    expect(mockState.deleteSpy).toHaveBeenCalledTimes(1);
    expect(mockState.deleteSpy).toHaveBeenCalledWith({
      serverAttachmentId: "att_1",
    });
  });

  it("refuses a SERVER pick while a GROUP pick is still in flight", async () => {
    mockState.attachments = [GROUP];
    const onChange = vi.fn(() => new Promise(() => {}));
    const p = panel(onChange);

    await act(async () => {
      p.onSelectGroup("att_1");
      // A different handler, so `busy` is the only thing between them in the
      // real panel — and here there is no `busy`.
      p.onSelectServer("srv_1");
    });

    expect(mockState.createSpy).not.toHaveBeenCalled();
  });
});

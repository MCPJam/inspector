/**
 * The data-bound picker: trigger + popover + panel.
 *
 * The risky part is the find-or-create. Storage has no column for "a bare
 * server", so picking one on the Servers tab resolves to the `serverAttachments`
 * row that holds exactly that server — REUSING one when it exists, minting one
 * named after the server when it does not. Getting that wrong either writes a
 * duplicate row per click or silently attaches servers the user never picked.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockState } = vi.hoisted(() => ({
  mockState: {
    attachments: [] as any[],
    servers: undefined as any[] | undefined,
    runtime: null as Record<string, { connectionStatus: string }> | null,
    createSpy: vi.fn(),
    ensureReady: vi.fn(),
    navigate: vi.fn(),
  },
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useMutation: () => mockState.createSpy,
}));

vi.mock("@/hooks/useViews", () => ({
  useProjectServerAttachments: () => ({
    serverAttachments: mockState.attachments,
    isLoading: false,
  }),
  useProjectServers: () => ({ servers: mockState.servers }),
}));

vi.mock("@/state/app-state-context", () => ({
  useOptionalSharedAppState: () =>
    mockState.runtime === null ? null : { servers: mockState.runtime },
}));

vi.mock("@/state/server-actions-context", () => ({
  useServerActionsOptional: () =>
    mockState.runtime === null
      ? null
      : { ensureServersReady: mockState.ensureReady },
}));

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/app-navigation", () => ({
  navigateApp: (...args: unknown[]) => mockState.navigate(...args),
  routePaths: { servers: "/servers" },
}));


import { toast } from "@/lib/toast";
import { ServerPicker } from "../server-picker";

const CATALOG = [
  { _id: "srv_1", name: "alpha" },
  { _id: "srv_2", name: "beta" },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockState.attachments = [];
  mockState.servers = CATALOG;
  mockState.runtime = { alpha: { connectionStatus: "connected" } };
  mockState.createSpy = vi.fn().mockResolvedValue({ _id: "att_new" });
  mockState.ensureReady = vi.fn().mockResolvedValue({
    readyServerNames: ["alpha"],
    missingServerNames: [],
    failedServerNames: [],
    reauthServerNames: [],
  });
  mockState.navigate = vi.fn();
});

function open(onChange = vi.fn()) {
  render(<ServerPicker projectId="p_1" value={null} onChange={onChange} />);
  fireEvent.click(screen.getByTestId("server-picker-trigger"));
  return onChange;
}

/**
 * The row button for one server. By id, not by accessible name: the trigger
 * names the selected server too, and the row's name is the status label run
 * onto the server name with no separator.
 */
async function serverRow(serverId: string): Promise<HTMLElement> {
  const dot = await screen.findByTestId(`server-status-dot-${serverId}`);
  const row = dot.closest("button");
  if (!row) throw new Error(`No row button around the dot for ${serverId}`);
  return row;
}

describe("ServerPicker — picking a bare server", () => {
  it("REUSES the row that already holds exactly that server", async () => {
    mockState.attachments = [
      { _id: "att_solo", name: "alpha", serverIds: ["srv_1"], resolvedServerNames: ["alpha"] },
    ];
    const onChange = open();

    fireEvent.click(await screen.findByText("alpha"));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls[0][0]).toBe("att_solo");
    // The whole point of find-or-create: no second row for the same server.
    expect(mockState.createSpy).not.toHaveBeenCalled();
  });

  it("mints a row named after the server when none exists", async () => {
    const onChange = open();
    fireEvent.click(await screen.findByText("alpha"));

    await waitFor(() => expect(mockState.createSpy).toHaveBeenCalledTimes(1));
    expect(mockState.createSpy).toHaveBeenCalledWith({
      projectId: "p_1",
      name: "alpha",
      serverIds: ["srv_1"],
    });
    expect(onChange.mock.calls[0][0]).toBe("att_new");
  });

  it("mints a stand-in rather than reusing a group the user named", async () => {
    // Picking a SERVER must select that server, not a group that happens to
    // hold only it — otherwise the trigger names the group.
    mockState.attachments = [
      { _id: "att_named", name: "group A", serverIds: ["srv_1"], resolvedServerNames: ["alpha"] },
    ];
    const onChange = open();
    fireEvent.click(await screen.findByText("alpha"));

    await waitFor(() => expect(mockState.createSpy).toHaveBeenCalledTimes(1));
    expect(mockState.createSpy.mock.calls[0][0]).toMatchObject({
      name: "alpha",
      serverIds: ["srv_1"],
    });
    expect(onChange.mock.calls[0][0]).toBe("att_new");
  });

  it("never reuses a multi-server row that merely contains the server", async () => {
    mockState.attachments = [
      { _id: "att_pair", name: "alpha + 1", serverIds: ["srv_1", "srv_2"], resolvedServerNames: ["alpha", "beta"] },
    ];
    open();
    fireEvent.click(await screen.findByText("alpha"));

    // Reusing it would silently attach `beta` to the selection.
    await waitFor(() => expect(mockState.createSpy).toHaveBeenCalledTimes(1));
  });

  it("suffixes the minted name when the server's name is taken", async () => {
    mockState.attachments = [
      { _id: "att_other", name: "alpha", serverIds: ["srv_2"], resolvedServerNames: ["beta"] },
    ];
    open();
    fireEvent.click(await screen.findByText("alpha"));

    await waitFor(() => expect(mockState.createSpy).toHaveBeenCalled());
    expect(mockState.createSpy.mock.calls[0][0].name).toBe("alpha 2");
  });
});

describe("ServerPicker — the Groups tab", () => {
  it("hides the rows that stand in for a single server", async () => {
    mockState.attachments = [
      { _id: "att_solo", name: "alpha", serverIds: ["srv_1"], resolvedServerNames: ["alpha"] },
      { _id: "att_pair", name: "alpha + 1", serverIds: ["srv_1", "srv_2"], resolvedServerNames: ["alpha", "beta"] },
    ];
    open();
    await userEvent.click(
      await screen.findByRole("tab", { name: "Server Groups" }),
    );

    expect(await screen.findByText("alpha + 1")).toBeInTheDocument();
    // `alpha` is reachable on the Servers tab; listing it here too would
    // offer the same choice twice under two names.
    expect(screen.queryByRole("button", { name: /^alpha$/ })).toBeNull();
  });

  it("emits a group id straight through, with no write", async () => {
    mockState.attachments = [
      { _id: "att_pair", name: "alpha + 1", serverIds: ["srv_1", "srv_2"], resolvedServerNames: ["alpha", "beta"] },
    ];
    const onChange = open();
    await userEvent.click(
      await screen.findByRole("tab", { name: "Server Groups" }),
    );
    fireEvent.click(await screen.findByText("alpha + 1"));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls[0][0]).toBe("att_pair");
    expect(mockState.createSpy).not.toHaveBeenCalled();
  });
});

describe("ServerPicker — connection state", () => {
  it("offers Connect on a disconnected server and routes it to the runtime", async () => {
    mockState.runtime = { alpha: { connectionStatus: "disconnected" } };
    open();

    const connects = await screen.findAllByRole("button", { name: /^Connect$/ });
    fireEvent.click(connects[0]);
    expect(mockState.ensureReady).toHaveBeenCalledWith(["alpha"]);
  });

  it("paints each dot with a role token, never a fixed colour", async () => {
    // `getConnectionStatusMeta` still names the state, but its colours are
    // hex and cannot follow the theme.
    mockState.runtime = {
      alpha: { connectionStatus: "connected" },
      beta: { connectionStatus: "failed" },
    };
    open();

    expect(await screen.findByTestId("server-status-dot-srv_1")).toHaveClass(
      "bg-success",
    );
    expect(screen.getByTestId("server-status-dot-srv_2")).toHaveClass(
      "bg-destructive",
    );
    expect(
      screen.getByTestId("server-status-dot-srv_1").getAttribute("style"),
    ).toBeNull();
  });

  it("falls back the DOT the same way the label falls back", async () => {
    // The runtime value is a plain string widened with `as ConnectionStatus`,
    // so a value outside the union reaches here. `getConnectionStatusMeta`
    // answers "Disconnected"; a bare record lookup answers `undefined` and
    // leaves the dot unpainted next to that word.
    mockState.runtime = { alpha: { connectionStatus: "reticulating" } };
    open();

    const dot = await screen.findByTestId("server-status-dot-srv_1");
    expect(dot).toHaveAccessibleName("Disconnected");
    expect(dot).toHaveClass("bg-muted-foreground");
  });

  it("holds the row's alignment without a colour when the state is unknown", async () => {
    mockState.runtime = null;
    open();

    const dot = await screen.findByTestId("server-status-dot-srv_1");
    // Grey would read as `disconnected`, which is a claim we cannot make here.
    expect(dot).toHaveClass("bg-transparent");
    expect(dot).toHaveAccessibleName("Connection state unavailable");
  });

  it("offers no Connect at all when there is no runtime to ask", async () => {
    // Mounted outside the providers: the picker still picks, it just cannot
    // claim to know or change connection state.
    mockState.runtime = null;
    open();

    expect(await screen.findByText("alpha")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Connect$/ })).toBeNull();
  });
});

describe("ServerPicker — trigger", () => {
  it("names the selected server, not the row that carries it", () => {
    mockState.attachments = [
      { _id: "att_solo", name: "alpha", serverIds: ["srv_1"], resolvedServerNames: ["alpha"] },
    ];
    render(
      <ServerPicker projectId="p_1" value="att_solo" onChange={vi.fn()} />,
    );
    expect(screen.getByTestId("server-picker-trigger")).toHaveTextContent("alpha");
  });

  it("falls back to the empty label with nothing selected", () => {
    render(
      <ServerPicker
        projectId="p_1"
        value={null}
        onChange={vi.fn()}
        emptyTriggerLabel="Select server"
      />,
    );
    expect(screen.getByTestId("server-picker-trigger")).toHaveTextContent(
      "Select server",
    );
  });
});

describe("ServerPicker — creating a multi-server group", () => {
  async function openForm() {
    fireEvent.click(screen.getByTestId("server-picker-trigger"));
    await userEvent.click(
      await screen.findByRole("tab", { name: "Server Groups" }),
    );
    await userEvent.click(screen.getByText("Create new group…"));
  }

  it("persists the group and selects it", async () => {
    const onChange = vi.fn();
    render(<ServerPicker projectId="p_1" value={null} onChange={onChange} />);
    await openForm();

    await userEvent.click(screen.getByLabelText("alpha"));
    await userEvent.click(screen.getByLabelText("beta"));
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(mockState.createSpy).toHaveBeenCalledTimes(1));
    expect(mockState.createSpy).toHaveBeenCalledWith({
      projectId: "p_1",
      name: "alpha + 1",
      serverIds: ["srv_1", "srv_2"],
    });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls[0][0]).toBe("att_new");
  });

  it("derives the suggested name against the names already taken", async () => {
    mockState.attachments = [
      { _id: "att_a", name: "alpha", serverIds: ["srv_2"], resolvedServerNames: ["beta"] },
    ];
    render(<ServerPicker projectId="p_1" value={null} onChange={vi.fn()} />);
    await openForm();
    await userEvent.click(screen.getByLabelText("alpha"));

    // `alpha` is taken by another row, so the rule suffixes it.
    expect(screen.getByLabelText("Group name")).toHaveValue("alpha 2");
  });

  it("CLOSING the popover mid-draft creates nothing", async () => {
    // The picker this replaces committed a filled-in draft on click-away.
    // Only Create submits now.
    render(<ServerPicker projectId="p_1" value={null} onChange={vi.fn()} />);
    await openForm();
    await userEvent.click(screen.getByLabelText("alpha"));

    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(mockState.createSpy).not.toHaveBeenCalled();
  });
});

describe("ServerPicker — Connect reports what to fix", () => {
  const disconnected = () => {
    mockState.runtime = { alpha: { connectionStatus: "disconnected" } };
  };
  const outcome = (over: Record<string, string[]>) => {
    mockState.ensureReady = vi.fn().mockResolvedValue({
      readyServerNames: [],
      missingServerNames: [],
      failedServerNames: [],
      reauthServerNames: [],
      ...over,
    });
  };

  it("says nothing when the server comes up", async () => {
    disconnected();
    outcome({ readyServerNames: ["alpha"] });
    open();
    fireEvent.click((await screen.findAllByRole("button", { name: /^Connect$/ }))[0]);
    await waitFor(() => expect(mockState.ensureReady).toHaveBeenCalled());
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("reports a failure with a way out to the servers page", async () => {
    disconnected();
    outcome({ failedServerNames: ["alpha"] });
    open();
    fireEvent.click((await screen.findAllByRole("button", { name: /^Connect$/ }))[0]);

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const [message, options] = (toast.error as any).mock.calls[0];
    expect(message).toContain("alpha");
    // The toast module's own doctrine: the caller supplies the action that
    // points at the exact place the problem can be fixed.
    expect(options.action.label).toMatch(/server/i);
    options.action.onClick();
    expect(mockState.navigate).toHaveBeenCalledWith("/servers");
  });

  it("distinguishes needing authorization from failing", async () => {
    disconnected();
    outcome({ reauthServerNames: ["alpha"] });
    open();
    fireEvent.click((await screen.findAllByRole("button", { name: /^Connect$/ }))[0]);

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect((toast.error as any).mock.calls[0][0]).toMatch(/authoriz/i);
  });
});

describe("ServerPicker — the window before the query refetches", () => {
  it("names the row it just minted, before it appears in the query", async () => {
    // `onChange` lands before Convex refetches, so a selection resolved only
    // from the live list reads as dangling and the trigger falls back to the
    // empty label — right after the user picked something.
    const onChange = vi.fn();
    const { rerender } = render(
      <ServerPicker projectId="p_1" value={null} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId("server-picker-trigger"));
    fireEvent.click(await screen.findByText("alpha"));
    await waitFor(() => expect(onChange).toHaveBeenCalled());

    // The parent commits the id; the query has NOT caught up.
    rerender(
      <ServerPicker projectId="p_1" value="att_new" onChange={onChange} />,
    );
    expect(screen.getByTestId("server-picker-trigger")).toHaveTextContent(
      "alpha",
    );
  });

  it("does not mint a second row when the same server is picked again", async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ServerPicker projectId="p_1" value={null} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId("server-picker-trigger"));
    fireEvent.click(await screen.findByText("alpha"));
    await waitFor(() => expect(mockState.createSpy).toHaveBeenCalledTimes(1));

    rerender(
      <ServerPicker projectId="p_1" value="att_new" onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId("server-picker-trigger"));
    fireEvent.click(await serverRow("srv_1"));

    // Reuse reports the bridged row rather than writing a second one, which
    // would collide on the derived name and be rejected by the backend.
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
    expect(onChange.mock.calls[1][0]).toBe("att_new");
    expect(mockState.createSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps naming the selection when the query outlives the bridge timeout", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const onChange = vi.fn();
      const { rerender } = render(
        <ServerPicker projectId="p_1" value={null} onChange={onChange} />,
      );
      fireEvent.click(screen.getByTestId("server-picker-trigger"));
      fireEvent.click(await screen.findByText("alpha"));
      await waitFor(() => expect(onChange).toHaveBeenCalled());
      rerender(
        <ServerPicker projectId="p_1" value="att_new" onChange={onChange} />,
      );

      // The bridge's timeout exists for a parent that moves `value` elsewhere.
      // No timer is scheduled while the row is still the selection, so time
      // passing cannot take the only thing that can name the trigger.
      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });

      expect(screen.getByTestId("server-picker-trigger")).toHaveTextContent(
        "alpha",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ServerPicker — a write already in flight", () => {
  it("mints once when a row is clicked twice before the write lands", async () => {
    // `creating` is state, so it is not readable by the second click in the
    // same tick. Two rows in a row hits the same window.
    mockState.createSpy = vi.fn(
      () => new Promise(() => {}),
    );
    open();
    const row = await serverRow("srv_1");

    fireEvent.click(row);
    fireEvent.click(row);

    expect(mockState.createSpy).toHaveBeenCalledTimes(1);
  });

  it("ignores REUSING a row while a mint is still in flight", async () => {
    // The reuse path writes nothing, so it looks harmless — but it reports a
    // selection the pending mint's own `onChange` then overwrites.
    mockState.attachments = [
      {
        _id: "att_beta",
        name: "beta",
        serverIds: ["srv_2"],
        resolvedServerNames: ["beta"],
      },
    ];
    mockState.runtime = {
      alpha: { connectionStatus: "connected" },
      beta: { connectionStatus: "connected" },
    };
    mockState.createSpy = vi.fn(
      () => new Promise(() => {}),
    );
    const onChange = open();

    fireEvent.click(await serverRow("srv_1"));
    fireEvent.click(await serverRow("srv_2"));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores picking a GROUP while a mint is still in flight", async () => {
    mockState.attachments = [
      {
        _id: "att_pair",
        name: "pair",
        serverIds: ["srv_1", "srv_2"],
        resolvedServerNames: ["alpha", "beta"],
      },
    ];
    mockState.createSpy = vi.fn(
      () => new Promise(() => {}),
    );
    const onChange = open();

    fireEvent.click(await serverRow("srv_1"));
    await userEvent.click(
      await screen.findByRole("tab", { name: "Server Groups" }),
    );
    fireEvent.click(await screen.findByText("pair"));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores a row while a GROUP create is still in flight", async () => {
    // The latch has to span both write paths, or the form's pending write and
    // a click on the Servers tab race to report a different selection.
    mockState.attachments = [
      {
        _id: "att_alpha",
        name: "alpha",
        serverIds: ["srv_1"],
        resolvedServerNames: ["alpha"],
      },
    ];
    mockState.createSpy = vi.fn(() => new Promise(() => {}));
    const onChange = open();

    await userEvent.click(
      await screen.findByRole("tab", { name: "Server Groups" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /new group/i }),
    );
    await userEvent.click(await screen.findByRole("checkbox", { name: "beta" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Create$/ }));

    await userEvent.click(await screen.findByRole("tab", { name: "Servers" }));
    fireEvent.click(await serverRow("srv_1"));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores a second server while the first is still being written", async () => {
    mockState.runtime = {
      alpha: { connectionStatus: "connected" },
      beta: { connectionStatus: "connected" },
    };
    mockState.createSpy = vi.fn(
      () => new Promise(() => {}),
    );
    open();

    fireEvent.click(await serverRow("srv_1"));
    fireEvent.click(await serverRow("srv_2"));

    expect(mockState.createSpy).toHaveBeenCalledTimes(1);
    expect(mockState.createSpy.mock.calls[0][0].serverIds).toEqual(["srv_1"]);
  });
});

describe("ServerPicker — clearing back to no selection", () => {
  const SOLO = {
    _id: "att_solo",
    name: "alpha",
    serverIds: ["srv_1"],
    resolvedServerNames: ["alpha"],
  };

  it("offers a clear control only where the caller can act on it", () => {
    // Surfaces that require a server pass no handler; offering them a control
    // that leads nowhere would promise a state they do not accept.
    mockState.attachments = [SOLO];
    render(
      <ServerPicker projectId="p_1" value="att_solo" onChange={vi.fn()} />,
    );
    expect(screen.queryByTestId("server-picker-clear")).toBeNull();
  });

  it("reports the clear instead of guessing an id for it", () => {
    mockState.attachments = [SOLO];
    const onClearSelection = vi.fn();
    render(
      <ServerPicker
        projectId="p_1"
        value="att_solo"
        onChange={vi.fn()}
        onClearSelection={onClearSelection}
      />,
    );

    fireEvent.click(screen.getByTestId("server-picker-clear"));
    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });

  it("shows nothing to clear when nothing is selected", () => {
    render(
      <ServerPicker
        projectId="p_1"
        value={null}
        onChange={vi.fn()}
        onClearSelection={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("server-picker-clear")).toBeNull();
  });
});

describe("ServerPicker — a create that fails", () => {
  it("rethrows so the panel can keep the draft", async () => {
    mockState.createSpy = vi.fn().mockRejectedValue(new Error("already exists"));
    render(<ServerPicker projectId="p_1" value={null} onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId("server-picker-trigger"));
    await userEvent.click(
      await screen.findByRole("tab", { name: "Server Groups" }),
    );
    await userEvent.click(screen.getByText("Create new group…"));
    await userEvent.click(screen.getByLabelText("alpha"));
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    // Swallowing the rejection would let the panel clear the form.
    expect(screen.getByLabelText("Group name")).toBeInTheDocument();
  });

  it("still lets Escape dismiss the popover mid-create", async () => {
    let release!: () => void;
    mockState.createSpy = vi
      .fn()
      .mockImplementation(() => new Promise((r) => (release = () => r({ _id: "x" }))));
    render(<ServerPicker projectId="p_1" value={null} onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId("server-picker-trigger"));
    fireEvent.click(await screen.findByText("alpha"));

    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("tab", { name: "Servers" })).toBeNull(),
    );
    release();
  });
});

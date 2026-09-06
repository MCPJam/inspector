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
    attachmentsLoading: false,
    servers: undefined as any[] | undefined,
    catalogLoading: false,
    runtime: null as Record<string, { connectionStatus: string }> | null,
    // Separate from `runtime`: the two providers are independent, and a
    // surface can sit inside SharedAppState but outside ServerActions. Driving
    // both from one switch made every `actions` guard unfalsifiable.
    hasActions: true,
    createSpy: vi.fn(),
    deleteSpy: vi.fn(),
    ensureReady: vi.fn(),
    navigate: vi.fn(),
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
    isLoading: mockState.attachmentsLoading,
  }),
  useProjectServers: () => ({
    servers: mockState.servers,
    isLoading: mockState.catalogLoading,
  }),
}));

vi.mock("@/state/app-state-context", () => ({
  useOptionalSharedAppState: () =>
    mockState.runtime === null ? null : { servers: mockState.runtime },
}));

vi.mock("@/state/server-actions-context", () => ({
  useServerActionsOptional: () =>
    mockState.hasActions
      ? { ensureServersReady: mockState.ensureReady }
      : null,
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
import { isServerStandIn } from "../server-picker-model";

const CATALOG = [
  { _id: "srv_1", name: "alpha" },
  { _id: "srv_2", name: "beta" },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockState.attachments = [];
  mockState.attachmentsLoading = false;
  mockState.servers = CATALOG;
  mockState.catalogLoading = false;
  mockState.runtime = { alpha: { connectionStatus: "connected" } };
  mockState.hasActions = true;
  mockState.createSpy = vi.fn().mockResolvedValue({ _id: "att_new" });
  mockState.deleteSpy = vi.fn().mockResolvedValue(undefined);
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

  it("REUSES the suffixed row it minted, instead of minting again", async () => {
    // The name `alpha` is taken by a group holding a different server, so the
    // stand-in lands as `alpha 2`. Not recognising our own suffix meant the
    // next click minted `alpha 3`, then `alpha 4`, unbounded — and nothing in
    // the app can delete them.
    mockState.attachments = [
      { _id: "att_other", name: "alpha", serverIds: ["srv_2"], resolvedServerNames: ["beta"] },
      { _id: "att_sfx", name: "alpha 2", serverIds: ["srv_1"], resolvedServerNames: ["alpha"] },
    ];
    const onChange = open();

    fireEvent.click(await serverRow("srv_1"));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls[0][0]).toBe("att_sfx");
    expect(mockState.createSpy).not.toHaveBeenCalled();
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
    // Both the word and the colour come from `getConnectionStatusMeta`, whose
    // dot is a role token. The `style` assertion below is the half that keeps
    // it honest: the helper used to carry a hex painted through inline style,
    // which reads the same in dark mode as in light.
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
    // so a value outside the union reaches here. The helper's own fallback
    // answers "Disconnected" for both halves at once; reading the word and
    // the colour from two places is how they came to disagree.
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

  it("offers no Connect when the actions provider is absent but state is not", async () => {
    // The reachable half of the old single-switch test: inside SharedAppState,
    // outside ServerActions. Connect would call a provider that is not there.
    mockState.runtime = { alpha: { connectionStatus: "disconnected" } };
    mockState.hasActions = false;
    open();

    expect(await screen.findByText("alpha")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Connect$/ })).toBeNull();
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
    // Deliberately a TWO-server pick. It used to tick one and expect
    // `alpha 2`, but a one-server group named after its server is what
    // `isServerStandIn` reads as "not a group", so suggesting that hid the
    // group the user was making. The collision rule this covers is unchanged.
    mockState.attachments = [
      { _id: "att_a", name: "alpha + 1", serverIds: ["srv_2"], resolvedServerNames: ["beta"] },
    ];
    render(<ServerPicker projectId="p_1" value={null} onChange={vi.fn()} />);
    await openForm();
    await userEvent.click(screen.getByLabelText("alpha"));
    await userEvent.click(screen.getByLabelText("beta"));

    expect(screen.getByLabelText("Group name")).toHaveValue("alpha + 1 2");
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

    // Anchored on the close actually landing, not on a stopwatch. A fixed
    // delay asserts nothing observable: it passes by default, and fails open
    // the moment a commit is scheduled a tick past whatever window someone
    // picked. Radix unmounts the content, so its absence IS the transition —
    // and the commit this guards against was synchronous in the close.
    await waitFor(() =>
      expect(screen.queryByLabelText("Group name")).toBeNull(),
    );
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

  it("survives a parent whose value only returns through its own mutation", async () => {
    // The suite bar commits through an awaited `updateSuite`, so `value` is
    // still the OLD id at mint time and stays there for the round trip. A
    // deadline short enough to bite during that drops the only thing that can
    // name the trigger — over a row that WAS written.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const onChange = vi.fn();
      render(
        <ServerPicker projectId="p_1" value={null} onChange={onChange} />,
      );
      fireEvent.click(screen.getByTestId("server-picker-trigger"));
      fireEvent.click(await screen.findByText("alpha"));
      await waitFor(() => expect(onChange).toHaveBeenCalled());

      // `value` has NOT come back yet, and the query has not refetched.
      await act(async () => {
        vi.advanceTimersByTime(8_000);
      });

      // Re-picking must still find the row it already wrote.
      fireEvent.click(screen.getByTestId("server-picker-trigger"));
      fireEvent.click(await serverRow("srv_1"));
      await waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
      expect(mockState.createSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
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
    // What stops the second click here is `busy` disabling the row: React
    // flushes a discrete event synchronously, so the DOM already carries
    // `disabled` by the time the second `fireEvent` runs, and jsdom does not
    // fire a click on a disabled button.
    //
    // That is worth stating because it means this test does NOT exercise the
    // `writing` ref — it passes with or without it. The window that ref
    // closes is two events reaching a handler before React commits, which
    // this environment cannot produce for exactly the reason above. The ref
    // is a backstop for the paths that do not go through a disabled control.
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

  /**
   * The latch, made observable.
   *
   * Its same-tick window is unreachable from jsdom, but the OTHER thing it
   * holds is not: a selection that reports through an async `onChange` is not
   * finished when the handler returns, and the latch spans that wait. Both
   * cases below hang the caller's commit and then try a second pick.
   */
  it("holds while a REUSED row's async commit is still in flight", async () => {
    mockState.attachments = [
      {
        _id: "att_alpha",
        name: "alpha",
        serverIds: ["srv_1"],
        resolvedServerNames: ["alpha"],
      },
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
    // Never settles: the parent is still writing.
    const onChange = vi.fn(() => new Promise(() => {}));
    render(<ServerPicker projectId="p_1" value={null} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("server-picker-trigger"));

    fireEvent.click(await serverRow("srv_1"));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    fireEvent.click(await serverRow("srv_2"));

    // Nothing writes here, so `busy` never goes up and the disabled attribute
    // cannot be what refuses the second click — only the latch can.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("att_alpha", expect.anything());
  });

  it("holds while a GROUP pick's async commit is still in flight", async () => {
    mockState.attachments = [
      {
        _id: "att_p",
        name: "prod pair",
        serverIds: ["srv_1", "srv_2"],
        resolvedServerNames: ["alpha", "beta"],
      },
      {
        _id: "att_s",
        name: "staging pair",
        serverIds: ["srv_1", "srv_2"],
        resolvedServerNames: ["alpha", "beta"],
      },
    ];
    const onChange = vi.fn(() => new Promise(() => {}));
    render(<ServerPicker projectId="p_1" value={null} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("server-picker-trigger"));
    await userEvent.click(
      await screen.findByRole("tab", { name: "Server Groups" }),
    );

    fireEvent.click(await screen.findByText("prod pair"));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByText("staging pair"));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("att_p", expect.anything());
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

describe("ServerPicker — refusals the user can see", () => {
  it("disables the rows while its own write is in flight", async () => {
    // The handlers refuse a second write by returning. Left enabled, the rows
    // read as broken rather than as busy.
    mockState.createSpy = vi.fn(() => new Promise(() => {}));
    open();
    fireEvent.click(await serverRow("srv_1"));

    await waitFor(() => expect(serverRow("srv_2")).resolves.toBeDisabled());
  });

  it("withholds Delete from a disabled picker, not only the rows", async () => {
    mockState.attachments = [
      { _id: "att_p", name: "prod pair", serverIds: ["srv_1", "srv_2"], resolvedServerNames: ["alpha", "beta"] },
    ];
    // Opened FIRST, then disabled: a disabled trigger cannot be clicked, so
    // rendering straight into that state leaves the panel unmounted and the
    // query vacuously null.
    const { rerender } = render(
      <ServerPicker projectId="p_1" value={null} onChange={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId("server-picker-trigger"));
    await userEvent.click(
      await screen.findByRole("tab", { name: "Server Groups" }),
    );
    expect(
      await screen.findByRole("button", { name: "Delete prod pair" }),
    ).toBeInTheDocument();

    rerender(
      <ServerPicker projectId="p_1" value={null} onChange={vi.fn()} disabled />,
    );
    expect(screen.queryByRole("button", { name: /^Delete / })).toBeNull();
  });

  it("hands `disabled` to the panel, not just to the trigger", async () => {
    // The strip can disable the picker while its popover is already open —
    // greying the trigger leaves the open rows fully clickable.
    const onChange = vi.fn();
    const { rerender } = render(
      <ServerPicker projectId="p_1" value={null} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId("server-picker-trigger"));
    await serverRow("srv_1");

    rerender(
      <ServerPicker
        projectId="p_1"
        value={null}
        onChange={onChange}
        disabled
      />,
    );
    expect(await serverRow("srv_1")).toBeDisabled();
  });
});

describe("ServerPicker — before the attachment list has answered", () => {
  // `useProjectServerAttachments` returns `serverAttachments ?? []`, so an
  // unanswered query is an empty list. Reading that as "no such row" makes a
  // live selection look deleted — and every action taken on that reading is
  // taken against a list we have not seen.
  beforeEach(() => {
    mockState.attachmentsLoading = true;
    mockState.attachments = [];
  });

  it("offers no clear control over a selection it cannot see", () => {
    render(
      <ServerPicker
        projectId="p_1"
        value="att_solo"
        onChange={vi.fn()}
        onClearSelection={vi.fn()}
      />,
    );
    // The row is not in the list yet, so the X would delete a selection whose
    // name we cannot even render.
    expect(screen.queryByTestId("server-picker-clear")).toBeNull();
  });

  it("does not dress the trigger as though a selection resolved", () => {
    render(
      <ServerPicker projectId="p_1" value="att_solo" onChange={vi.fn()} />,
    );
    // Solid border is the "this is set" affordance; pairing it with the empty
    // label says both things at once.
    expect(screen.getByTestId("server-picker-trigger").className).toContain(
      "border-dashed",
    );
  });

  it("writes nothing, because the row it would reuse may already exist", async () => {
    const onChange = open();
    fireEvent.click(await serverRow("srv_1"));

    expect(mockState.createSpy).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("SHOWS that it cannot act yet, rather than swallowing the click", async () => {
    // A refusal the user cannot see reads as a broken control — the same
    // reason the write paths are gated on `busy` rather than on a silent
    // early return.
    open();
    expect(await serverRow("srv_1")).toBeDisabled();
  });

  it("withholds Create too, so the guard behind it is a backstop", async () => {
    open();
    await userEvent.click(
      await screen.findByRole("tab", { name: "Server Groups" }),
    );
    // The form itself is unreachable: New group is part of the same list.
    expect(
      await screen.findByRole("button", { name: /new group/i }),
    ).toBeDisabled();
  });

  it("does NOT say loading when there is nothing to load a name for", () => {
    // The empty label is still the right answer with no selection; saying
    // "Loading…" there would invent a state the user is not in.
    render(<ServerPicker projectId="p_1" value={null} onChange={vi.fn()} />);
    expect(screen.getByTestId("server-picker-trigger")).toHaveTextContent(
      "Select server",
    );
  });

  it("says it is loading instead of claiming nothing is selected", () => {
    // The row is not in the list yet, so the selection resolves as dangling
    // and the label fell back to the empty text — the trigger asserting
    // "nothing picked" over a live selection is the BB-182 shape again.
    render(
      <ServerPicker projectId="p_1" value="att_solo" onChange={vi.fn()} />,
    );
    expect(screen.getByTestId("server-picker-trigger")).toHaveTextContent(
      /loading/i,
    );
  });
});

describe("ServerPicker — a catalog query that never runs", () => {
  it("states the project is empty rather than loading forever", async () => {
    // `useProjectServers` skips for a local/UUID project id and returns
    // `undefined` for good. Reading undefined as "in flight" leaves the tab
    // saying "Loading servers…" with nothing ever arriving.
    mockState.servers = undefined;
    mockState.catalogLoading = false;
    open();

    expect(
      await screen.findByText("No servers in this project yet."),
    ).toBeInTheDocument();
  });

  it("still says loading while the query really is in flight", async () => {
    mockState.servers = undefined;
    mockState.catalogLoading = true;
    open();

    expect(await screen.findByText("Loading servers…")).toBeInTheDocument();
  });
});

describe("ServerPicker — the popover's own lifecycle", () => {
  it("holds the popover open while its write is in flight", async () => {
    // A click away mid-write would unmount the panel under a mutation whose
    // result still has to land on it.
    mockState.createSpy = vi.fn(() => new Promise(() => {}));
    open();
    fireEvent.click(await serverRow("srv_1"));

    fireEvent.pointerDown(document.body);
    fireEvent.mouseDown(document.body);

    expect(await serverRow("srv_2")).toBeInTheDocument();
  });

  it("REOPENS on the tab that holds the current selection", async () => {
    // Not the initial state — `useState` already seeds that. This is the
    // second open, after the user browsed away from the selection's tab.
    mockState.attachments = [
      {
        _id: "att_pair",
        name: "prod pair",
        serverIds: ["srv_1", "srv_2"],
        resolvedServerNames: ["alpha", "beta"],
      },
    ];
    render(
      <ServerPicker projectId="p_1" value="att_pair" onChange={vi.fn()} />,
    );

    fireEvent.click(screen.getByTestId("server-picker-trigger"));
    await userEvent.click(await screen.findByRole("tab", { name: "Servers" }));
    expect(screen.getByRole("tab", { name: "Servers" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // Close, then open again.
    fireEvent.click(screen.getByTestId("server-picker-trigger"));
    fireEvent.click(screen.getByTestId("server-picker-trigger"));

    expect(
      await screen.findByRole("tab", { name: "Server Groups" }),
    ).toHaveAttribute("aria-selected", "true");
  });
});

describe("ServerPicker — removing a group", () => {
  const PAIR = {
    _id: "att_pair",
    name: "prod pair",
    serverIds: ["srv_1", "srv_2"],
    resolvedServerNames: ["alpha", "beta"],
  };

  async function openGroups() {
    await userEvent.click(
      await screen.findByRole("tab", { name: "Server Groups" }),
    );
  }

  it("removes the row, which nothing in the app could do before", async () => {
    mockState.attachments = [PAIR];
    open();
    await openGroups();

    await userEvent.click(
      await screen.findByRole("button", { name: "Delete prod pair" }),
    );

    await waitFor(() => expect(mockState.deleteSpy).toHaveBeenCalled());
    expect(mockState.deleteSpy).toHaveBeenCalledWith({
      serverAttachmentId: "att_pair",
    });
  });

  it("drops the selection when the row it pointed at is gone", async () => {
    mockState.attachments = [PAIR];
    const onClearSelection = vi.fn();
    render(
      <ServerPicker
        projectId="p_1"
        value="att_pair"
        onChange={vi.fn()}
        onClearSelection={onClearSelection}
      />,
    );
    fireEvent.click(screen.getByTestId("server-picker-trigger"));
    await openGroups();
    await userEvent.click(
      await screen.findByRole("button", { name: "Delete prod pair" }),
    );

    await waitFor(() => expect(onClearSelection).toHaveBeenCalled());
  });

  it("says why the backend refused, rather than looking like nothing happened", async () => {
    mockState.attachments = [PAIR];
    mockState.deleteSpy = vi
      .fn()
      .mockRejectedValue(new Error("A suite still uses this group"));
    open();
    await openGroups();
    await userEvent.click(
      await screen.findByRole("button", { name: "Delete prod pair" }),
    );

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect((toast.error as any).mock.calls[0][0]).toMatch(/suite still uses/i);
  });
});

describe("ServerPicker — the consequences of a delete", () => {
  const PAIR2 = {
    _id: "att_p",
    name: "prod pair",
    serverIds: ["srv_1", "srv_2"],
    resolvedServerNames: ["alpha", "beta"],
  };

  it("refuses to delete the SELECTED row when the caller cannot be told", async () => {
    // Without `onClearSelection` the parent keeps the id it stored, so the
    // delete would leave it pointing at a row that no longer exists.
    mockState.attachments = [PAIR2];
    render(
      <ServerPicker projectId="p_1" value="att_p" onChange={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId("server-picker-trigger"));
    await userEvent.click(
      await screen.findByRole("tab", { name: "Server Groups" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Delete prod pair" }),
    );

    expect(mockState.deleteSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });

  it("takes the deleted row off the tab before the query catches up", async () => {
    // The query keeps returning the row until it refetches — the mock never
    // refetches, which is the point: without a bridge the row sits there,
    // still clickable, and picking it stores an id the backend has dropped.
    mockState.attachments = [
      PAIR2,
      {
        _id: "att_o",
        name: "other pair",
        serverIds: ["srv_1", "srv_2"],
        resolvedServerNames: ["alpha", "beta"],
      },
    ];
    render(<ServerPicker projectId="p_1" value={null} onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId("server-picker-trigger"));
    await userEvent.click(
      await screen.findByRole("tab", { name: "Server Groups" }),
    );
    expect(await screen.findByText("other pair")).toBeInTheDocument();

    await userEvent.click(
      await screen.findByRole("button", { name: "Delete other pair" }),
    );

    await waitFor(() => expect(mockState.deleteSpy).toHaveBeenCalled());
    // Gone from the tab, and the row that was not deleted is still there —
    // so this is the delete taking effect, not the panel emptying.
    await waitFor(() => expect(screen.queryByText("other pair")).toBeNull());
    expect(screen.getByText("prod pair")).toBeInTheDocument();
  });

  it("still deletes a row that is NOT the selection", async () => {
    mockState.attachments = [
      PAIR2,
      { _id: "att_o", name: "other pair", serverIds: ["srv_1", "srv_2"], resolvedServerNames: ["alpha", "beta"] },
    ];
    render(
      <ServerPicker projectId="p_1" value="att_p" onChange={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId("server-picker-trigger"));
    await userEvent.click(
      await screen.findByRole("tab", { name: "Server Groups" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Delete other pair" }),
    );

    await waitFor(() => expect(mockState.deleteSpy).toHaveBeenCalled());
  });

  it("stops holding a bridged row once it has been deleted", async () => {
    // The bridge exists because the query lags a WRITE. A delete is a write
    // too, and holding the row past it keeps a ghost on the tab.
    const onChange = vi.fn();
    const onClearSelection = vi.fn();
    const { rerender } = render(
      <ServerPicker
        projectId="p_1"
        value={null}
        onChange={onChange}
        onClearSelection={onClearSelection}
      />,
    );
    fireEvent.click(screen.getByTestId("server-picker-trigger"));
    await userEvent.click(
      await screen.findByRole("tab", { name: "Server Groups" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /new group/i }),
    );
    await userEvent.click(await screen.findByRole("checkbox", { name: "alpha" }));
    await userEvent.click(await screen.findByRole("checkbox", { name: "beta" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Create$/ }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());

    rerender(
      <ServerPicker
        projectId="p_1"
        value="att_new"
        onChange={onChange}
        onClearSelection={onClearSelection}
      />,
    );
    fireEvent.click(screen.getByTestId("server-picker-trigger"));
    await userEvent.click(
      await screen.findByRole("tab", { name: "Server Groups" }),
    );
    const del = await screen.findAllByRole("button", { name: /^Delete / });
    await userEvent.click(del[0]);

    await waitFor(() => expect(mockState.deleteSpy).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryAllByRole("button", { name: /^Delete / })).toHaveLength(
        0,
      ),
    );
  });
});

describe("ServerPicker — clearing a selection the list no longer holds", () => {
  it("reads as the empty label once the list has answered without it", () => {
    // Dangling, not loading: the list arrived and does not hold the row, so
    // "Loading…" would be a claim that never resolves.
    mockState.attachments = [];
    render(
      <ServerPicker projectId="p_1" value="att_deleted" onChange={vi.fn()} />,
    );
    expect(screen.getByTestId("server-picker-trigger")).toHaveTextContent(
      "Select server",
    );
  });

  it("still offers the way out when the row is gone", () => {
    // The label falls back to the empty text, but the parent is still storing
    // the dead id. Hiding the X leaves no way to null it.
    mockState.attachments = [];
    const onClearSelection = vi.fn();
    render(
      <ServerPicker
        projectId="p_1"
        value="att_deleted"
        onChange={vi.fn()}
        onClearSelection={onClearSelection}
      />,
    );

    fireEvent.click(screen.getByTestId("server-picker-clear"));
    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });

  it("withholds it while its own write is in flight", async () => {
    mockState.attachments = [
      { _id: "att_solo", name: "alpha", serverIds: ["srv_1"], resolvedServerNames: ["alpha"] },
    ];
    mockState.createSpy = vi.fn(() => new Promise(() => {}));
    render(
      <ServerPicker
        projectId="p_1"
        value="att_solo"
        onChange={vi.fn()}
        onClearSelection={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("server-picker-trigger"));
    fireEvent.click(await serverRow("srv_2"));

    // The mint will report its own selection; clearing underneath it would be
    // silently undone.
    await waitFor(() =>
      expect(screen.queryByTestId("server-picker-clear")).toBeNull(),
    );
  });
});

describe("ServerPicker — a group of exactly one server", () => {
  it("does not suggest a name that would hide the group being made", async () => {
    // The form pre-fills the name, and for one pick the shared deriver returns
    // the server's own name — which is precisely the shape `isServerStandIn`
    // reads as "not a group", so the row would be filtered off the Groups tab
    // the moment it was created.
    open();
    await userEvent.click(
      await screen.findByRole("tab", { name: "Server Groups" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /new group/i }),
    );
    await userEvent.click(await screen.findByRole("checkbox", { name: "alpha" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Create$/ }));

    await waitFor(() => expect(mockState.createSpy).toHaveBeenCalled());
    const written = mockState.createSpy.mock.calls[0][0];
    expect(written.serverIds).toEqual(["srv_1"]);
    expect(isServerStandIn({ ...written, resolvedServerNames: ["alpha"] })).toBe(
      false,
    );
  });
});

describe("ServerPicker — a server named like the fallback", () => {
  it("suggests a name that is not that server's stand-in", async () => {
    mockState.servers = [{ _id: "srv_g", name: "prod" }];
    mockState.attachments = [
      { _id: "att_1", name: "Group 1", serverIds: ["srv_1", "srv_2"], resolvedServerNames: ["a", "b"] },
    ];
    open();
    await userEvent.click(
      await screen.findByRole("tab", { name: "Server Groups" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /new group/i }),
    );
    await userEvent.click(await screen.findByRole("checkbox", { name: "prod" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Create$/ }));

    await waitFor(() => expect(mockState.createSpy).toHaveBeenCalled());
    const written = mockState.createSpy.mock.calls[0][0];
    expect(
      isServerStandIn({ ...written, resolvedServerNames: ["prod"] }),
    ).toBe(false);
  });

  it("cannot clear the rule for a server named after the numbering stem", async () => {
    // Documented, not fixed. `Group 1` is safe — the rule only claims numbers
    // from 2, where the generator starts. But once `Group 1` is taken the
    // fallback is `Group 2`, which for a server called `group` IS its stand-in.
    // No choice of number escapes that; only the storage column would.
    mockState.servers = [{ _id: "srv_g", name: "group" }];
    mockState.attachments = [
      { _id: "att_1", name: "Group 1", serverIds: ["srv_1", "srv_2"], resolvedServerNames: ["a", "b"] },
    ];
    open();
    await userEvent.click(
      await screen.findByRole("tab", { name: "Server Groups" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /new group/i }),
    );
    await userEvent.click(await screen.findByRole("checkbox", { name: "group" }));

    const suggested = (screen.getByLabelText("Group name") as HTMLInputElement)
      .value;
    expect(
      isServerStandIn({
        _id: "",
        name: suggested,
        serverIds: ["srv_g"],
        resolvedServerNames: ["group"],
      }),
    ).toBe(true);
  });
});

describe("ServerPicker — one failure, one message", () => {
  it("raises a single toast when the write itself fails", async () => {
    mockState.createSpy = vi.fn().mockRejectedValue(new Error("already exists"));
    open();
    fireEvent.click(await screen.findByText("alpha"));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    // The nested catch reported and rethrew into the outer one, so every
    // failed write stacked the friendly wording and the raw text it replaces.
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect((toast.error as any).mock.calls[0][0]).toMatch(
      /server group named after "alpha" already exists/i,
    );
  });

  it("raises a single toast when a GROUP write fails", async () => {
    mockState.createSpy = vi.fn().mockRejectedValue(new Error("already exists"));
    open();
    await userEvent.click(
      await screen.findByRole("tab", { name: "Server Groups" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /new group/i }),
    );
    await userEvent.click(await screen.findByRole("checkbox", { name: "alpha" }));
    await userEvent.click(await screen.findByRole("checkbox", { name: "beta" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Create$/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect((toast.error as any).mock.calls[0][0]).toMatch(
      /server group named .* already exists/i,
    );
  });

  it("does not read a GROUP caller's error as a name collision either", async () => {
    // The scoping was only pinned on the bare-server path, so the exact
    // regression this PR names could come back on the group path.
    const onChange = vi.fn(() =>
      Promise.reject(new Error(`A suite named "smoke" already exists`)),
    );
    render(
      <ServerPicker projectId="p_1" value={null} onChange={onChange as any} />,
    );
    fireEvent.click(screen.getByTestId("server-picker-trigger"));
    await userEvent.click(
      await screen.findByRole("tab", { name: "Server Groups" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /new group/i }),
    );
    await userEvent.click(await screen.findByRole("checkbox", { name: "alpha" }));
    await userEvent.click(await screen.findByRole("checkbox", { name: "beta" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Create$/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect((toast.error as any).mock.calls[0][0]).not.toMatch(
      /server group named/i,
    );
  });
});

describe("ServerPicker — a parent whose onChange is async", () => {
  it("reports a rejected commit instead of losing it", async () => {
    // `onChange` is typed `=> void`, and void-return bivariance lets a caller
    // hand over an async function. `suite-environment-composer-bar` does: it
    // passes an awaited `updateSuite`. Not awaiting it here means its
    // rejection escapes the try that would have reported it.
    const onChange = vi.fn(() => Promise.reject(new Error("Suite is locked")));
    render(
      <ServerPicker projectId="p_1" value={null} onChange={onChange as any} />,
    );
    fireEvent.click(screen.getByTestId("server-picker-trigger"));
    fireEvent.click(await screen.findByText("alpha"));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect((toast.error as any).mock.calls[0][0]).toMatch(/Suite is locked/);
  });

  it("does not read the caller's error as a name collision", async () => {
    // The write SUCCEEDED. Matching `/already exists/i` against whatever comes
    // back from the commit tells the user to rename, and renaming creates a
    // second real group.
    const onChange = vi.fn(() =>
      Promise.reject(new Error(`A suite named "smoke" already exists`)),
    );
    render(
      <ServerPicker projectId="p_1" value={null} onChange={onChange as any} />,
    );
    fireEvent.click(screen.getByTestId("server-picker-trigger"));
    fireEvent.click(await screen.findByText("alpha"));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect((toast.error as any).mock.calls[0][0]).not.toMatch(
      /server group named/i,
    );
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

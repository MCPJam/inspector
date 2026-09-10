import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComparisonBrowser } from "../ComparisonBrowser";
import {
  useBrowserComparisonStore as store,
  type BrowserComparisonClient,
} from "@/stores/browser-comparison-store";
import {
  EMPTY_BROWSER_SESSION_STATE,
  type BrowserStateSnapshot,
} from "@/shared/browser-session-state";
import { BrowserShell } from "../BrowserShell";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  send: vi.fn(),
  mint: vi.fn(),
  transports: vi.fn(),
  granted: true,
  grant: vi.fn(async () => true),
  hosted: false,
}));
vi.mock("@/lib/config", () => ({
  get HOSTED_MODE() {
    return mocks.hosted;
  },
}));
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: null }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/hooks/useBrowserEngine", () => ({
  useBrowserEngine: () => ({
    selectedEngine: "local",
    localAvailable: true,
    consent: { granted: mocks.granted, token: "consent", grant: mocks.grant },
  }),
}));
vi.mock("@/hooks/useProjectComputer", () => ({
  useMintConversationBrowserToken: () => mocks.mint,
}));
vi.mock("@/lib/browser-shell/comparison-transport", () => ({
  createComparisonTransport: (
    client: BrowserComparisonClient,
    options: unknown,
  ) => {
    mocks.transports(client, options);
    return {
      readState: () => mocks.read(client.sessionId),
      sendCommand: (args: unknown) => mocks.send(client.sessionId, args),
    };
  },
}));
vi.mock("../LocalBrowserBody", () => ({
  LocalBrowserBody: (props: { sessionId: string; active: boolean }) => (
    <div
      data-testid="local-body"
      data-session={props.sessionId}
      data-active={String(props.active)}
    />
  ),
}));
vi.mock("../HostedBrowserBody", () => ({
  HostedBrowserBody: (props: { sessionId: string; active: boolean }) => (
    <div
      data-testid="cloud-body"
      data-session={props.sessionId}
      data-active={String(props.active)}
    />
  ),
}));

function snapshot(activeTabId = "nike"): BrowserStateSnapshot {
  return {
    ...EMPTY_BROWSER_SESSION_STATE,
    seq: 1,
    activeTabId,
    tabs: ["nike", "cart"].map((id) => ({
      id,
      title: id === "nike" ? "Nike" : "Cart",
      url: `https://nike.com/${id}`,
      loading: false,
    })),
  };
}
function register(
  id: string,
  order: number,
  patch: Partial<BrowserComparisonClient> = {},
) {
  store.getState().register({
    workspaceId: "workspace",
    projectId: "project",
    sessionId: id,
    clientId: id,
    name: id === "a" ? "Cursor" : "MCPJam",
    order,
    clientCount: 2,
    engine: "local",
    ...patch,
  });
  store.getState().noteBrowsing(id);
}
const mount = (active = true) =>
  render(
    <ComparisonBrowser
      projectId="project"
      workspaceId="workspace"
      active={active}
    />,
  );
beforeEach(() => {
  vi.clearAllMocks();
  mocks.granted = true;
  mocks.hosted = false;
  mocks.read.mockResolvedValue(snapshot());
  mocks.send.mockResolvedValue({ ok: true });
  store.setState({ clients: {}, selected: {} });
});

describe("one combined browser strip", () => {
  it("mounts local setup before the first browser session or snapshot exists", async () => {
    register("a", 0);
    store.setState((state) => ({
      clients: { a: { ...state.clients.a, started: false } },
      selected: {},
    }));
    mocks.read.mockResolvedValue(null);
    mount();
    expect(screen.getByTestId("local-body")).toHaveAttribute(
      "data-session",
      "a",
    );
    expect(mocks.transports).not.toHaveBeenCalled();
  });

  it("keeps local installation and recovery available when a started client has no snapshot", () => {
    register("a", 0);
    mocks.read.mockResolvedValue(null);
    mount();
    expect(screen.getByTestId("local-body")).toHaveAttribute(
      "data-session",
      "a",
    );
  });
  it("shows guests Allow before any client has started browsing", async () => {
    mocks.granted = false;
    mount();
    expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument();
    expect(screen.queryByText("Waiting for a client to browse…")).toBeNull();
    expect(mocks.grant).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(mocks.grant).toHaveBeenCalledOnce());
    expect(mocks.transports).not.toHaveBeenCalled();
  });

  it("never shows local permission to hosted guests", () => {
    mocks.hosted = true;
    mocks.granted = false;
    mount();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it("keeps following the selected client when a background read hangs, and stops when hidden", async () => {
    vi.useFakeTimers();
    register("a", 0);
    register("b", 1);
    let activePage = "nike";
    mocks.read.mockImplementation((id: string) =>
      id === "b"
        ? new Promise(() => {})
        : Promise.resolve(snapshot(activePage)),
    );
    const view = mount();
    try {
      await act(async () => {});
      activePage = "cart";
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(screen.getByTitle("Cursor · Cart")).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(store.getState().selected.workspace).toBe("a");
      view.rerender(
        <ComparisonBrowser
          projectId="project"
          workspaceId="workspace"
          active={false}
        />,
      );
      const calls = mocks.read.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(mocks.read).toHaveBeenCalledTimes(calls);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("keeps duplicate page IDs separate and watches another client's current page without a command", async () => {
    register("a", 0);
    register("b", 1, { engine: "cloud" });
    mount();
    await screen.findByTitle("MCPJam · Nike");
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    expect(screen.getByTestId("local-body")).toHaveAttribute(
      "data-session",
      "a",
    );
    fireEvent.click(screen.getByTitle("MCPJam · Nike"));
    expect(screen.queryByTestId("local-body")).not.toBeInTheDocument();
    expect(screen.getByTestId("cloud-body")).toHaveAttribute(
      "data-session",
      "b",
    );
    expect(mocks.send).not.toHaveBeenCalled();
    act(() => {
      store.getState().noteBrowsing("a");
    });
    expect(screen.getByTestId("cloud-body")).toHaveAttribute(
      "data-session",
      "b",
    );
  });

  it("uses the owning session for inactive page activation, background close, and New tab", async () => {
    register("a", 0);
    register("b", 1);
    mount();
    await screen.findByTitle("MCPJam · Cart");
    fireEvent.click(screen.getByLabelText("Close MCPJam · Cart"));
    await waitFor(() =>
      expect(mocks.send).toHaveBeenCalledWith("b", {
        command: { op: "close_tab", tabId: "cart" },
      }),
    );
    await waitFor(() => expect(screen.getByLabelText("New tab")).toBeEnabled());
    expect(store.getState().selected.workspace).toBe("a");
    fireEvent.click(screen.getByTitle("MCPJam · Cart"));
    await waitFor(() => expect(store.getState().selected.workspace).toBe("b"));
    expect(mocks.send).toHaveBeenCalledWith("b", {
      command: { op: "activate_tab", tabId: "cart" },
    });
    fireEvent.click(screen.getByLabelText("New tab"));
    await waitFor(() =>
      expect(mocks.send).toHaveBeenCalledWith("b", {
        command: { op: "create_tab" },
      }),
    );
  });

  it("keeps the selected client when a tab activation is refused", async () => {
    register("a", 0);
    register("b", 1);
    mocks.send.mockResolvedValue({ ok: false, reason: "lease_held" });
    mount();
    fireEvent.click(await screen.findByTitle("MCPJam · Cart"));
    await screen.findByRole("alert");
    expect(store.getState().selected.workspace).toBe("a");
  });

  it("hides names for one client, even with several pages", async () => {
    register("a", 0, { clientCount: 1 });
    mount();
    await screen.findByTitle("Nike");
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.queryByText(/Cursor/)).not.toBeInTheDocument();
  });

  it("uses the lineup count even when only one client has started browsing", async () => {
    register("a", 0);
    mount();
    await screen.findByTitle("Cursor · Nike");
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  it("ignores a removed client's late snapshot and does not render a fake blank page", async () => {
    register("a", 0);
    register("b", 1);
    let resolve!: (value: BrowserStateSnapshot) => void;
    mocks.read.mockImplementation((id: string) =>
      id === "b"
        ? new Promise((done) => {
            resolve = done;
          })
        : Promise.resolve(snapshot()),
    );
    mount();
    await screen.findByTitle("Cursor · Nike");
    expect(screen.getByTitle("MCPJam · Connecting…")).toBeInTheDocument();
    act(() => {
      store.getState().unregister("b", "workspace");
    });
    await act(async () => {
      resolve(snapshot());
    });
    expect(screen.queryByTitle("MCPJam · Nike")).not.toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  it("does not read metadata while hidden or without local consent", () => {
    register("a", 0);
    const view = mount(false);
    expect(mocks.read).not.toHaveBeenCalled();
    mocks.granted = false;
    view.rerender(
      <ComparisonBrowser projectId="project" workspaceId="workspace" active />,
    );
    expect(mocks.read).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument();
    expect(screen.queryByTestId("local-body")).not.toBeInTheDocument();
  });
});

// Exercise the real shell separately from the mocked page transports.
import { BrowserWorkspaceChrome } from "../BrowserWorkspaceChrome";
it("uses workspace chrome without a second tab strip and names the driver", () => {
  render(
    <BrowserWorkspaceChrome.Provider value={{ clientName: "Cursor" }}>
      <BrowserShell
        state={{ ...EMPTY_BROWSER_SESSION_STATE, ...snapshot() }}
        holderId="holder"
        onCommand={() => {}}
      />
    </BrowserWorkspaceChrome.Provider>,
  );
  expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  expect(screen.getByTestId("browser-control-status")).toHaveTextContent(
    "Cursor is driving",
  );
});

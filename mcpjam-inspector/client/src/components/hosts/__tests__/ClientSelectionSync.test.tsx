import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { ClientSelectionSync } from "../ClientSelectionSync";
import { ProjectClientInitNotice } from "../ProjectClientInitNotice";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  ensure: vi.fn(),
  set: vi.fn(),
  report: vi.fn(),
  selected: null as string | null,
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useHostList: mocks.list,
  useHostMutations: () => ({ ensureProjectClient: mocks.ensure }),
}));
vi.mock("@/hooks/use-previewed-client-id", () => ({
  usePreviewedHostId: () => [mocks.selected, mocks.set],
}));
vi.mock("@/lib/error-reporting", () => ({ reportCaught: mocks.report }));
vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (select: (s: { themeMode: string }) => unknown) =>
    select({ themeMode: "light" }),
}));

const ENSURED = { hostId: "h1", created: true };

function connect(projectId = "p1") {
  return (
    <>
      <ClientSelectionSync projectId={projectId} />
      <ProjectClientInitNotice projectId={projectId} />
    </>
  );
}

function renderConnect(projectId = "p1") {
  return render(connect(projectId));
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("ClientSelectionSync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.selected = null;
    mocks.list.mockReturnValue({ hosts: [], isLoading: false });
    mocks.ensure.mockResolvedValue(ENSURED);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ensures an empty project's client for any role, once", async () => {
    const { rerender } = render(<ClientSelectionSync projectId="p1" />);
    rerender(<ClientSelectionSync projectId="p1" />);
    await advance(0);
    expect(mocks.ensure).toHaveBeenCalledTimes(1);
    expect(mocks.ensure).toHaveBeenCalledWith({
      projectId: "p1",
      themeMode: "light",
    });
  });

  it("ensures each project independently", async () => {
    const { rerender } = render(<ClientSelectionSync projectId="p1" />);
    rerender(<ClientSelectionSync projectId="p2" />);
    await advance(0);
    expect(mocks.ensure.mock.calls.map(([args]) => args.projectId)).toEqual([
      "p1",
      "p2",
    ]);
  });

  it("does not repeat a request that is still in flight, and retries it", async () => {
    let failFirst: (error: Error) => void = () => {};
    mocks.ensure
      .mockReturnValueOnce(
        new Promise((_, reject) => {
          failFirst = reject;
        }),
      )
      .mockReturnValueOnce(new Promise(() => {}));
    const { rerender } = renderConnect("p1");
    rerender(connect("p2"));
    rerender(connect("p1"));
    expect(mocks.ensure).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent("Preparing a client");

    await act(async () => failFirst(new Error("network")));
    await advance(1_000);
    expect(mocks.ensure).toHaveBeenCalledTimes(3);
    expect(mocks.ensure).toHaveBeenLastCalledWith({
      projectId: "p1",
      themeMode: "light",
    });
  });

  it("waits for the host list", () => {
    mocks.list.mockReturnValue({ hosts: [], isLoading: true });
    render(<ClientSelectionSync projectId="p1" />);
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("leaves a project that has a client alone", () => {
    mocks.list.mockReturnValue({
      hosts: [{ hostId: "a", name: "Claude" }],
      isLoading: false,
    });
    render(<ClientSelectionSync projectId="p1" />);
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it("retries a transient failure on its own, without a rerender", async () => {
    mocks.ensure
      .mockRejectedValueOnce(new Error("network"))
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue(ENSURED);
    const { rerender } = renderConnect();
    await advance(0);
    expect(mocks.ensure).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("Preparing a client");
    await advance(1_000);
    expect(mocks.ensure).toHaveBeenCalledTimes(2);
    await advance(4_000);
    expect(mocks.ensure).toHaveBeenCalledTimes(3);
    expect(mocks.report).toHaveBeenCalledTimes(2);
    // Done, but the list has not caught up yet.
    expect(screen.getByRole("status")).toHaveTextContent("Preparing a client");

    mocks.list.mockReturnValue({
      hosts: [{ hostId: "h1", name: "MCPJam" }],
      isLoading: false,
    });
    rerender(connect());
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("offers Retry once retries run out, and Retry starts over", async () => {
    mocks.ensure.mockRejectedValue(new Error("network"));
    renderConnect();
    for (const ms of [0, 1_000, 4_000, 10_000]) await advance(ms);
    expect(mocks.ensure).toHaveBeenCalledTimes(4);
    await advance(60_000);
    expect(mocks.ensure).toHaveBeenCalledTimes(4);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not prepare a client. Try again.",
    );

    mocks.ensure.mockResolvedValue(ENSURED);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await advance(0);
    expect(mocks.ensure).toHaveBeenCalledTimes(5);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    [
      { kind: "forbidden", message: "Project not found" },
      "You don't have access to set up clients in this project.",
    ],
    [
      { code: "FORBIDDEN" },
      "You don't have access to set up clients in this project.",
    ],
    [
      { code: "VALIDATION", message: "This project is archived." },
      "This project is archived.",
    ],
    [
      { code: "VALIDATION" },
      "Could not set up a client in this project. Contact support.",
    ],
  ])("does not retry a refusal %o, and explains it", async (data, copy) => {
    mocks.ensure.mockRejectedValue(new ConvexError(data));
    renderConnect();
    await advance(30_000);
    expect(mocks.ensure).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent(copy);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("does not retry or report a backend that lacks the function", async () => {
    mocks.ensure.mockRejectedValue(
      new Error(
        "[CONVEX M(projectClients:ensureProjectClient)] Could not find public function",
      ),
    );
    renderConnect();
    await advance(30_000);
    expect(mocks.ensure).toHaveBeenCalledTimes(1);
    expect(mocks.report).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Client setup isn't available right now.",
    );
  });

  it("waits out the backend's retryAfterMs", async () => {
    mocks.ensure
      .mockRejectedValueOnce(
        new ConvexError({ code: "rate_limited", retryAfterMs: 30_000 }),
      )
      .mockResolvedValue(ENSURED);
    renderConnect();
    await advance(29_000);
    expect(mocks.ensure).toHaveBeenCalledTimes(1);
    await advance(1_000);
    expect(mocks.ensure).toHaveBeenCalledTimes(2);
    expect(mocks.report).not.toHaveBeenCalled();
  });

  it("stops retrying when another caller's client arrives", async () => {
    mocks.ensure.mockRejectedValue(new Error("network"));
    const { rerender } = renderConnect();
    await advance(0);
    mocks.list.mockReturnValue({
      hosts: [{ hostId: "h1", name: "MCPJam" }],
      isLoading: false,
    });
    rerender(connect());
    await advance(30_000);
    expect(mocks.ensure).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("ensures again when the list empties after a success it had seen", async () => {
    let succeed: (value: typeof ENSURED) => void = () => {};
    mocks.ensure.mockReturnValueOnce(
      new Promise((resolve) => {
        succeed = resolve;
      }),
    );
    const { rerender } = renderConnect();
    mocks.list.mockReturnValue({
      hosts: [{ hostId: "h1", name: "MCPJam" }],
      isLoading: false,
    });
    rerender(connect());
    await act(async () => succeed(ENSURED));

    mocks.list.mockReturnValue({ hosts: [], isLoading: false });
    rerender(connect());
    await advance(0);
    expect(mocks.ensure).toHaveBeenCalledTimes(2);
  });

  it("repairs a deleted selection using the default client", () => {
    mocks.selected = "deleted";
    mocks.list.mockReturnValue({
      hosts: [
        { hostId: "a", name: "Claude" },
        { hostId: "b", name: "MCPJam" },
      ],
      isLoading: false,
    });
    render(<ClientSelectionSync projectId="p1" />);
    expect(mocks.set).toHaveBeenCalledWith("b");
  });

  it("keeps a valid selection", () => {
    mocks.selected = "a";
    mocks.list.mockReturnValue({
      hosts: [{ hostId: "a", name: "Claude" }],
      isLoading: false,
    });
    render(<ClientSelectionSync projectId="p1" />);
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("falls back alphabetically when the default was deleted", () => {
    mocks.list.mockReturnValue({
      hosts: [
        { hostId: "z", name: "Zulu" },
        { hostId: "a", name: "Alpha" },
      ],
      isLoading: false,
    });
    render(<ClientSelectionSync projectId="p1" />);
    expect(mocks.set).toHaveBeenCalledWith("a");
  });
});

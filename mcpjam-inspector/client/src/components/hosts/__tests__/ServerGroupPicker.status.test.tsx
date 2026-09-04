/**
 * BB-49. The pool comes from Convex, which knows nothing about whether a
 * server is up; the live status lives in app state, keyed by name. This covers
 * the join: a failed server is offered, is not ticked, and says so.
 *
 * `server-group-name.test.ts` covers the preselection rule itself and
 * `server-selection-list.test.tsx` the mark — this covers that the picker
 * actually feeds them the status.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "@/state/app-types";

const { serversRef, attachmentsRef, statusRef, createMock, onChangeMock } =
  vi.hoisted(() => ({
    serversRef: {
      current: [] as Array<{ _id: string; name: string; url: string }>,
    },
    attachmentsRef: {
      current: [] as Array<{
        _id: string;
        name: string;
        serverIds: string[];
        resolvedServerNames?: string[];
      }>,
    },
    statusRef: { current: {} as Record<string, string> },
    createMock: vi.fn(),
    onChangeMock: vi.fn(),
  }));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useMutation: () => createMock,
}));

vi.mock("@/hooks/useViews", () => ({
  useProjectServers: () => ({ servers: serversRef.current, isLoading: false }),
  useProjectServerAttachments: () => ({
    serverAttachments: attachmentsRef.current,
    isLoading: false,
  }),
}));

vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() },
}));

vi.mock("@/state/app-state-context", () => ({
  useOptionalSharedAppState: (): AppState | null =>
    ({
      servers: Object.fromEntries(
        Object.entries(statusRef.current).map(([name, connectionStatus]) => [
          name,
          { connectionStatus },
        ]),
      ),
    }) as unknown as AppState,
}));

import { ServerGroupPicker } from "../ServerGroupPicker";

const remote = (name: string) => ({
  _id: `s-${name}`,
  name,
  url: `https://${name}.example.com/mcp`,
});

async function openCreateForm() {
  const user = userEvent.setup();
  render(
    <ServerGroupPicker
      projectId="p-1"
      value={null}
      onChange={onChangeMock}
      triggerTestId="picker"
    />,
  );
  await user.click(screen.getByTestId("picker"));
  await user.click(screen.getByRole("button", { name: /create new group/i }));
  return user;
}

describe("ServerGroupPicker — connection status in the create form", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createMock.mockResolvedValue({ _id: "new-id" });
    statusRef.current = {};
    attachmentsRef.current = [];
  });

  it("offers a failed server without ticking it, and names the group after the rest", async () => {
    serversRef.current = [remote("test-bad-url"), remote("draw")];
    statusRef.current = { "test-bad-url": "failed", draw: "connected" };
    await openCreateForm();

    expect(
      screen.getByRole("checkbox", { name: /test-bad-url/ }),
    ).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /draw/ })).toBeChecked();
    expect(screen.getByLabelText(/group name/i)).toHaveValue("draw");
    expect(screen.getByText(/servers \(1 picked\)/i)).toBeInTheDocument();
  });

  it("marks each offered server with the status it actually has", async () => {
    serversRef.current = [remote("test-bad-url"), remote("draw")];
    statusRef.current = { "test-bad-url": "failed", draw: "connected" };
    await openCreateForm();

    expect(screen.getByTestId("server-status-s-test-bad-url")).toHaveAttribute(
      "title",
      "Failed",
    );
    expect(screen.getByTestId("server-status-s-draw")).toHaveAttribute(
      "title",
      "Connected",
    );
  });

  // The reported state, minus the failure: nothing regressed for a healthy
  // pool that app state has not connected yet.
  it("keeps preselecting a pool app state knows nothing about", async () => {
    serversRef.current = [remote("draw")];
    await openCreateForm();

    expect(screen.getByRole("checkbox", { name: "draw" })).toBeChecked();
    expect(screen.getByLabelText(/group name/i)).toHaveValue("draw");
  });
});

/**
 * Expanding a saved group is how you check what is inside it before picking
 * it, and it is step 3 of the BB-49 repro ("open the Server dropdown"). The
 * rows are not focusable, so the label is a visually-hidden node.
 */
describe("ServerGroupPicker — connection status on a saved group's servers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statusRef.current = {};
    serversRef.current = [];
    attachmentsRef.current = [
      {
        _id: "a-1",
        name: "excalidraw + 1",
        serverIds: ["s-excalidraw", "s-test-bad-url"],
        resolvedServerNames: ["excalidraw", "test-bad-url"],
      },
    ];
  });

  /**
   * The row a server's name sits in. Statuses are asserted against this rather
   * than the document: the group holds one failed server and one connected
   * one, so "both words appear somewhere" is equally true of the mapping read
   * backwards.
   */
  const rowFor = (name: string): HTMLElement => {
    const row = screen.getByText(name).closest("li");
    if (!row) throw new Error(`No row rendered for ${name}`);
    return row;
  };

  async function expandTheGroup() {
    const user = userEvent.setup();
    render(
      <ServerGroupPicker
        projectId="p-1"
        value={null}
        onChange={onChangeMock}
        triggerTestId="picker"
      />,
    );
    await user.click(screen.getByTestId("picker"));
    await user.click(
      screen.getByRole("button", { name: /show servers in excalidraw \+ 1/i }),
    );
  }

  it("marks each server in an expanded group with the status it has", async () => {
    statusRef.current = { excalidraw: "connected", "test-bad-url": "failed" };
    await expandTheGroup();

    const bad = within(rowFor("test-bad-url"));
    const good = within(rowFor("excalidraw"));
    expect(bad.getByText("Failed")).toBeInTheDocument();
    expect(good.getByText("Connected")).toBeInTheDocument();
    // Both directions, so reading the map by position instead of by name
    // cannot satisfy this.
    expect(bad.queryByText("Connected")).not.toBeInTheDocument();
    expect(good.queryByText("Failed")).not.toBeInTheDocument();
  });

  it("marks only the server it has a status for", async () => {
    statusRef.current = { "test-bad-url": "failed" };
    await expandTheGroup();

    expect(
      within(rowFor("test-bad-url")).getByText("Failed"),
    ).toBeInTheDocument();
    // Unknown is not disconnected, so the other row claims nothing at all.
    const untouched = rowFor("excalidraw");
    expect(untouched).toHaveTextContent("excalidraw");
    expect(
      within(untouched).queryByText(/connected|disconnected|failed/i),
    ).not.toBeInTheDocument();
  });

  it("says nothing about a server app state has no status for", async () => {
    await expandTheGroup();

    const row = within(rowFor("test-bad-url"));
    expect(row.queryByText("Failed")).not.toBeInTheDocument();
    expect(row.queryByText("Disconnected")).not.toBeInTheDocument();
  });
});

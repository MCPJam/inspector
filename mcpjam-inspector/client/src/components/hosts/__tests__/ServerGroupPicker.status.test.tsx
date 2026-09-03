/**
 * BB-49. The pool comes from Convex, which knows nothing about whether a
 * server is up; the live status lives in app state, keyed by name. This covers
 * the join: a failed server is offered, is not ticked, and says so.
 *
 * `server-group-name.test.ts` covers the preselection rule itself and
 * `server-selection-list.test.tsx` the mark — this covers that the picker
 * actually feeds them the status.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "@/state/app-types";

const { serversRef, statusRef, createMock, onChangeMock } = vi.hoisted(() => ({
  serversRef: {
    current: [] as Array<{ _id: string; name: string; url: string }>,
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
    serverAttachments: [],
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

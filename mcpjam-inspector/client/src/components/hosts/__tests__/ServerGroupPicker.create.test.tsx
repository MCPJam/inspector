/**
 * The create form's opening state, wired end to end. `server-group-name.test.ts`
 * covers the rules; this covers that the picker actually asks for them.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { serversRef, attachmentsRef, createMock, onChangeMock } = vi.hoisted(() => ({
  serversRef: { current: [] as Array<{ _id: string; name: string }> },
  attachmentsRef: {
    current: [] as Array<{ _id: string; name: string; serverIds: string[] }>,
  },
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

import { ServerGroupPicker } from "../ServerGroupPicker";

const pool = (...names: string[]) =>
  names.map((name, i) => ({ _id: `s-${i}`, name }));

async function openCreateForm() {
  const user = userEvent.setup();
  render(
    <ServerGroupPicker
      projectId="p-1"
      value={null}
      onChange={onChangeMock}
      triggerTestId="picker"
    />
  );
  await user.click(screen.getByTestId("picker"));
  await user.click(screen.getByRole("button", { name: /create new group/i }));
  return user;
}

describe("ServerGroupPicker — the create form's opening state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createMock.mockResolvedValue({ _id: "new-id" });
    attachmentsRef.current = [];
  });

  it("opens with the only server picked, named after it, ready to submit", async () => {
    serversRef.current = pool("big-response");
    await openCreateForm();

    expect(screen.getByLabelText(/group name/i)).toHaveValue("big-response");
    expect(screen.getByText(/servers \(1 picked\)/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^create$/i })).toBeEnabled();
  });

  it("names a small pool after its first server and counts the rest", async () => {
    serversRef.current = pool("draw", "Notion", "Linear");
    await openCreateForm();

    expect(screen.getByLabelText(/group name/i)).toHaveValue("draw + 2");
    expect(screen.getByText(/servers \(3 picked\)/i)).toBeInTheDocument();
  });

  // Past three, guessing is wrong more often than right, so the form asks.
  it("picks nothing once the pool is big enough to be a real choice", async () => {
    serversRef.current = pool("a", "b", "c", "d");
    await openCreateForm();

    expect(screen.getByLabelText(/group name/i)).toHaveValue("group 1");
    expect(screen.getByText(/servers \(0 picked\)/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^create$/i })).toBeDisabled();
  });

  it("keeps the derived name in step with the servers being picked", async () => {
    serversRef.current = pool("a", "b", "c", "d");
    const user = await openCreateForm();

    await user.click(screen.getByRole("checkbox", { name: "a" }));
    expect(screen.getByLabelText(/group name/i)).toHaveValue("a");

    await user.click(screen.getByRole("checkbox", { name: "b" }));
    expect(screen.getByLabelText(/group name/i)).toHaveValue("a + 1");
  });

  it("stops deriving once the user names the group themselves", async () => {
    serversRef.current = pool("a", "b", "c", "d");
    const user = await openCreateForm();

    const field = screen.getByLabelText(/group name/i);
    await user.clear(field);
    await user.type(field, "prod");
    await user.click(screen.getByRole("checkbox", { name: "a" }));

    expect(field).toHaveValue("prod");
  });
});

/**
 * Clicking away from the create form commits it, because Create can sit below
 * the fold on a long list. Preselection made that reachable without the user
 * having touched anything, so a look-and-leave would have created a group.
 */
describe("ServerGroupPicker — click-away only commits what the user built", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createMock.mockResolvedValue({ _id: "new-id" });
    attachmentsRef.current = [];
  });

  it("discards a form the user only looked at", async () => {
    serversRef.current = pool("big-response");
    const user = await openCreateForm();

    await user.click(document.body);

    expect(createMock).not.toHaveBeenCalled();
  });

  it("still commits once the user has picked something", async () => {
    serversRef.current = pool("big-response", "draw");
    const user = await openCreateForm();

    await user.click(screen.getByRole("checkbox", { name: "draw" }));
    await user.click(document.body);

    expect(createMock).toHaveBeenCalled();
    // The mutation answers with the created row; the id it carries is what the
    // caller selects by. Asserting only that it fired would pass while the
    // selection is handed an undefined id.
    await vi.waitFor(() =>
      expect(onChangeMock).toHaveBeenCalledWith(
        "new-id",
        expect.objectContaining({ _id: "new-id" })
      )
    );
  });
});

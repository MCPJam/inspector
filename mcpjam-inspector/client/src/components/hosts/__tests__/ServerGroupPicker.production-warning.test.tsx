/**
 * BB-234. Swarms point real agents at whatever server group is picked here,
 * and those agents write and delete to exercise the server. The thread's
 * decision was a minimal in-place warning at the moment of choice rather than
 * a modal after the fact, so this covers that the popover actually carries it
 * — including on the empty-state path, which is exactly the first-run user
 * most at risk of aiming a swarm at prod.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { serversRef, attachmentsRef } = vi.hoisted(() => ({
  serversRef: {
    current: [] as Array<{ _id: string; name: string; url: string }>,
  },
  attachmentsRef: {
    current: [] as Array<{ _id: string; name: string; serverIds: string[] }>,
  },
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useMutation: () => vi.fn(),
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
  useOptionalSharedAppState: () => null,
}));

import { ServerGroupPicker } from "../ServerGroupPicker";

async function openPicker() {
  const user = userEvent.setup();
  render(
    <ServerGroupPicker
      projectId="p-1"
      value={null}
      onChange={vi.fn()}
      triggerTestId="picker"
    />,
  );
  await user.click(screen.getByTestId("picker"));
  return user;
}

describe("ServerGroupPicker — production-server warning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serversRef.current = [];
    attachmentsRef.current = [];
  });

  it("warns that agents write and delete, and to avoid production", async () => {
    attachmentsRef.current = [
      { _id: "a-1", name: "Stripe", serverIds: ["s-stripe"] },
    ];
    await openPicker();

    const warning = screen.getByTestId("server-group-production-warning");
    // Pin "writing AND deleting" as one phrase: matching only the delete half
    // would let the write claim be dropped silently, and writing is the half
    // that surprises people about a read-only-looking test run.
    expect(warning).toHaveTextContent(/real actions/i);
    expect(warning).toHaveTextContent(/writing and\s+deleting data/i);
    expect(warning).toHaveTextContent(/not production/i);
  });

  // Placement, not just presence. Radix does not mount closed popover content,
  // so "absent before opening" passes even with the warning deleted and proves
  // nothing. What actually breaks the feature is the warning drifting below
  // the group list, where a long list pushes it under the fold — so assert it
  // sits above the list, next to the header.
  it("sits above the group list, not under it", async () => {
    attachmentsRef.current = [
      { _id: "a-1", name: "Stripe", serverIds: ["s-stripe"] },
      { _id: "a-2", name: "Linear", serverIds: ["s-linear"] },
    ];
    await openPicker();

    const warning = screen.getByTestId("server-group-production-warning");
    const header = screen.getByText("Server groups");
    const firstGroup = screen.getByText("Stripe");

    expect(
      header.compareDocumentPosition(warning) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      warning.compareDocumentPosition(firstGroup) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // The empty state is the first-run path: no groups yet, so the user is one
  // create away from aiming a swarm somewhere. The warning has to survive it.
  it("still warns when the project has no groups yet", async () => {
    await openPicker();

    expect(
      screen.getByTestId("server-group-production-warning"),
    ).toBeInTheDocument();
    expect(screen.getByText(/no server groups yet/i)).toBeInTheDocument();
  });

  // The create form REPLACES the list, so a warning that lives only in the
  // list branch vanishes at the exact moment a first-run user is choosing
  // which servers go in the group — and a click-away from this form commits
  // the group and selects it. This is the branch that most needs the warning.
  it("keeps warning inside the create form", async () => {
    serversRef.current = [
      { _id: "s-prod", name: "prod", url: "https://prod.example.com/mcp" },
    ];
    const user = await openPicker();
    await user.click(screen.getByRole("button", { name: /create new group/i }));

    // The list is gone — proving we are really on the other branch.
    expect(screen.queryByText("Server groups")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/group name/i)).toBeInTheDocument();
    expect(
      screen.getByTestId("server-group-production-warning"),
    ).toHaveTextContent(/not production/i);
  });
});

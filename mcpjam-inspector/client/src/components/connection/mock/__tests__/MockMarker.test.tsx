import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";

const state = vi.hoisted(() => ({
  flag: true,
  servers: [] as unknown[],
  definition: {} as Record<string, unknown>,
  policy: "allow" as "allow" | "block",
  fail: false,
}));
const query = vi.hoisted(() => vi.fn());
// One client for every render, as `useConvex` gives in the app: a new object
// each render would restart the hook's effect and loop.
const client = vi.hoisted(() => ({ query }));

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => state.flag,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useQuery: () => state.servers,
  useConvex: () => client,
}));

import { MockMarker } from "../MockMarker";

const server = (over: Record<string, unknown>) => ({
  _id: "s1",
  projectId: "p1",
  name: "Ordinary",
  ...over,
});
const support = server({ _id: "base", name: "Support" });
// The backend leaves `baseServerId` out of a mock made from empty, so absent is as real as null.
const mock = (id: string, name: string, baseServerId: string | null | undefined) =>
  server({
    _id: id,
    name,
    lifecycleScope: "mock",
    mock: { ...(baseServerId !== undefined && { baseServerId }), headVersion: 2 },
  });

const threeChanges = {
  instructions: "Be brief.",
  tools: { lookup: { description: "d" }, close: { hidden: true } },
};

beforeEach(() => {
  state.flag = true;
  state.policy = "allow";
  state.fail = false;
  state.definition = threeChanges;
  state.servers = [support, mock("m1", "Support sandbox", "base")];
  query.mockReset();
  query.mockImplementation(async (_ref: unknown, args: { mockId: string }) => {
    if (state.fail) throw new Error("refused");
    if (getFunctionName(_ref as never) === "mockPolicy:getForMock") {
      return { forwarding: state.policy, scope: "workspace", updatedAt: null };
    }
    return { definitionJson: JSON.stringify(state.definition), version: 2, mockId: args.mockId };
  });
});
afterEach(cleanup);

const renderMarker = (serverId = "m1") =>
  render(<MockMarker projectId="p1" serverId={serverId} />);

describe("MockMarker", () => {
  it("shows nothing for an ordinary server", () => {
    state.servers = [support, mock("m1", "Support sandbox", "base")];
    const { container } = renderMarker("base");
    expect(container).toBeEmptyDOMElement();
    expect(query).not.toHaveBeenCalled();
  });

  it("shows nothing while mock-servers-enabled is off", () => {
    state.flag = false;
    const { container } = renderMarker();
    expect(container).toBeEmptyDOMElement();
    expect(query).not.toHaveBeenCalled();
  });

  it("names the backing server and counts three changes", async () => {
    renderMarker();
    expect(await screen.findByRole("button", { name: "Mock of Support · 3 changes" })).toBeVisible();
  });

  it("reads Mock · 1 change for a mock from empty", async () => {
    state.servers = [mock("m2", "Ticket intake", null)];
    state.definition = { tools: { create_ticket: { description: "d" } } };
    renderMarker("m2");
    expect(await screen.findByRole("button", { name: "Mock · 1 change" })).toBeVisible();
  });

  it("counts zero changes", async () => {
    state.definition = {};
    renderMarker();
    expect(await screen.findByRole("button", { name: "Mock of Support · 0 changes" })).toBeVisible();
  });

  it("opens the panel with the name, backing server, policy and changes", async () => {
    const user = userEvent.setup();
    renderMarker();
    await user.click(await screen.findByRole("button", { name: /Mock of Support/ }));
    const panel = await screen.findByRole("dialog", { name: "Support sandbox" });
    expect(panel).toHaveTextContent("Backing server");
    expect(panel).toHaveTextContent("Support");
    expect(panel).toHaveTextContent("Allowed");
    expect(panel).toHaveTextContent(
      "Unmatched requests go to the backing server with your access."
    );
    expect(panel).toHaveTextContent("Instructions revised");
    expect(panel).toHaveTextContent("lookup");
    expect(panel).toHaveTextContent("close");
  });

  it("says unmatched requests are not sent when the policy blocks", async () => {
    state.policy = "block";
    const user = userEvent.setup();
    renderMarker();
    await user.click(await screen.findByRole("button", { name: /Mock of Support/ }));
    const panel = await screen.findByRole("dialog");
    await waitFor(() => expect(panel).toHaveTextContent("Blocked"));
    expect(panel).toHaveTextContent("Unmatched requests are not sent to the backing server.");
  });

  it("names a removed base differently from no base", async () => {
    state.servers = [mock("m3", "Orphan", "gone")];
    const user = userEvent.setup();
    renderMarker("m3");
    await user.click(await screen.findByRole("button", { name: /^Mock/ }));
    const panel = await screen.findByRole("dialog", { name: "Orphan" });
    expect(panel).toHaveTextContent("A server no longer in this project");
  });

  it.each([
    ["allow", null],
    ["block", null],
    ["allow", undefined],
    ["block", undefined],
  ] as const)(
    "says there is nothing to call with no backing server (%s, base %s)",
    async (policy, base) => {
      state.policy = policy;
      state.servers = [mock("m2", "Ticket intake", base)];
      const user = userEvent.setup();
      renderMarker("m2");
      await user.click(await screen.findByRole("button", { name: /^Mock/ }));
      const panel = await screen.findByRole("dialog", { name: "Ticket intake" });
      expect(panel).toHaveTextContent("None");
      expect(panel).not.toHaveTextContent("no longer in this project");
      expect(panel).toHaveTextContent(
        "This mock has no backing server, so there is nothing to call under either setting."
      );
    }
  );

  it("reads the policy again on reopening, and shows loading rather than the old answer", async () => {
    const user = userEvent.setup();
    renderMarker();
    await user.click(await screen.findByRole("button", { name: /Mock of Support/ }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Allowed");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // The policy changed while the panel was closed, and the next read is slow.
    state.policy = "block";
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const answer = query.getMockImplementation()!;
    query.mockImplementation(async (ref: unknown, args: { mockId: string }) => {
      await slow;
      return answer(ref, args);
    });
    await user.click(await screen.findByRole("button", { name: /Mock of Support/ }));
    const panel = await screen.findByRole("dialog");
    expect(panel).toHaveTextContent("Loading.");
    expect(panel).not.toHaveTextContent("Allowed");
    release();
    await waitFor(() => expect(panel).toHaveTextContent("Blocked"));
  });

  it("opens with Enter and returns focus to the marker on Escape", async () => {
    const user = userEvent.setup();
    renderMarker();
    const marker = await screen.findByRole("button", { name: /Mock of Support/ });
    marker.focus();
    expect(marker).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog")).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(marker).toHaveFocus();
  });

  it("opens with Space", async () => {
    const user = userEvent.setup();
    renderMarker();
    const marker = await screen.findByRole("button", { name: /Mock of Support/ });
    marker.focus();
    await user.keyboard(" ");
    expect(await screen.findByRole("dialog")).toBeVisible();
  });

  it("tells the reader when the details cannot be read", async () => {
    state.fail = true;
    const user = userEvent.setup();
    renderMarker();
    await user.click(await screen.findByRole("button", { name: "Mock of Support" }));
    const panel = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(panel).toHaveTextContent("Couldn't load this mock's details. Close this panel and open it again.")
    );
  });
});

import { StrictMode } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  owner: "owned-user",
  rows: [] as unknown[],
  mutate: vi.fn(),
  action: vi.fn(),
  post: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useConvex: () => ({ mutation: state.mutate, action: state.action }),
  useQuery: (name: string) =>
    name === "users:getCurrentUser" ? { _id: state.owner } : state.rows,
}));
vi.mock("@/lib/apis/web/base", () => ({ webPost: state.post }));
import {
  OwnedPluginFormHost,
  PLUGIN_FORM_SUBMIT_TIMEOUT_MS,
} from "../OwnedPluginFormHost";

function request(id = "owned-request") {
  return {
    rendezvousId: id,
    serverId: "owned-server",
    mode: "form",
    message: "Choose disposable parts",
    requestedSchema: {
      type: "object",
      required: ["note"],
      properties: {
        note: { type: "string", minLength: 2 },
        choices: { type: "array", items: { type: "string" } },
        flag: { type: "boolean" },
        count: { type: "integer" },
      },
    },
    expiresAt: Date.now() + 60000,
    formDialect: "openai",
    pluginWorkspaceId: "workspace",
  };
}
const ui = () => (
  <StrictMode>
    <OwnedPluginFormHost projectId="project" workspaceId="workspace" />
  </StrictMode>
);
describe("owned plugin form delivery surface", () => {
  beforeEach(() => {
    state.owner = "owned-user";
    state.rows = [request()];
    state.action
      .mockReset()
      .mockResolvedValue(JSON.stringify(request().requestedSchema));
    state.mutate.mockReset().mockResolvedValue({ ok: true });
    state.post
      .mockReset()
      .mockResolvedValue({ ok: true, storageId: "owned-receipt" });
  });
  it("survives StrictMode and explicitly retries the same private receipt after an uncertain acknowledgement", async () => {
    state.mutate.mockRejectedValueOnce(new Error("lost acknowledgement"));
    render(ui());
    fireEvent.change(screen.getByLabelText(/note/i), {
      target: { value: "disposable ".repeat(8000) },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Accept", exact: true }),
    );
    await screen.findByText("The answer could not be submitted. Try again.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Accept", exact: true }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(state.post).toHaveBeenCalledTimes(1);
    expect(state.mutate).toHaveBeenCalledTimes(2);
    for (const [, args] of state.mutate.mock.calls) {
      expect(args).toEqual({
        rendezvousId: "owned-request",
        action: "accept",
        contentBlobId: "owned-receipt",
      });
      expect(args).not.toHaveProperty("content");
    }
  });
  it("fences a late upload when the actor changes under the same request identifier", async () => {
    let complete!: (value: unknown) => void;
    state.post.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const mounted = render(ui());
    fireEvent.change(screen.getByLabelText(/note/i), {
      target: { value: "old disposable answer" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Accept", exact: true }),
    );
    await waitFor(() => expect(state.post).toHaveBeenCalledTimes(1));
    const signal = state.post.mock.calls[0][2].signal;
    state.owner = "replacement-user";
    mounted.rerender(ui());
    expect(signal.aborted).toBe(true);
    complete({ ok: true, storageId: "obsolete-receipt" });
    await Promise.resolve();
    await Promise.resolve();
    expect(state.mutate).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/note/i)).toHaveValue("");
  });
  it.each(["Decline", "Cancel"])(
    "keeps %s contentless and does not upload",
    async (action) => {
      render(ui());
      fireEvent.click(
        screen.getByRole("button", { name: action, exact: true }),
      );
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      expect(state.post).not.toHaveBeenCalled();
      expect(state.mutate).toHaveBeenCalledWith(
        "elicitations:respondToElicitation",
        { rendezvousId: "owned-request", action: action.toLowerCase() },
      );
    },
  );
  it("does not interpret an ordinary or another workspace's schema as an extension", () => {
    state.rows = [
      { ...request(), formDialect: undefined },
      { ...request("foreign"), pluginWorkspaceId: "foreign" },
    ];
    render(ui());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(state.post).not.toHaveBeenCalled();
  });
  it("withholds the editor until the private schema arrives, then retries a failed read", async () => {
    state.rows = [
      { ...request(), requestedSchema: undefined, hasPrivateSchema: true },
    ];
    state.action.mockRejectedValue(new Error("private service unavailable"));
    render(ui());
    expect(
      screen.queryByRole("button", { name: "Accept", exact: true }),
    ).not.toBeInTheDocument();
    await screen.findByRole("heading", { name: "Form unavailable" });
    state.action.mockResolvedValue(JSON.stringify(request().requestedSchema));
    fireEvent.click(screen.getByRole("button", { name: "Retry", exact: true }));
    await screen.findByLabelText(/note/i);
    expect(state.action).toHaveBeenLastCalledWith("pluginFormSchemas:read", {
      rendezvousId: "owned-request",
      projectId: "project",
      pluginWorkspaceId: "workspace",
      serialized: true,
    });
    expect(state.post).not.toHaveBeenCalled();
  });
  it.each(["owner", "removed", "expired"])(
    "fences a late private schema after %s",
    async (change) => {
      const initial = {
        ...request(),
        requestedSchema: undefined,
        hasPrivateSchema: true,
      };
      state.rows = [initial];
      const completions: ((value: unknown) => void)[] = [];
      state.action.mockImplementation(
        () => new Promise((resolve) => completions.push(resolve)),
      );
      const mounted = render(ui());
      await waitFor(() => expect(completions.length).toBeGreaterThan(0));
      if (change === "owner") state.owner = "replacement-user";
      if (change === "removed") state.rows = [];
      if (change === "expired")
        state.rows = [{ ...initial, expiresAt: Date.now() - 1 }];
      mounted.rerender(ui());
      for (const complete of completions.slice(0, 2))
        complete(JSON.stringify(request().requestedSchema));
      await Promise.resolve();
      await Promise.resolve();
      expect(screen.queryByLabelText(/note/i)).not.toBeInTheDocument();
      expect(state.mutate).not.toHaveBeenCalled();
    },
  );
  it("cancels safely while the private schema is unavailable", async () => {
    state.rows = [
      { ...request(), requestedSchema: undefined, hasPrivateSchema: true },
    ];
    state.action.mockImplementation(() => new Promise(() => {}));
    render(ui());
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel", exact: true }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(state.mutate).toHaveBeenCalledWith(
      "elicitations:respondToElicitation",
      { rendezvousId: "owned-request", action: "cancel" },
    );
    expect(state.post).not.toHaveBeenCalled();
  });
  it("ends a send that never returns with a plain, retryable error in the modal", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout"],
      shouldAdvanceTime: true,
    });
    state.mutate.mockImplementationOnce(() => new Promise(() => {}));
    render(ui());
    fireEvent.change(screen.getByLabelText(/note/i), {
      target: { value: "kept answer" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Accept", exact: true }),
    );
    await act(() => vi.advanceTimersByTimeAsync(PLUGIN_FORM_SUBMIT_TIMEOUT_MS));
    expect(
      await screen.findByText(/didn't confirm the answer within 30 seconds/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/note/i)).toHaveValue("kept answer");
    fireEvent.click(
      screen.getByRole("button", { name: "Accept", exact: true }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(state.mutate).toHaveBeenCalledTimes(2);
    expect(state.mutate.mock.calls[1]).toEqual(state.mutate.mock.calls[0]);
  });
});
afterEach(() => {
  vi.useRealTimers();
});

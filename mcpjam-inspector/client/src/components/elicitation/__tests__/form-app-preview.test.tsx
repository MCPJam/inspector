import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
const state = vi.hoisted(() => ({
  fetch: vi.fn(),
  register: vi.fn(),
  host: {},
  workspace: {
    workspaceId: "form",
    surfaces: { getState: () => ({ upsertRegistration: state.register }) },
  },
}));
vi.mock("@/lib/session-token", () => ({ authFetch: state.fetch }));
vi.mock("../../chat-v2/thread/mcp-apps/use-widget-host", () => ({
  useWidgetHost: () => state.host,
}));
vi.mock("../../host-workspace/thread-app-host", () => ({
  createThreadAppHost: () => state.host,
}));
vi.mock("@mcpjam/widget-react", () => ({
  WidgetWorkspaceProvider: ({ children }: { children: ReactNode }) => children,
  useWidgetWorkspace: () => state.workspace,
  WidgetWorkspaceSurfaceHost: ({
    activeSurfaceId,
  }: {
    activeSurfaceId?: string;
  }) => <span>{activeSurfaceId ? "Live preview" : "Hidden preview"}</span>,
}));
import { PluginFormPreviewServices } from "../form-app-preview";
import { PLUGIN_FORM_PREVIEW_TIMEOUT_MS } from "../form-resource-preview";
import { useTrafficLogStore } from "@/stores/traffic-log-store";
const target = {
  type: "mcp_app_tool" as const,
  name: "preview",
  arguments: { part: "bolt" },
};
const signal = () => new AbortController().signal;
function fixture() {
  let release: (() => void) | undefined;
  return render(
    <PluginFormPreviewServices
      scope={{ projectId: "project", workspaceId: "workspace" }}
      sourceToken="source"
      parent={{ kind: "legacy", id: "parent", round: 0 }}
      expiresAt={Date.now() + 60000}
    >
      {({ ports, presentation }) => (
        <>
          <button
            onClick={() =>
              void ports.preview!(target, signal()).then((view) => {
                release = view.release;
              })
            }
          >
            Open preview
          </button>
          <button onClick={() => release?.()}>Close preview</button>
          {presentation}
        </>
      )}
    </PluginFormPreviewServices>,
  );
}
afterEach(() => {
  vi.useRealTimers();
});
beforeEach(() => {
  state.fetch.mockReset().mockImplementation(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.endsWith("/open")
            ? {
                instanceToken: "token",
                instanceId: "view",
                operationId: "operation",
                resourceUri: "ui://preview",
                toolTitle: "Preview",
                toolName: "preview",
                serverId: "server",
                appToolsEnabled: false,
                widgetContent: { html: "<p>Preview</p>" },
              }
            : { status: "completed", result: { content: [] } },
        ),
        { status: 200 },
      ),
  );
  state.register.mockReset();
});
describe("retained form App presentation", () => {
  it("opens and registers once, then hides and reopens without another activation", async () => {
    fixture();
    fireEvent.click(screen.getByText("Open preview"));
    await screen.findByText("Live preview");
    await waitFor(() => expect(state.register).toHaveBeenCalled());
    fireEvent.click(screen.getByText("Close preview"));
    await screen.findByText("Hidden preview");
    fireEvent.click(screen.getByText("Open preview"));
    await screen.findByText("Live preview");
    expect(state.fetch).toHaveBeenCalledTimes(2);
    expect(state.fetch.mock.calls.map(([url]) => url)).toEqual([
      expect.stringMatching(/\/open$/),
      expect.stringMatching(/\/execute$/),
    ]);
  });
  it("keeps the same immutable request body after a lost response", async () => {
    state.fetch.mockRejectedValueOnce(new Error("response lost"));
    fixture();
    fireEvent.click(screen.getByText("Open preview"));
    await screen.findByText("Live preview");
    expect(state.fetch.mock.calls[0][1].body).toBe(
      state.fetch.mock.calls[1][1].body,
    );
  });
});

describe("opening a form's App preview", () => {
  function open(
    preview: { type: "mcp_app_tool"; name: string; arguments?: object },
  ) {
    const outcome: { error?: unknown; opened?: boolean } = {};
    render(
      <PluginFormPreviewServices
        scope={{ projectId: "project", workspaceId: "workspace" }}
        server={{ serverId: "asking-server", serverName: "Asking" }}
        sourceToken="source"
        parent={{ kind: "legacy", id: "parent", round: 0 }}
        expiresAt={Date.now() + 10 * 60_000}
      >
        {({ ports, presentation }) => (
          <>
            <button
              onClick={() =>
                void ports.preview!(preview as never, signal()).then(
                  () => (outcome.opened = true),
                  (error) => (outcome.error = error),
                )
              }
            >
              Open preview
            </button>
            {presentation}
          </>
        )}
      </PluginFormPreviewServices>,
    );
    fireEvent.click(screen.getByText("Open preview"));
    return outcome;
  }

  it("opens on the server that asked for the form, with arguments defaulting to {}", async () => {
    state.fetch.mockImplementation(async (url: string) =>
      Response.json(
        url.endsWith("/open")
          ? {
              instanceToken: "token",
              instanceId: "view",
              operationId: "operation",
              resourceUri: "ui://preview",
              toolTitle: "Preview",
              toolName: "part.preview",
              serverId: "asking-server",
              widgetContent: { html: "<p>Preview</p>" },
            }
          : { status: "completed", result: { content: [] } },
      ),
    );
    const outcome = open({ type: "mcp_app_tool", name: "part.preview" });
    await screen.findByText("Live preview");
    expect(outcome.opened).toBe(true);
    expect(
      JSON.parse(state.fetch.mock.calls[0][1].body).target,
    ).toEqual({ type: "mcp_app_tool", name: "part.preview" });
    await waitFor(() => expect(state.register).toHaveBeenCalled());
    const [, , params] = state.register.mock.calls[0];
    expect(params).toMatchObject({
      serverId: "asking-server",
      toolName: "part.preview",
      toolInput: {},
    });
  });

  it("doesn't count the person's approval against the deadline", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout"],
      shouldAdvanceTime: true,
    });
    let executes = 0;
    state.fetch.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith("/open"))
        return Response.json({
          instanceToken: "token",
          instanceId: "view",
          operationId: "operation",
          resourceUri: "ui://preview",
          toolTitle: "Preview",
          toolName: "part.preview",
          serverId: "asking-server",
          widgetContent: { html: "<p>Preview</p>" },
        });
      executes++;
      return JSON.parse(String(init.body)).approval
        ? Response.json({ status: "completed", result: { content: [] } })
        : Response.json(
            {
              status: "approval_required",
              approval: { id: "approval", name: "part.preview", params: {} },
            },
            { status: 409 },
          );
    });
    const outcome = open({ type: "mcp_app_tool", name: "part.preview" });
    const allow = await screen.findByRole("button", { name: "Allow" });
    // Far past the deadline while the person reads the approval.
    await act(() =>
      vi.advanceTimersByTimeAsync(3 * PLUGIN_FORM_PREVIEW_TIMEOUT_MS),
    );
    expect(outcome.error).toBeUndefined();
    fireEvent.click(allow);
    await screen.findByText("Live preview");
    expect(outcome.opened).toBe(true);
    expect(executes).toBe(2);
  });

  it("fails a stalled open within the deadline, described and logged", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    state.fetch.mockImplementation(() => new Promise(() => {}));
    useTrafficLogStore.getState().clear();
    const outcome = open({ type: "mcp_app_tool", name: "part.preview" });
    await act(() => vi.advanceTimersByTimeAsync(PLUGIN_FORM_PREVIEW_TIMEOUT_MS));
    expect(outcome.error).toMatchObject({
      code: "PLUGIN_FORM_PREVIEW_TIMEOUT",
      message: expect.stringMatching(/didn't open within 30 seconds/),
    });
    const logs = useTrafficLogStore
      .getState()
      .mcpServerItems.filter((item) => item.serverId === "asking-server");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      method: "plugin-extensions/PLUGIN_FORM_PREVIEW_TIMEOUT",
      payload: expect.objectContaining({ tool: "part.preview" }),
    });
    expect(screen.getByText("Hidden preview")).toBeInTheDocument();
  });

  it("retries a stalled open with a fresh request instead of joining it", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout"],
      shouldAdvanceTime: true,
    });
    const served = state.fetch.getMockImplementation()!;
    // The first open never answers, even when it is cancelled.
    state.fetch.mockImplementationOnce(() => new Promise(() => {}));
    const first = open({ type: "mcp_app_tool", name: "preview" });
    await act(() => vi.advanceTimersByTimeAsync(PLUGIN_FORM_PREVIEW_TIMEOUT_MS));
    expect(first.error).toMatchObject({ code: "PLUGIN_FORM_PREVIEW_TIMEOUT" });
    state.fetch.mockImplementation(served);
    fireEvent.click(screen.getByText("Open preview"));
    await screen.findByText("Live preview");
    expect(
      state.fetch.mock.calls.map(([url]) => String(url).split("/").pop()),
    ).toEqual(["open", "open", "execute"]);
  });

  it("names a server refusal in its own words", async () => {
    state.fetch.mockImplementation(async () =>
      Response.json(
        {
          code: "FORM_PREVIEW_UNAVAILABLE",
          description: "That preview isn't available for this form.",
        },
        { status: 403 },
      ),
    );
    const outcome = open({ type: "mcp_app_tool", name: "part.preview" });
    await waitFor(() =>
      expect(outcome.error).toMatchObject({
        code: "FORM_PREVIEW_UNAVAILABLE",
        message: "That preview isn't available for this form.",
      }),
    );
  });
});

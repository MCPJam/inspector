import { useLayoutEffect, useRef } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  rows: [] as unknown[],
  mutate: vi.fn(),
  action: vi.fn(),
  post: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useConvex: () => ({ mutation: state.mutate, action: state.action }),
  useQuery: (name: string, args: unknown) =>
    name === "users:getCurrentUser"
      ? { _id: "owner" }
      : args === "skip"
        ? undefined
        : state.rows,
}));
vi.mock("@/lib/apis/web/base", () => ({ webPost: state.post }));
const services = vi.hoisted(() => ({ fetch: vi.fn(), register: vi.fn() }));
vi.mock("@/lib/session-token", () => ({ authFetch: services.fetch }));
vi.mock("../../chat-v2/thread/mcp-apps/use-widget-host", () => ({
  useWidgetHost: () => ({}),
}));
vi.mock("../../host-workspace/thread-app-host", () => ({
  createThreadAppHost: () => ({}),
}));
vi.mock("@mcpjam/widget-react", () => ({
  WidgetWorkspaceProvider: ({ children }: { children: unknown }) => children,
  useWidgetWorkspace: () => ({
    workspaceId: "form",
    surfaces: {
      getState: () => ({ upsertRegistration: services.register }),
    },
  }),
  WidgetWorkspaceSurfaceHost: ({
    activeSurfaceId,
  }: {
    activeSurfaceId?: string | null;
  }) => (activeSurfaceId ? <p>App preview surface</p> : null),
}));
import {
  ChatPluginFormHosts,
  OwnedPluginFormHost,
} from "../OwnedPluginFormHost";
import {
  HostedMrtrHost,
  __resetHostedMrtrHostElection,
} from "../HostedMrtrHost";
import {
  __resetComposerFormStore,
  cancelComposerForms,
  registerComposerSlot,
  useComposerForms,
} from "../composer-form-store";
import { useHostedMrtrStore } from "@/stores/hosted-mrtr-store";
import { useTrafficLogStore } from "@/stores/traffic-log-store";
import { PLUGIN_FORM_PREVIEW_TIMEOUT_MS } from "../form-resource-preview";
import { PLUGIN_FORM_SUBMIT_TIMEOUT_MS } from "../OwnedPluginFormHost";

/** The ChatInput contract in miniature: status lines plus the card slot. */
function Composer({ workspaceId }: { workspaceId: string }) {
  const slot = useRef<HTMLDivElement>(null);
  const forms = useComposerForms(workspaceId);
  useLayoutEffect(
    () => registerComposerSlot(workspaceId, slot.current!),
    [workspaceId],
  );
  return (
    <div>
      <p data-testid="queue">{forms.map((f) => f.serverName).join(",")}</p>
      <div ref={slot} data-testid="slot" />
      <textarea aria-label="draft" hidden={forms.length > 0} />
    </div>
  );
}

function row(id: string, workspace = "chat-a", message = `Form ${id}`) {
  return {
    rendezvousId: id,
    serverId: `server-${id}`,
    serverName: `Server ${id}`,
    mode: "form",
    message,
    requestedSchema: {
      type: "object",
      properties: { note: { type: "string", title: "Note" } },
    },
    expiresAt: Date.now() + 60_000,
    formDialect: "openai",
    pluginWorkspaceId: workspace,
  };
}

function ui(workspaceId = "chat-a") {
  return (
    <>
      <Composer workspaceId={workspaceId} />
      <OwnedPluginFormHost projectId="project" workspaceId={workspaceId} />
    </>
  );
}

beforeEach(() => {
  __resetComposerFormStore();
  state.rows = [];
  state.mutate.mockReset().mockResolvedValue({ ok: true });
  state.post.mockReset().mockResolvedValue({ ok: true, storageId: "receipt" });
  state.action.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  __resetComposerFormStore();
});

describe("composer form scheduling", () => {
  it("shows one card per chat in arrival order instead of the modal", async () => {
    state.rows = [row("one"), row("two")];
    const view = render(ui());
    const slot = screen.getByTestId("slot");
    await waitFor(() => expect(slot).toHaveTextContent("Form one"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(slot).not.toHaveTextContent("Form two");
    expect(screen.getByTestId("queue")).toHaveTextContent(
      "Server one,Server two",
    );
    fireEvent.change(screen.getByLabelText(/Note/), {
      target: { value: "first" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(state.mutate).toHaveBeenCalledTimes(1));
    expect(state.mutate.mock.calls[0][1]).toMatchObject({
      rendezvousId: "one",
      action: "accept",
    });
    // The server resolves the first request; the next one takes its place.
    state.rows = [row("two")];
    view.rerender(ui());
    await waitFor(() =>
      expect(screen.getByTestId("slot")).toHaveTextContent("Form two"),
    );
    expect(screen.getByTestId("queue")).toHaveTextContent("Server two");
  });

  it("keeps a pending form with its own chat across a switch", async () => {
    state.rows = [row("one", "chat-a")];
    const view = render(ui("chat-a"));
    await waitFor(() =>
      expect(screen.getByTestId("slot")).toHaveTextContent("Form one"),
    );
    // Chat B has nothing pending; chat A's request is not cancelled.
    view.rerender(ui("chat-b"));
    await waitFor(() =>
      expect(screen.getByTestId("slot")).toBeEmptyDOMElement(),
    );
    expect(screen.getByLabelText("draft")).toBeVisible();
    expect(state.mutate).not.toHaveBeenCalled();
    view.rerender(ui("chat-a"));
    await waitFor(() =>
      expect(screen.getByTestId("slot")).toHaveTextContent("Form one"),
    );
  });

  describe("a chat's pending form stays with it", () => {
    /** The Playground: one composer for the shown chat, hosts for every chat. */
    function playground(shown: string) {
      return (
        <>
          <Composer workspaceId={shown} />
          <ChatPluginFormHosts
            current={{ projectId: "project", workspaceId: shown }}
          />
        </>
      );
    }

    it("keeps typed answers across a chat switch", async () => {
      state.rows = [row("one", "chat-a")];
      const view = render(playground("chat-a"));
      const note = await screen.findByLabelText(/Note/);
      fireEvent.change(note, { target: { value: "half an answer" } });
      view.rerender(playground("chat-b"));
      await waitFor(() =>
        expect(screen.getByTestId("slot")).toBeEmptyDOMElement(),
      );
      // Leaving the chat neither cancels nor shows the form as a modal.
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(state.mutate).not.toHaveBeenCalled();
      view.rerender(playground("chat-a"));
      expect(await screen.findByLabelText(/Note/)).toHaveValue(
        "half an answer",
      );
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await waitFor(() => expect(state.mutate).toHaveBeenCalledTimes(1));
      expect(state.mutate.mock.calls[0][1]).toMatchObject({
        rendezvousId: "one",
        action: "accept",
      });
    });

    it("cancels a pending form when its chat is archived while not shown", async () => {
      state.rows = [row("one", "chat-a")];
      const view = render(playground("chat-a"));
      await waitFor(() =>
        expect(screen.getByTestId("slot")).toHaveTextContent("Form one"),
      );
      view.rerender(playground("chat-b"));
      await waitFor(() =>
        expect(screen.getByTestId("slot")).toBeEmptyDOMElement(),
      );
      act(() => cancelComposerForms("chat-a"));
      await waitFor(() => expect(state.mutate).toHaveBeenCalledTimes(1));
      expect(state.mutate.mock.calls[0][1]).toEqual({
        rendezvousId: "one",
        action: "cancel",
      });
    });
  });

  it("cancels each pending form of a closed chat exactly once", async () => {
    state.rows = [row("one"), row("two")];
    render(ui());
    await waitFor(() =>
      expect(screen.getByTestId("queue")).toHaveTextContent(
        "Server one,Server two",
      ),
    );
    act(() => {
      cancelComposerForms("chat-a");
      cancelComposerForms("chat-a");
    });
    await waitFor(() => expect(state.mutate).toHaveBeenCalledTimes(2));
    expect(state.mutate.mock.calls.map((call) => call[1])).toEqual([
      { rendezvousId: "one", action: "cancel" },
      { rendezvousId: "two", action: "cancel" },
    ]);
  });

  it("names the unsupported field in the card and writes one Logs entry", async () => {
    useTrafficLogStore.getState().clear();
    state.rows = [
      {
        ...row("one"),
        requestedSchema: {
          type: "object",
          properties: {
            refs: {
              type: "array",
              title: "CAD references",
              items: { type: "string", format: "uri" },
              "x-openai-input": {
                type: "resource",
                options: [],
                selection: "implicit",
              },
            },
          },
        },
      },
    ];
    render(ui());
    await waitFor(() =>
      expect(screen.getByTestId("slot")).toHaveTextContent(
        "CAD references: Adding your own files or folders isn't available here.",
      ),
    );
    // Exactly one Logs entry for the refused form, from the shared
    // diagnostic, naming the field.
    const logs = useTrafficLogStore
      .getState()
      .mcpServerItems.filter((item) => item.serverId === "server-one");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      method: "plugin-extensions/PLUGIN_FORM_RESOURCE_SERVICE_UNAVAILABLE",
      payload: expect.objectContaining({ field: "refs" }),
    });
    expect(screen.getByTestId("slot")).not.toHaveTextContent(
      /PLUGIN_FORM|x-openai/,
    );
  });

  it.each([
    [false, "refuses"],
    [true, "shows"],
  ])(
    "applies the File resources rule to an App's legacy form (toggle %s %s it)",
    async (fileResources) => {
      services.fetch.mockReset().mockImplementation(async () =>
        Response.json({
          userResources: true,
          userResourceKinds: ["file", "directory"],
          origin: "mcp-app",
          fileResources,
        }),
      );
      state.rows = [
        {
          ...row("one"),
          pluginFormSourceToken: "a".repeat(43),
          requestedSchema: {
            type: "object",
            properties: {
              refs: {
                type: "array",
                title: "CAD references",
                items: { type: "string", format: "uri" },
                "x-openai-input": {
                  type: "resource",
                  selection: "implicit",
                  options: [],
                },
              },
            },
          },
        },
      ];
      render(ui());
      const slot = screen.getByTestId("slot");
      if (fileResources)
        expect(
          await screen.findByRole("button", { name: "Choose files" }),
        ).toBeInTheDocument();
      else
        await waitFor(() =>
          expect(slot).toHaveTextContent(
            "CAD references: Adding your own files isn't available in forms opened from an App while this client's File resources extension is off.",
          ),
        );
    },
  );

  it("falls back to the modal when no composer is mounted", async () => {
    state.rows = [row("one")];
    render(<OwnedPluginFormHost projectId="project" workspaceId="chat-a" />);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});

describe("owned plugin MRTR rounds in the composer", () => {
  beforeEach(() => {
    __resetHostedMrtrHostElection();
    useHostedMrtrStore.getState().__reset();
  });
  afterEach(() => {
    __resetHostedMrtrHostElection();
    useHostedMrtrStore.getState().__reset();
  });
  it("collects a multi-request round card by card and submits it together", async () => {
    const submit = vi.fn(async () => {});
    render(
      <>
        <Composer workspaceId="chat-a" />
        <HostedMrtrHost />
      </>,
    );
    act(() =>
      useHostedMrtrStore.getState().enqueue(
        {
          key: "cont:1",
          continuationId: "cont",
          round: 1,
          serverId: "parts",
          serverName: "Parts Library",
          method: "tools/call",
          requests: ["first", "second"].map((key) => ({
            key,
            mode: "form" as const,
            message: `Question ${key}`,
            requestedSchema: {
              type: "object",
              properties: { note: { type: "string", title: "Note" } },
            },
          })),
          pluginFormProfile: {
            fileResources: true,
            origin: "server",
            userResources: false,
            previews: false,
          },
          pluginFormServiceScope: {
            projectId: "project",
            workspaceId: "chat-a",
          },
          expiresAt: Date.now() + 60_000,
          timestamp: new Date().toISOString(),
        },
        { submit },
      ),
    );
    const slot = screen.getByTestId("slot");
    await waitFor(() => expect(slot).toHaveTextContent("Question first"));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(slot).toHaveTextContent("Question second"));
    fireEvent.change(screen.getByLabelText(/Note/), {
      target: { value: "answer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect({ ...((submit.mock.calls[0] as unknown[])[0] as object) }).toEqual({
      first: { action: "decline" },
      second: { action: "accept", content: { note: "answer" } },
    });
  });

  it("keeps a round's typed answer while another chat is shown", async () => {
    const submit = vi.fn(async () => {});
    const view = render(
      <>
        <Composer workspaceId="chat-a" />
        <HostedMrtrHost />
      </>,
    );
    act(() =>
      useHostedMrtrStore.getState().enqueue(
        {
          key: "cont:1",
          continuationId: "cont",
          round: 1,
          serverId: "parts",
          serverName: "Parts Library",
          method: "tools/call",
          requests: [
            {
              key: "only",
              mode: "form" as const,
              message: "Question only",
              requestedSchema: {
                type: "object",
                properties: { note: { type: "string", title: "Note" } },
              },
            },
          ],
          pluginFormProfile: {
            fileResources: true,
            origin: "server",
            userResources: false,
            previews: false,
          },
          pluginFormServiceScope: {
            projectId: "project",
            workspaceId: "chat-a",
          },
          expiresAt: Date.now() + 60_000,
          timestamp: new Date().toISOString(),
        },
        { submit },
      ),
    );
    fireEvent.change(await screen.findByLabelText(/Note/), {
      target: { value: "kept" },
    });
    view.rerender(
      <>
        <Composer workspaceId="chat-b" />
        <HostedMrtrHost />
      </>,
    );
    await waitFor(() => expect(screen.queryByLabelText(/Note/)).toBeNull());
    view.rerender(
      <>
        <Composer workspaceId="chat-a" />
        <HostedMrtrHost />
      </>,
    );
    expect(await screen.findByLabelText(/Note/)).toHaveValue("kept");
    expect(submit).not.toHaveBeenCalled();
  });
});

/** A form whose second question offers one resource with a preview. */
function previewRow(target: Record<string, unknown>) {
  return {
    ...row("one", "chat-a", "Disposable form check"),
    pluginFormSourceToken: "a".repeat(43),
    requestedSchema: {
      type: "object",
      required: ["note"],
      properties: {
        note: { type: "string", title: "Note" },
        part: {
          type: "string",
          format: "uri",
          title: "Part",
          "x-openai-input": {
            type: "resource",
            options: [
              {
                uri: "fixture://part",
                name: "Disposable part",
                _meta: { "openai/preview": { target } },
              },
            ],
          },
        },
      },
    },
  };
}
const resourceTarget = {
  type: "resource_link",
  uri: "fixture://preview",
  name: "Part preview",
};
const appTarget = { type: "mcp_app_tool", name: "part.preview" };
function servePreviews() {
  services.fetch.mockReset().mockImplementation(async (url: string) =>
    Response.json(
      url.endsWith("/form-preview")
        ? {
            type: "resource",
            contents: [
              {
                uri: "fixture://preview",
                mimeType: "text/plain",
                text: "Disposable preview text",
              },
            ],
          }
        : url.endsWith("/app/open")
          ? {
              instanceToken: "token",
              instanceId: "view",
              operationId: "operation",
              resourceUri: "ui://preview",
              toolTitle: "Part preview",
              toolName: "part.preview",
              // The originating server, as the host reports it.
              serverId: "server-one",
              widgetContent: { html: "<p>Preview</p>" },
            }
          : { status: "completed", result: { content: [] } },
    ),
  );
}
/** Answer the first question, then reach the resource question. */
async function reachPreview() {
  const slot = screen.getByTestId("slot");
  await waitFor(() => expect(slot).toHaveTextContent("Disposable form check"));
  fireEvent.change(screen.getByLabelText(/Note/), {
    target: { value: "kept answer" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(screen.getByRole("radio", { name: "Disposable part" }));
  return slot;
}
async function backToFirstAnswer() {
  expect(screen.getByText("2 of 2")).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "Disposable part" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "Previous question" }));
  expect(screen.getByLabelText(/Note/)).toHaveValue("kept answer");
}

describe("form previews in the composer card", () => {
  beforeEach(() => {
    services.register.mockReset();
    useTrafficLogStore.getState().clear();
  });

  it.each([
    ["resource_link", resourceTarget, "Disposable preview text"],
    ["mcp_app_tool", appTarget, "App preview surface"],
  ])(
    "opens a %s preview and closes back to the same step with every answer",
    async (_kind, target, shown) => {
      servePreviews();
      state.rows = [previewRow(target)];
      render(ui());
      await reachPreview();
      fireEvent.click(
        screen.getByRole("button", { name: "Preview Disposable part" }),
      );
      expect(await screen.findByText(shown)).toBeInTheDocument();
      expect(screen.queryByText("Waiting for the host…")).toBeNull();
      const requests = services.fetch.mock.calls.map(([url, init]) => ({
        url: url as string,
        body: JSON.parse(String((init as RequestInit).body)),
      }));
      expect(requests[0].body).toMatchObject({
        sourceToken: "a".repeat(43),
        parent: { kind: "legacy", id: "one", round: 0 },
        target,
      });
      if (target === appTarget) {
        expect(requests.map(({ url }) => url.split("/").pop())).toEqual([
          "open",
          "execute",
        ]);
        // On the server that asked for the form; no arguments means {}.
        expect(services.register.mock.calls[0][2]).toMatchObject({
          serverId: "server-one",
          toolName: "part.preview",
          toolInput: {},
        });
      } else expect(requests).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
      await waitFor(() => expect(screen.queryByText(shown)).toBeNull());
      // Opening a preview never submits or changes the form.
      expect(state.post).not.toHaveBeenCalled();
      expect(state.mutate).not.toHaveBeenCalled();
      await backToFirstAnswer();
    },
  );

  it("says plainly when a preview can't open in time, logs it, and keeps the form", async () => {
    services.fetch.mockReset().mockImplementation(() => new Promise(() => {}));
    state.rows = [previewRow(resourceTarget)];
    render(ui());
    await reachPreview();
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout"],
      shouldAdvanceTime: true,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Preview Disposable part" }),
    );
    expect(screen.getByText("Waiting for the host…")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(PLUGIN_FORM_PREVIEW_TIMEOUT_MS));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The preview didn't open within 30 seconds",
    );
    expect(screen.queryByText("Waiting for the host…")).toBeNull();
    const logs = useTrafficLogStore
      .getState()
      .mcpServerItems.filter((item) => item.serverId === "server-one");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      method: "plugin-extensions/PLUGIN_FORM_PREVIEW_TIMEOUT",
      serverName: "Server one",
    });
    expect(
      screen.getByRole("button", { name: "Preview Disposable part" }),
    ).toBeEnabled();
    expect(state.mutate).not.toHaveBeenCalled();
    await backToFirstAnswer();
  });

  it.each(["upload", "answer"])(
    "turns a send whose %s never returns into a described, retryable error",
    async (stalled) => {
      if (stalled === "upload")
        state.post.mockImplementationOnce(() => new Promise(() => {}));
      else state.mutate.mockImplementationOnce(() => new Promise(() => {}));
      state.rows = [row("one", "chat-a", "Disposable form check")];
      render(ui());
      const slot = screen.getByTestId("slot");
      await waitFor(() =>
        expect(slot).toHaveTextContent("Disposable form check"),
      );
      fireEvent.change(screen.getByLabelText(/Note/), {
        target: { value: "kept answer" },
      });
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout"],
        shouldAdvanceTime: true,
      });
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled(),
      );
      await act(() => vi.advanceTimersByTimeAsync(PLUGIN_FORM_SUBMIT_TIMEOUT_MS));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "didn't confirm the answer within 30 seconds",
      );
      expect(screen.getByLabelText(/Note/)).toHaveValue("kept answer");
      expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
      const logs = useTrafficLogStore
        .getState()
        .mcpServerItems.filter((item) => item.serverId === "server-one");
      expect(logs.map((item) => item.method)).toEqual([
        "plugin-extensions/PLUGIN_FORM_SUBMIT_TIMEOUT",
      ]);
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await waitFor(() =>
        expect(slot).not.toHaveTextContent("Disposable form check"),
      );
      const sent = state.mutate.mock.calls.at(-1)![1];
      expect(sent).toEqual({
        rendezvousId: "one",
        action: "accept",
        contentBlobId: "receipt",
      });
      expect(state.post).toHaveBeenCalledTimes(stalled === "upload" ? 2 : 1);
    },
  );
});

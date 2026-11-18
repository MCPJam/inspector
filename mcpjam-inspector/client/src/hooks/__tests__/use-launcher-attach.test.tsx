import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LauncherDecision,
  LauncherPollResponse,
  LauncherTask,
} from "@/shared/launcher-attach";
import type { ServerWithName } from "@/state/app-types";
import { useLauncherProjectChoiceStore } from "@/lib/launcher-attach/project-choice";
import {
  launcherServerToFormData,
  useLauncherAttach,
  type UseLauncherAttachOptions,
} from "../use-launcher-attach";

const api = vi.hoisted(() => ({
  pollLauncherTasks: vi.fn(),
  claimLauncherAttach: vi.fn(async () => true),
  routeLauncherAttach: vi.fn(async () => {}),
  reportLauncherAttach: vi.fn(async () => {}),
  reportLauncherReleased: vi.fn(async () => {}),
  closeLauncherTab: vi.fn(),
}));
const toasts = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn(),
  });
  return { toast };
});

vi.mock("@/lib/launcher-attach/api", () => api);
vi.mock("@/lib/toast", () => toasts);

const ACME = { id: "proj-acme", name: "Acme Tools" };
const BILLING = { id: "proj-billing", name: "Billing" };
const SERVER = { name: "billing-mcp", url: "http://127.0.0.1:7102/mcp" };

function serverEntry(
  name: string,
  url: string,
  connectionStatus: ServerWithName["connectionStatus"],
): ServerWithName {
  return {
    name,
    config: { url } as ServerWithName["config"],
    connectionStatus,
    lastConnectionTime: new Date(0),
    retryCount: 0,
  };
}

function respondOnce(tasks: LauncherTask[], extra: Partial<LauncherPollResponse> = {}) {
  api.pollLauncherTasks.mockResolvedValueOnce({
    tasks,
    cancelledAttachIds: [],
    waitingForSignIn: [],
    ...extra,
  });
}

function setup(overrides: Partial<UseLauncherAttachOptions> = {}) {
  let props: UseLauncherAttachOptions;
  const hook = renderHook((p: UseLauncherAttachOptions) => useLauncherAttach(p), {
    initialProps: (props = {
      enabled: true,
      signedIn: true,
      project: ACME,
      servers: { other: serverEntry("other", "http://127.0.0.1:1/mcp", "connected") },
      selectedServer: "other",
      saveAndConnect: vi.fn(async (formData) => {
        props = {
          ...props,
          servers: {
            ...props.servers,
            [formData.name]: serverEntry(formData.name, formData.url!, "connected"),
          },
        };
        hook.rerender(props);
      }),
      connectSaved: vi.fn(async () => ({ status: "connected" })),
      saveWithoutConnecting: vi.fn(async () => true),
      removeServer: vi.fn(async () => {}),
      disconnectServer: vi.fn(async () => {}),
      selectServer: vi.fn(),
      requestSignIn: vi.fn(),
      ...overrides,
    }),
  });
  return { hook, props: () => props };
}

const decision = (createdByAttach: boolean): LauncherDecision => ({
  projectId: ACME.id,
  projectName: ACME.name,
  serverName: SERVER.name,
  createdByAttach,
});

describe("useLauncherAttach", () => {
  beforeEach(() => {
    api.pollLauncherTasks.mockResolvedValue({
      tasks: [],
      cancelledAttachIds: [],
      waitingForSignIn: [],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    useLauncherProjectChoiceStore.setState({ queue: [] });
  });

  it("saves, connects and selects a server when the destination is clear", async () => {
    respondOnce([{ kind: "attach", attachId: "a1", server: SERVER, openProjects: [ACME] }]);
    const { props } = setup();

    await waitFor(() =>
      expect(api.reportLauncherAttach).toHaveBeenCalledWith("a1", {
        tabId: expect.any(String),
        outcome: "connected",
        decision: decision(true),
      }),
    );
    expect(props().saveAndConnect).toHaveBeenCalledWith(
      expect.objectContaining({ name: "billing-mcp", type: "http", url: SERVER.url }),
    );
    expect(props().selectServer).toHaveBeenCalledWith("billing-mcp");
    expect(toasts.toast.success).toHaveBeenCalledWith("billing-mcp connected", {
      description:
        "Added to Acme Tools by your dev command. Stopping the dev command removes it.",
    });
  });

  it("connects a server the project already had, without saving it again", async () => {
    respondOnce([{ kind: "attach", attachId: "a1", server: SERVER, openProjects: [ACME] }]);
    const { props } = setup({
      servers: { [SERVER.name]: serverEntry(SERVER.name, SERVER.url, "disconnected") },
    });

    await waitFor(() => expect(api.reportLauncherAttach).toHaveBeenCalled());
    expect(props().saveAndConnect).not.toHaveBeenCalled();
    expect(props().connectSaved).toHaveBeenCalledWith("billing-mcp");
    expect(api.reportLauncherAttach).toHaveBeenCalledWith("a1", {
      tabId: expect.any(String),
      outcome: "connected",
      decision: decision(false),
    });
  });

  it("does nothing when another tab claimed the request first", async () => {
    api.claimLauncherAttach.mockResolvedValueOnce(false);
    respondOnce([{ kind: "attach", attachId: "a1", server: SERVER, openProjects: [ACME] }]);
    const { props } = setup();

    await waitFor(() => expect(api.claimLauncherAttach).toHaveBeenCalled());
    expect(props().saveAndConnect).not.toHaveBeenCalled();
    expect(api.reportLauncherAttach).not.toHaveBeenCalled();
  });

  it("asks which project when tabs differ, and hands it to the tab the developer picked", async () => {
    respondOnce([
      { kind: "attach", attachId: "a1", server: SERVER, openProjects: [ACME, BILLING] },
    ]);
    const { props } = setup();

    await waitFor(() =>
      expect(useLauncherProjectChoiceStore.getState().queue).toHaveLength(1),
    );
    expect(useLauncherProjectChoiceStore.getState().queue[0]).toMatchObject({
      serverName: "billing-mcp",
      defaultProjectId: ACME.id,
    });
    act(() => useLauncherProjectChoiceStore.getState().settle(BILLING.id));

    await waitFor(() =>
      expect(api.routeLauncherAttach).toHaveBeenCalledWith(
        "a1",
        expect.any(String),
        BILLING.id,
      ),
    );
    expect(props().saveAndConnect).not.toHaveBeenCalled();
  });

  it("saves nothing when the developer cancels the project choice", async () => {
    respondOnce([
      { kind: "attach", attachId: "a1", server: SERVER, openProjects: [ACME, BILLING] },
    ]);
    const { props } = setup();

    await waitFor(() =>
      expect(useLauncherProjectChoiceStore.getState().queue).toHaveLength(1),
    );
    act(() => useLauncherProjectChoiceStore.getState().settle(null));

    await waitFor(() =>
      expect(toasts.toast).toHaveBeenCalledWith(
        "billing-mcp was not added",
        expect.objectContaining({
          action: expect.objectContaining({ label: "Choose project" }),
        }),
      ),
    );
    expect(props().saveAndConnect).not.toHaveBeenCalled();
    expect(api.reportLauncherAttach).not.toHaveBeenCalled();
  });

  it("removes a server the dev command added when it quits, and offers to keep it", async () => {
    respondOnce([
      { kind: "release", attachId: "a1", server: SERVER, decision: decision(true) },
    ]);
    const { props } = setup({
      servers: { [SERVER.name]: serverEntry(SERVER.name, SERVER.url, "connected") },
      selectedServer: SERVER.name,
    });

    await waitFor(() =>
      expect(api.reportLauncherReleased).toHaveBeenCalledWith("a1", expect.any(String)),
    );
    expect(props().removeServer).toHaveBeenCalledWith("billing-mcp");
    expect(props().disconnectServer).not.toHaveBeenCalled();
    const [title, options] = toasts.toast.mock.calls[0];
    expect(title).toBe("billing-mcp removed from Acme Tools");
    expect(options.action.label).toBe("Keep server");
    options.action.onClick();
    expect(props().saveWithoutConnecting).toHaveBeenCalledWith(
      expect.objectContaining({ name: "billing-mcp", url: SERVER.url }),
    );
  });

  it("only disconnects a server the project had saved before", async () => {
    respondOnce([
      { kind: "release", attachId: "a1", server: SERVER, decision: decision(false) },
    ]);
    const { props } = setup();

    await waitFor(() => expect(api.reportLauncherReleased).toHaveBeenCalled());
    expect(props().disconnectServer).toHaveBeenCalledWith("billing-mcp");
    expect(props().removeServer).not.toHaveBeenCalled();
  });

  it("asks a signed-out tab to sign in and saves nothing", async () => {
    respondOnce([], {
      waitingForSignIn: [{ attachId: "a1", serverName: "billing-mcp" }],
    });
    const { props } = setup({ signedIn: false, project: null });

    await waitFor(() =>
      expect(toasts.toast.info).toHaveBeenCalledWith(
        "Sign in to add billing-mcp",
        expect.objectContaining({
          action: expect.objectContaining({ label: "Sign in" }),
        }),
      ),
    );
    expect(api.pollLauncherTasks).toHaveBeenCalledWith(expect.any(String), {
      focusedAt: expect.any(Number),
      signedIn: false,
      project: null,
    });
    toasts.toast.info.mock.calls[0][1].action.onClick();
    expect(props().requestSignIn).toHaveBeenCalled();
    expect(props().saveAndConnect).not.toHaveBeenCalled();
  });

  it("does not poll in hosted mode", async () => {
    setup({ enabled: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.pollLauncherTasks).not.toHaveBeenCalled();
  });

  it("tells the local server when the tab goes away", () => {
    const { hook } = setup();
    hook.unmount();
    expect(api.closeLauncherTab).toHaveBeenCalled();
  });
});

describe("launcherServerToFormData", () => {
  it("builds a stdio server that goes through the normal command approval", () => {
    expect(
      launcherServerToFormData({
        name: "local",
        command: "node",
        args: ["server.js"],
        env: { API_KEY: "x" },
      }),
    ).toEqual({
      name: "local",
      type: "stdio",
      command: "node",
      args: ["server.js"],
      env: { API_KEY: "x" },
      secretPatch: { env: { API_KEY: "x" } },
      useOAuth: false,
    });
  });
});

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LauncherAttachResult,
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
  reportLauncherAttach: vi.fn(async (..._args: unknown[]) => true),
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
const EMPTY: LauncherPollResponse = {
  tasks: [],
  cancelledAttachIds: [],
  waitingForSignIn: [],
};

function serverEntry(
  name: string,
  url: string,
  connectionStatus: ServerWithName["connectionStatus"],
  lastError?: string,
): ServerWithName {
  return {
    name,
    config: { url } as ServerWithName["config"],
    connectionStatus,
    lastConnectionTime: new Date(0),
    retryCount: 0,
    ...(lastError ? { lastError } : {}),
  };
}

const attachTask = (
  openProjects = [ACME],
  extra: Partial<LauncherTask> = {},
): LauncherTask =>
  ({
    kind: "attach",
    attachId: "a1",
    server: SERVER,
    openProjects,
    ...extra,
  }) as LauncherTask;

function respondOnce(tasks: LauncherTask[], extra: Partial<LauncherPollResponse> = {}) {
  api.pollLauncherTasks.mockResolvedValueOnce({ ...EMPTY, tasks, ...extra });
}

const outcomes = () =>
  api.reportLauncherAttach.mock.calls.map(
    (call) => (call[1] as LauncherAttachResult).outcome,
  );

function setup(overrides: Partial<UseLauncherAttachOptions> = {}) {
  let props: UseLauncherAttachOptions;
  const hook = renderHook((p: UseLauncherAttachOptions) => useLauncherAttach(p), {
    initialProps: (props = {
      enabled: true,
      signedIn: true,
      project: ACME,
      servers: { other: serverEntry("other", "http://127.0.0.1:1/mcp", "connected") },
      selectedServer: "other",
      pollIntervalMs: 20,
      saveAndConnect: vi.fn(async (formData, onSaved) => {
        onSaved();
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
  return {
    hook,
    props: () => props,
    update: (next: Partial<UseLauncherAttachOptions>) => {
      props = { ...props, ...next };
      hook.rerender(props);
    },
  };
}

const decision = (createdByAttach: boolean, project = ACME): LauncherDecision => ({
  projectId: project.id,
  projectName: project.name,
  serverName: SERVER.name,
  createdByAttach,
});

describe("useLauncherAttach", () => {
  beforeEach(() => {
    api.pollLauncherTasks.mockResolvedValue(EMPTY);
  });

  afterEach(() => {
    vi.clearAllMocks();
    api.reportLauncherAttach.mockImplementation(async () => true);
    useLauncherProjectChoiceStore.setState({ queue: [] });
  });

  it("saves, connects and selects a server when the destination is clear", async () => {
    respondOnce([attachTask()]);
    const { props } = setup();

    await waitFor(() => expect(outcomes()).toEqual(["saved", "connected"]));
    expect(api.reportLauncherAttach).toHaveBeenLastCalledWith("a1", {
      tabId: expect.any(String),
      outcome: "connected",
      decision: decision(true),
    });
    expect(props().saveAndConnect).toHaveBeenCalledWith(
      expect.objectContaining({ name: "billing-mcp", type: "http", url: SERVER.url }),
      expect.any(Function),
    );
    expect(props().selectServer).toHaveBeenCalledWith("billing-mcp");
    expect(toasts.toast.success).toHaveBeenCalledWith("billing-mcp connected", {
      description:
        "Added to Acme Tools by your dev command. Stopping the dev command removes it.",
    });
  });

  it("reports the save before the connect finishes, so a quit mid-connect still finds the entry", async () => {
    respondOnce([attachTask()]);
    // A connect that never settles, such as one waiting on stdio approval.
    setup({
      saveAndConnect: vi.fn(async (_formData, onSaved) => {
        onSaved();
        await new Promise<void>(() => {});
      }),
    });

    await waitFor(() => expect(outcomes()).toEqual(["saved"]));
  });

  it("connects a server the project already had, without saving it again", async () => {
    respondOnce([attachTask()]);
    const { props } = setup({
      servers: { [SERVER.name]: serverEntry(SERVER.name, SERVER.url, "disconnected") },
    });

    await waitFor(() => expect(outcomes()).toEqual(["connected"]));
    expect(props().saveAndConnect).not.toHaveBeenCalled();
    expect(props().connectSaved).toHaveBeenCalledWith("billing-mcp");
    expect(api.reportLauncherAttach).toHaveBeenCalledWith("a1", {
      tabId: expect.any(String),
      outcome: "connected",
      decision: decision(false),
    });
  });

  it("does nothing until the project and its saved servers have loaded", async () => {
    respondOnce([attachTask()]);
    const { props } = setup({ project: null });

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(api.claimLauncherAttach).not.toHaveBeenCalled();
    expect(props().saveAndConnect).not.toHaveBeenCalled();
    // Not eligible for a request, and not asking a signed-in developer to sign in.
    expect(api.pollLauncherTasks).toHaveBeenCalledWith(expect.any(String), {
      focusedAt: expect.any(Number),
      signedIn: false,
      project: null,
    });
    expect(toasts.toast.info).not.toHaveBeenCalled();
  });

  it("does nothing when another tab claimed the request first", async () => {
    api.claimLauncherAttach.mockResolvedValueOnce(false);
    respondOnce([attachTask()]);
    const { props } = setup();

    await waitFor(() => expect(api.claimLauncherAttach).toHaveBeenCalled());
    expect(props().saveAndConnect).not.toHaveBeenCalled();
    expect(api.reportLauncherAttach).not.toHaveBeenCalled();
  });

  it("refuses a different server with the same name, saving nothing", async () => {
    respondOnce([attachTask()]);
    const { props } = setup({
      servers: { [SERVER.name]: serverEntry(SERVER.name, "http://127.0.0.1:9999/mcp", "connected") },
    });

    await waitFor(() => expect(outcomes()).toEqual(["failed"]));
    expect(toasts.toast.error).toHaveBeenCalledWith(
      "billing-mcp is already saved in Acme Tools with a different URL. Rename one of them, then restart your dev command.",
    );
    expect(props().saveAndConnect).not.toHaveBeenCalled();
    expect(props().connectSaved).not.toHaveBeenCalled();
  });

  it("reports a failed connect with the decision when the entry was saved", async () => {
    respondOnce([attachTask()]);
    let tab!: ReturnType<typeof setup>;
    tab = setup({
      saveAndConnect: vi.fn(async (formData, onSaved) => {
        onSaved();
        // The entry exists, and its connect failed.
        tab.update({
          servers: {
            ...tab.props().servers,
            [formData.name]: serverEntry(formData.name, formData.url!, "failed", "Connection refused"),
          },
        });
      }),
    });

    await waitFor(() => expect(outcomes()).toEqual(["saved", "failed"]));
    expect(api.reportLauncherAttach).toHaveBeenLastCalledWith("a1", {
      tabId: expect.any(String),
      outcome: "failed",
      message: "Connection refused",
      decision: decision(true),
    });
    expect(toasts.toast.success).not.toHaveBeenCalled();
  });

  it("asks which project when tabs differ, and hands it to the tab the developer picked", async () => {
    respondOnce([attachTask([ACME, BILLING])]);
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
      expect(api.routeLauncherAttach).toHaveBeenCalledWith("a1", expect.any(String), BILLING.id),
    );
    expect(props().saveAndConnect).not.toHaveBeenCalled();
  });

  it("keeps the way back to the project question on screen while the dev command runs", async () => {
    respondOnce([attachTask([ACME, BILLING])]);
    const { props } = setup();

    await waitFor(() =>
      expect(useLauncherProjectChoiceStore.getState().queue).toHaveLength(1),
    );
    act(() => useLauncherProjectChoiceStore.getState().settle(null));

    await waitFor(() =>
      expect(toasts.toast).toHaveBeenCalledWith(
        "billing-mcp was not added",
        expect.objectContaining({
          id: "launcher-choose-a1",
          duration: Infinity,
          action: expect.objectContaining({ label: "Choose project" }),
        }),
      ),
    );
    expect(props().saveAndConnect).not.toHaveBeenCalled();
    expect(api.reportLauncherAttach).not.toHaveBeenCalled();
  });

  it("asks again for the project the tab shows now, not the one it showed at first", async () => {
    respondOnce([attachTask([ACME, BILLING])]);
    const { update } = setup();

    await waitFor(() =>
      expect(useLauncherProjectChoiceStore.getState().queue).toHaveLength(1),
    );
    act(() => useLauncherProjectChoiceStore.getState().settle(null));
    await waitFor(() => expect(toasts.toast).toHaveBeenCalled());
    const action = (toasts.toast.mock.calls[0][1] as { action: { onClick: () => void } }).action;

    // The developer switches the tab to Billing, then asks again.
    update({ project: BILLING });
    action.onClick();

    await waitFor(() =>
      expect(useLauncherProjectChoiceStore.getState().queue).toHaveLength(1),
    );
    expect(useLauncherProjectChoiceStore.getState().queue[0].defaultProjectId).toBe(BILLING.id);
    expect(toasts.toast.dismiss).toHaveBeenCalledWith("launcher-choose-a1");
  });

  it("routes a choice back to the project it names when the tab has since moved", async () => {
    respondOnce([attachTask([ACME, BILLING])]);
    const { props, update } = setup();

    await waitFor(() =>
      expect(useLauncherProjectChoiceStore.getState().queue).toHaveLength(1),
    );
    update({ project: BILLING });
    act(() => useLauncherProjectChoiceStore.getState().settle(ACME.id));

    await waitFor(() =>
      expect(api.routeLauncherAttach).toHaveBeenCalledWith("a1", expect.any(String), ACME.id),
    );
    expect(props().saveAndConnect).not.toHaveBeenCalled();
  });

  it("treats a quit while the question is open as a withdrawal, not a Cancel", async () => {
    respondOnce([attachTask([ACME, BILLING])]);
    setup();
    await waitFor(() =>
      expect(useLauncherProjectChoiceStore.getState().queue).toHaveLength(1),
    );

    // The local server withdraws the request: the dev command quit.
    api.pollLauncherTasks.mockResolvedValueOnce({ ...EMPTY, cancelledAttachIds: ["a1"] });
    await waitFor(() =>
      expect(useLauncherProjectChoiceStore.getState().queue).toHaveLength(0),
    );

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(toasts.toast).not.toHaveBeenCalledWith(
      "billing-mcp was not added",
      expect.anything(),
    );
    expect(api.reportLauncherAttach).not.toHaveBeenCalled();
  });

  it("removes an entry it created when MCPJam refuses the final report", async () => {
    api.reportLauncherAttach.mockImplementation(async (...args: unknown[]) => {
      return (args[1] as LauncherAttachResult).outcome === "saved";
    });
    respondOnce([attachTask()]);
    const { props } = setup();

    await waitFor(() => expect(props().removeServer).toHaveBeenCalledWith("billing-mcp"));
    expect(toasts.toast).toHaveBeenCalledWith(
      "billing-mcp removed from Acme Tools",
      expect.anything(),
    );
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
    options.action.onClick();
    expect(props().saveWithoutConnecting).toHaveBeenCalledWith(
      expect.objectContaining({ name: "billing-mcp", url: SERVER.url }),
    );
  });

  it("restores the selection from before the attach when its server is removed", async () => {
    respondOnce([attachTask()]);
    const { props, update } = setup();
    await waitFor(() => expect(outcomes()).toEqual(["saved", "connected"]));

    // The developer is looking at the attached server when the dev command quits.
    update({ selectedServer: SERVER.name });
    respondOnce([
      { kind: "release", attachId: "a1", server: SERVER, decision: decision(true) },
    ]);

    await waitFor(() => expect(props().removeServer).toHaveBeenCalledWith("billing-mcp"));
    await waitFor(() => expect(props().selectServer).toHaveBeenLastCalledWith("other"));
  });

  it("only disconnects a server the project had saved before", async () => {
    respondOnce([
      { kind: "release", attachId: "a1", server: SERVER, decision: decision(false) },
    ]);
    const { props } = setup({
      servers: { [SERVER.name]: serverEntry(SERVER.name, SERVER.url, "connected") },
    });

    await waitFor(() => expect(api.reportLauncherReleased).toHaveBeenCalled());
    expect(props().disconnectServer).toHaveBeenCalledWith("billing-mcp");
    expect(props().removeServer).not.toHaveBeenCalled();
  });

  it("leaves a server alone that the developer removed while the dev command ran", async () => {
    respondOnce([
      { kind: "release", attachId: "a1", server: SERVER, decision: decision(true) },
    ]);
    const { props } = setup();

    await waitFor(() => expect(api.reportLauncherReleased).toHaveBeenCalled());
    expect(props().removeServer).not.toHaveBeenCalled();
    expect(toasts.toast).not.toHaveBeenCalled();
  });

  it("leaves a server alone that the developer edited while the dev command ran", async () => {
    respondOnce([
      { kind: "release", attachId: "a1", server: SERVER, decision: decision(true) },
    ]);
    const { props } = setup({
      servers: {
        [SERVER.name]: serverEntry(SERVER.name, "http://127.0.0.1:5555/mcp", "connected"),
      },
    });

    await waitFor(() => expect(api.reportLauncherReleased).toHaveBeenCalled());
    expect(props().removeServer).not.toHaveBeenCalled();
    expect(props().disconnectServer).not.toHaveBeenCalled();
  });

  it("does not acknowledge a release for a project this tab is not showing", async () => {
    respondOnce([
      {
        kind: "release",
        attachId: "a1",
        server: SERVER,
        decision: decision(true, BILLING),
      },
    ]);
    const { props } = setup();

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(props().removeServer).not.toHaveBeenCalled();
    expect(api.reportLauncherReleased).not.toHaveBeenCalled();
  });

  it("asks a signed-out tab to sign in once, however many polls it sees", async () => {
    const waiting = { ...EMPTY, waitingForSignIn: [{ attachId: "a1", serverName: "billing-mcp" }] };
    api.pollLauncherTasks.mockResolvedValue(waiting);
    const { props } = setup({ signedIn: false, project: null });

    await waitFor(() => expect(api.pollLauncherTasks.mock.calls.length).toBeGreaterThan(3));
    expect(toasts.toast.info).toHaveBeenCalledTimes(1);
    expect(toasts.toast.info).toHaveBeenCalledWith(
      "Sign in to add billing-mcp",
      expect.objectContaining({
        id: "launcher-sign-in-a1",
        action: expect.objectContaining({ label: "Sign in" }),
      }),
    );
    const action = (toasts.toast.info.mock.calls[0][1] as { action: { onClick: () => void } }).action;
    action.onClick();
    expect(props().requestSignIn).toHaveBeenCalled();
    expect(props().saveAndConnect).not.toHaveBeenCalled();
  });

  it("takes the sign-in toast down once nothing is waiting for it", async () => {
    api.pollLauncherTasks.mockResolvedValueOnce({
      ...EMPTY,
      waitingForSignIn: [{ attachId: "a1", serverName: "billing-mcp" }],
    });
    setup({ signedIn: false, project: null });
    await waitFor(() => expect(toasts.toast.info).toHaveBeenCalled());

    // The dev command quit, or another tab took the request.
    await waitFor(() =>
      expect(toasts.toast.dismiss).toHaveBeenCalledWith("launcher-sign-in-a1"),
    );
  });

  it("never asks a signed-in tab to sign in, even while it loads its project", async () => {
    api.pollLauncherTasks.mockResolvedValue({
      ...EMPTY,
      waitingForSignIn: [{ attachId: "a1", serverName: "billing-mcp" }],
    });
    setup({ signedIn: true, project: null });

    await waitFor(() => expect(api.pollLauncherTasks.mock.calls.length).toBeGreaterThan(2));
    expect(toasts.toast.info).not.toHaveBeenCalled();
  });

  it("does not poll in hosted mode", async () => {
    setup({ enabled: false });
    await new Promise((resolve) => setTimeout(resolve, 60));
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

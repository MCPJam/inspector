import { StrictMode, createContext, useContext, useState } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResourcesTab } from "@/components/ResourcesTab";
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes-guard";
import { ResourceChatHandoff } from "../resource-chat-handoff";
import { createThreadAppApi } from "../thread-app-api";

const projectId = "k57aaaaaaaaaaaaaaaaaaaaaaaaa";
const scope = {
  actorId: "actor",
  projectId,
  hostId: "host",
  serverId: "saved-server",
};
const uri = "fixture-file://private/triangle.stl";
const viewer = {
  kind: "file" as const,
  toolName: "cad.open",
  title: "CAD Viewer",
  resourceUri: uri,
};
const { readResource } = vi.hoisted(() => ({ readResource: vi.fn() }));
vi.mock("@/lib/apis/mcp-resources-api", () => ({
  listResources: async () => ({
    resources: [
      { uri: "fixture-file://private/triangle.stl", name: "triangle.stl" },
    ],
  }),
  readResource,
}));
vi.mock("@/lib/apis/mcp-resource-templates-api", () => ({
  listResourceTemplates: async () => [],
}));
vi.mock("@/components/ui/json-editor", () => ({ JsonEditor: () => null }));
vi.mock("@/components/logger-view", () => ({ LoggerView: () => null }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  readResource.mockClear();
});

function fixture(
  options: { viewers?: (typeof viewer)[]; draft?: boolean } = {},
) {
  const api = createThreadAppApi({
    projectId,
    hostId: "host",
    threadId: "chat",
    pluginWorkspace: { version: 1, workspaceId: "workspace" },
  });
  const discover = vi
    .spyOn(api, "discoverFile")
    .mockResolvedValue(options.viewers ?? [viewer]);
  const open = vi.fn(async () => {});
  const initial = {
    identity: scope,
    enabled: true,
    serverIds: [scope.serverId],
    ready: true,
    ownerAvailable: true,
    compareActive: false,
    api,
  };
  const Settings = createContext(initial);
  const sourcePath = `/p/${projectId}/resources`;
  const destinationPath = `/p/${projectId}/playground`;
  function Source() {
    const [dirty, setDirty] = useState(options.draft ?? false);
    useUnsavedChangesGuard(dirty, () => setDirty(false));
    return (
      <ResourcesTab
        serverName="local-alias"
        serverConfig={{ transportType: "stdio", command: "node", args: [] }}
        serverConnectionStatus="connected"
        openInChatScope={scope}
      />
    );
  }
  function Destination() {
    const current = useContext(Settings);
    return (
      <ResourceChatHandoff
        identity={current.identity}
        ready={current.ready}
        compareActive={current.compareActive}
        fileActions={
          current.ownerAvailable
            ? {
                api: current.api,
                open,
                serverIds: current.serverIds,
                enabled: current.enabled,
                workspaceId: "workspace",
              }
            : null
        }
      />
    );
  }
  const router = createMemoryRouter(
    [
      { path: sourcePath, element: <Source /> },
      { path: destinationPath, element: <Destination /> },
    ],
    { initialEntries: [sourcePath] },
  );
  const navigations: { pathname: string; state: unknown }[] = [];
  router.subscribe((state) =>
    navigations.push({
      pathname: state.location.pathname,
      state: state.location.state,
    }),
  );
  const view = render(
    <StrictMode>
      <Settings.Provider value={initial}>
        <RouterProvider router={router} />
      </Settings.Provider>
    </StrictMode>,
  );
  const update = (next: Partial<typeof initial>) =>
    view.rerender(
      <StrictMode>
        <Settings.Provider value={{ ...initial, ...next }}>
          <RouterProvider router={router} />
        </Settings.Provider>
      </StrictMode>,
    );
  return {
    api,
    discover,
    open,
    router,
    navigations,
    update,
    initial,
    sourcePath,
    destinationPath,
  };
}

async function go() {
  await userEvent.click(
    await screen.findByRole("button", { name: "Open in chat" }),
  );
}

describe("Resources to the current chat", () => {
  it("consumes private router state, then discovers and opens through the chat owner once", async () => {
    const f = fixture();
    f.discover.mockImplementation(async () => {
      expect(f.router.state.location.state).toEqual({});
      return [viewer];
    });
    await go();
    await waitFor(() => expect(f.open).toHaveBeenCalledTimes(1));
    expect(f.discover).toHaveBeenCalledWith(
      scope.serverId,
      uri,
      expect.any(AbortSignal),
    );
    expect(f.open).toHaveBeenCalledWith(scope.serverId, viewer);
    expect(readResource).not.toHaveBeenCalled();
    const request = f.navigations.find(
      (item) =>
        item.state &&
        typeof item.state === "object" &&
        "pluginResourceFile" in item.state,
    );
    expect(request?.pathname).toBe(f.destinationPath);
    expect(request?.state).toMatchObject({
      pluginResourceFile: { ...scope, resourceUri: uri },
    });
    expect(f.router.state.location.search).toBe("");
    expect(f.router.state.location.state).toEqual({});
    await act(async () => {
      await f.router.navigate(-1);
      await f.router.navigate(1);
    });
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.discover).toHaveBeenCalledTimes(1);
  });

  it("refuses a copied consumed intent without replaying discovery", async () => {
    const f = fixture();
    await go();
    await waitFor(() => expect(f.open).toHaveBeenCalledOnce());
    const copied = f.navigations.find(
      (item) =>
        item.state &&
        typeof item.state === "object" &&
        "pluginResourceFile" in item.state,
    )?.state;
    await act(async () => {
      await f.router.navigate(f.destinationPath, { state: copied });
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This file request is no longer available",
    );
    expect(f.discover).toHaveBeenCalledOnce();
    expect(f.open).toHaveBeenCalledOnce();
  });

  it("waits for the normal chat owner without retaining the intent in history", async () => {
    const f = fixture();
    f.update({ ready: false });
    await go();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Preparing the file viewer",
    );
    expect(f.router.state.location.state).toEqual({});
    expect(f.discover).not.toHaveBeenCalled();
    f.update({ ready: true });
    await waitFor(() => expect(f.open).toHaveBeenCalledOnce());
  });

  it("never repeats the automatic open after temporary chat readiness changes", async () => {
    const f = fixture();
    await go();
    await waitFor(() => expect(f.open).toHaveBeenCalledOnce());
    f.update({ ready: false });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Preparing the file viewer",
    );
    f.update({ ready: true });
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(f.discover).toHaveBeenCalledOnce();
    expect(f.open).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "expired", extra: { createdAt: 0 } },
    { label: "oversized", extra: { resourceUri: "x".repeat(4097) } },
  ])("rejects $label router state before discovery", async ({ extra }) => {
    const f = fixture();
    await act(async () => {
      await f.router.navigate(f.destinationPath, {
        state: {
          pluginResourceFile: {
            ...scope,
            resourceUri: uri,
            nonce: crypto.randomUUID(),
            createdAt: Date.now(),
            ...extra,
          },
        },
      });
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This file request is no longer available",
    );
    expect(f.discover).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
    expect(f.router.state.location.state).toEqual({});
  });

  it("consumes a Compare handoff without retrying when a single chat later appears", async () => {
    const f = fixture();
    f.update({ compareActive: true });
    await go();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Switch to a single chat",
    );
    expect(f.router.state.location.state).toEqual({});
    f.update({ compareActive: false });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Switch to a single chat",
    );
    expect(f.discover).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
  });

  it("refuses loss of an already bound owner without restarting after recovery", async () => {
    const f = fixture();
    await go();
    await waitFor(() => expect(f.open).toHaveBeenCalledOnce());
    f.update({ ownerAvailable: false });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This chat cannot open that file",
    );
    f.update({ ownerAvailable: true });
    expect(f.open).toHaveBeenCalledOnce();
    expect(f.discover).toHaveBeenCalledOnce();
  });

  it("bounds a matching identity's initial missing owner wait", async () => {
    vi.useFakeTimers();
    const router = createMemoryRouter(
      [
        {
          path: "/playground",
          element: (
            <ResourceChatHandoff identity={scope} ready fileActions={null} />
          ),
        },
      ],
      {
        initialEntries: [
          {
            pathname: "/playground",
            state: {
              pluginResourceFile: {
                ...scope,
                resourceUri: uri,
                nonce: crypto.randomUUID(),
                createdAt: Date.now(),
              },
            },
          },
        ],
      },
    );
    render(<RouterProvider router={router} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Preparing the file viewer",
    );
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The chat is not ready",
    );
    expect(router.state.location.state).toEqual({});
  });

  it("uses the normal two-viewer chooser without opening before selection", async () => {
    const alternate = {
      ...viewer,
      title: "Mesh Viewer",
      toolName: "mesh.open",
    };
    const f = fixture({ viewers: [viewer, alternate] });
    await go();
    expect(
      await screen.findByRole("menuitem", { name: "Mesh Viewer" }),
    ).toBeVisible();
    expect(f.open).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Mesh Viewer" }),
    );
    expect(f.open).toHaveBeenCalledWith(scope.serverId, alternate);
  });

  it("reports no handler without opening or reading the resource", async () => {
    const f = fixture({ viewers: [] });
    await go();
    expect(
      await screen.findByRole("menuitem", {
        name: "No viewer can open this file",
      }),
    ).toBeVisible();
    expect(f.open).not.toHaveBeenCalled();
    expect(readResource).not.toHaveBeenCalled();
  });

  it.each(["actorId", "projectId", "hostId"] as const)(
    "rejects a foreign %s",
    async (field) => {
      const f = fixture();
      f.update({ identity: { ...scope, [field]: "foreign" } });
      await go();
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "This chat cannot open that file",
      );
      expect(f.discover).not.toHaveBeenCalled();
      expect(f.open).not.toHaveBeenCalled();
      expect(f.router.state.location.state).toEqual({});
    },
  );

  it("withholds opening when access disappears during discovery", async () => {
    const f = fixture();
    let resolve!: (value: (typeof viewer)[]) => void;
    f.discover.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await go();
    await waitFor(() => expect(f.discover).toHaveBeenCalledOnce());
    f.update({ enabled: false });
    await act(async () => resolve([viewer]));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This chat cannot open that file",
    );
    expect(f.open).not.toHaveBeenCalled();
  });

  it("does not transfer an accepted intent to a replacement chat owner", async () => {
    const f = fixture({
      viewers: [
        viewer,
        { ...viewer, toolName: "mesh.open", title: "Mesh Viewer" },
      ],
    });
    await go();
    await screen.findByRole("menuitem", { name: "Mesh Viewer" });
    const replacement = createThreadAppApi({
      projectId,
      hostId: "host",
      threadId: "other-chat",
      pluginWorkspace: { version: 1, workspaceId: "other" },
    });
    f.update({ api: replacement });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This chat cannot open that file",
    );
    expect(f.open).not.toHaveBeenCalled();
  });

  it("keeps the normal unsaved-draft navigation confirmation", async () => {
    const f = fixture({ draft: true });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await go();
    expect(confirm).toHaveBeenCalledOnce();
    expect(f.router.state.location.pathname).toBe(f.sourcePath);
    expect(f.discover).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await go();
    await waitFor(() => expect(f.open).toHaveBeenCalledOnce());
  });
});

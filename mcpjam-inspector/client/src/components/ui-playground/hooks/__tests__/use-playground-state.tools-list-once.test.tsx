import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { PreferencesStoreProvider } from "@/stores/preferences/preferences-provider";
import type { ServerWithName } from "@/state/app-types";

/**
 * PLB-118: opening the Playground on a hosted project asked for the server's
 * tool list twice. The list refetched on every API context revision while it
 * was still empty, and a revision that changes nothing the request carries
 * (the connect flow re-injecting a server mapping it already had, a new
 * access-token getter) landed while the first request was in flight. The
 * second request cleared the list the first one was about to show, so the
 * tools appeared about a second late and the MCP server was asked twice.
 *
 * Driven through the real hook and the real hosted API modules; only the
 * network is stubbed, and each `tools/list` answer is released by the test.
 */

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }));

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: () => undefined,
  useAction: () => vi.fn(),
  useConvex: () => ({}),
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: false }),
}));

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  HOSTED_MODE: true,
}));

vi.mock("@/lib/session-token", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/session-token")>()),
  authFetch: (...args: unknown[]) => mocks.authFetch(...args),
}));

import { usePlaygroundState } from "../use-playground-state";
import {
  injectHostedServerMapping,
  setApiContext,
} from "@/lib/apis/web/context";

const SERVER = "excalidraw";
const UNMAPPED = "not-synced-yet";

function server(
  name: string,
  connectionStatus: ServerWithName["connectionStatus"] = "connected",
): ServerWithName {
  return {
    name,
    config: {
      transportType: "http",
      url: "https://example.com/mcp",
    } as ServerWithName["config"],
    lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
    connectionStatus,
    retryCount: 0,
    enabled: true,
  };
}

// One object per status: the hook keys effects on `servers`, so a fresh object
// on every render would never let it settle.
const SERVERS = {
  connected: {
    [SERVER]: server(SERVER),
    [UNMAPPED]: server(UNMAPPED),
  },
  disconnected: {
    [SERVER]: server(SERVER, "disconnected"),
    [UNMAPPED]: server(UNMAPPED, "disconnected"),
  },
} satisfies Record<string, Record<string, ServerWithName>>;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <PreferencesStoreProvider themeMode="light" themePreset="default">
      <SidebarProvider>{children}</SidebarProvider>
    </PreferencesStoreProvider>
  );
}

const BASE_CONTEXT = {
  projectId: "project-1",
  serverIdsByName: { [SERVER]: "srv-1" },
};

describe("usePlaygroundState — one tools/list per request it would send", () => {
  /** The serverId of every `tools/list` request, in order. */
  let listed: string[];
  /**
   * Releases the `tools/list` requests in the order they were sent: a tool
   * name answers with that one tool, an `Error` with a refusal.
   */
  let answers: Array<(outcome: string | Error) => void>;

  beforeEach(() => {
    listed = [];
    answers = [];
    setApiContext(BASE_CONTEXT);
    mocks.authFetch.mockImplementation(
      async (path: string, init?: RequestInit) => {
        if (path !== "/api/web/tools/list") {
          return new Response("{}", { status: 404 });
        }
        const body = JSON.parse(String(init?.body ?? "{}"));
        listed.push(body.serverId);
        const outcome = await new Promise<string | Error>((resolve) =>
          answers.push(resolve),
        );
        if (outcome instanceof Error) {
          return new Response(
            JSON.stringify({
              code: "VALIDATION_ERROR",
              message: outcome.message,
            }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
        return jsonResponse({
          tools: [
            { name: outcome, inputSchema: { type: "object", properties: {} } },
          ],
        });
      },
    );
  });

  afterEach(() => {
    mocks.authFetch.mockReset();
    setApiContext(null);
  });

  function renderPlayground(
    initial: {
      serverName?: string;
      status?: keyof typeof SERVERS;
    } = {},
  ) {
    return renderHook(
      ({
        serverName,
        status,
      }: {
        serverName: string;
        status: keyof typeof SERVERS;
      }) => {
        const servers = SERVERS[status];
        return usePlaygroundState({
          servers,
          serverName,
          serverConfig: servers[serverName].config,
        });
      },
      {
        wrapper,
        initialProps: {
          serverName: initial.serverName ?? SERVER,
          status: initial.status ?? "connected",
        },
      },
    );
  }

  it("does not ask again when a context change leaves the request as it was", async () => {
    const { result } = renderPlayground();
    await waitFor(() => expect(listed).toHaveLength(1));

    // While the first request is in flight: the connect flow re-injects the
    // mapping it already had, and the context gets a new token getter.
    act(() => {
      injectHostedServerMapping(SERVER, "srv-1");
      setApiContext({ ...BASE_CONTEXT, getAccessToken: async () => "t" });
    });

    await act(async () => answers[0]("draw"));
    await waitFor(() =>
      expect(Object.keys(result.current.tools)).toEqual(["draw"]),
    );
    expect(listed).toEqual(["srv-1"]);
  });

  it("asks again when the request changes, and keeps only the newer answer", async () => {
    const { result } = renderPlayground();
    await waitFor(() => expect(listed).toHaveLength(1));

    // The server's id really changed while the first request was in flight.
    act(() => {
      setApiContext({
        ...BASE_CONTEXT,
        serverIdsByName: { [SERVER]: "srv-2" },
      });
    });
    await waitFor(() => expect(listed).toEqual(["srv-1", "srv-2"]));

    await act(async () => answers[1]("fresh"));
    await waitFor(() =>
      expect(Object.keys(result.current.tools)).toEqual(["fresh"]),
    );
    // The stale answer arriving last does not overwrite it.
    await act(async () => answers[0]("stale"));
    expect(Object.keys(result.current.tools)).toEqual(["fresh"]);
    expect(result.current.fetchingTools).toBe(false);
  });

  it("waits for the context before asking, then asks once", async () => {
    setApiContext({ projectId: null, serverIdsByName: {} });
    renderPlayground();
    await act(async () => {});
    expect(listed).toEqual([]);

    act(() => setApiContext(BASE_CONTEXT));
    await waitFor(() => expect(listed).toEqual(["srv-1"]));
    // A duplicate sent after the first one would still be caught here.
    await act(async () => answers[0]("draw"));
    expect(listed).toEqual(["srv-1"]);
  });

  it("lists again on the next context revision after a listing fails", async () => {
    const { result } = renderPlayground();
    await waitFor(() => expect(listed).toHaveLength(1));
    await act(async () => answers[0](new Error("token expired")));
    await waitFor(() => expect(result.current.fetchingTools).toBe(false));

    // A new token getter leaves the request as it was, and can fix it.
    act(() => {
      setApiContext({ ...BASE_CONTEXT, getAccessToken: async () => "t" });
    });
    await waitFor(() => expect(listed).toEqual(["srv-1", "srv-1"]));
    await act(async () => answers[1]("draw"));
    await waitFor(() =>
      expect(Object.keys(result.current.tools)).toEqual(["draw"]),
    );
  });

  it("lists again when the server reconnects", async () => {
    const { rerender } = renderPlayground();
    await waitFor(() => expect(listed).toHaveLength(1));
    await act(async () => answers[0]("draw"));

    rerender({ serverName: SERVER, status: "disconnected" });
    rerender({ serverName: SERVER, status: "connected" });

    await waitFor(() => expect(listed).toEqual(["srv-1", "srv-1"]));
  });

  it("drops a listing still in flight when the server disconnects", async () => {
    const { result, rerender } = renderPlayground();
    await waitFor(() => expect(listed).toHaveLength(1));

    rerender({ serverName: SERVER, status: "disconnected" });
    expect(result.current.fetchingTools).toBe(false);

    await act(async () => answers[0]("late"));
    expect(result.current.tools).toEqual({});
  });

  it("asks again when the request returns to one listed before (A, B, A)", async () => {
    const { result } = renderPlayground();
    await waitFor(() => expect(listed).toHaveLength(1));
    await act(async () => answers[0]("a"));

    act(() => {
      setApiContext({
        ...BASE_CONTEXT,
        serverIdsByName: { [SERVER]: "srv-2" },
      });
    });
    await waitFor(() => expect(listed).toEqual(["srv-1", "srv-2"]));
    act(() => setApiContext(BASE_CONTEXT));
    await waitFor(() => expect(listed).toEqual(["srv-1", "srv-2", "srv-1"]));

    // B's answer arrives after the context went back to A: it must not show.
    await act(async () => answers[1]("b"));
    await act(async () => answers[2]("a-again"));
    await waitFor(() =>
      expect(Object.keys(result.current.tools)).toEqual(["a-again"]),
    );
  });

  it("keeps the selected tool when only the request changes", async () => {
    const { result } = renderPlayground();
    await waitFor(() => expect(listed).toHaveLength(1));
    await act(async () => answers[0]("draw"));
    await waitFor(() =>
      expect(Object.keys(result.current.tools)).toEqual(["draw"]),
    );
    act(() => result.current.setSelectedTool("draw"));

    // A host switch changes what the request carries, not the server.
    act(() => {
      setApiContext({
        ...BASE_CONTEXT,
        clientCapabilities: { extensions: { "io.example/ui": {} } },
      });
    });
    await waitFor(() => expect(listed).toEqual(["srv-1", "srv-1"]));
    expect(result.current.selectedTool).toBe("draw");
    expect(Object.keys(result.current.tools)).toEqual(["draw"]);

    await act(async () => answers[1]("draw"));
    expect(result.current.selectedTool).toBe("draw");
  });

  it("clears the previous server's listing when the new one can't be asked yet", async () => {
    const { result, rerender } = renderPlayground();
    await waitFor(() => expect(listed).toHaveLength(1));

    // The new server has no id in the context yet, so its request is null.
    rerender({ serverName: UNMAPPED, status: "connected" });
    expect(result.current.fetchingTools).toBe(false);

    await act(async () => answers[0]("previous-server-tool"));
    expect(result.current.tools).toEqual({});
    expect(listed).toEqual(["srv-1"]);
  });
});

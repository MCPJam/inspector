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

const servers: Record<string, ServerWithName> = {
  [SERVER]: {
    name: SERVER,
    config: {
      transportType: "http",
      url: "https://example.com/mcp",
    } as ServerWithName["config"],
    lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
    connectionStatus: "connected",
    retryCount: 0,
    enabled: true,
  },
};

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
  /** Releases the `tools/list` requests in the order they were sent. */
  let answers: Array<(toolName: string) => void>;

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
        const toolName = await new Promise<string>((resolve) =>
          answers.push(resolve),
        );
        return jsonResponse({
          tools: [
            { name: toolName, inputSchema: { type: "object", properties: {} } },
          ],
        });
      },
    );
  });

  afterEach(() => {
    mocks.authFetch.mockReset();
    setApiContext(null);
  });

  function renderPlayground() {
    return renderHook(
      () =>
        usePlaygroundState({
          servers,
          serverName: SERVER,
          serverConfig: servers[SERVER].config,
        }),
      { wrapper },
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
      setApiContext({ ...BASE_CONTEXT, serverIdsByName: { [SERVER]: "srv-2" } });
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
  });
});

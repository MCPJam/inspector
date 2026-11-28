import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { PreferencesStoreProvider } from "@/stores/preferences/preferences-provider";
import type { ServerWithName } from "@/state/app-types";

/**
 * A `selectTool` command walks `tools/list` pages for its server. When the
 * Playground moves to another server while that walk is in flight, the walk's
 * late answer must not replace the new server's tools.
 *
 * Driven through the real hook and the real hosted API modules; only the
 * network is stubbed.
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
import { setApiContext } from "@/lib/apis/web/context";
import { executeInspectorCommand } from "@/lib/inspector-command-handlers";

const SERVER_A = "server-a";
const SERVER_B = "server-b";

function server(name: string): ServerWithName {
  return {
    name,
    config: {
      transportType: "http",
      url: "https://example.com/mcp",
    } as ServerWithName["config"],
    lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
    connectionStatus: "connected",
    retryCount: 0,
    enabled: true,
  };
}

const SERVERS = {
  [SERVER_A]: server(SERVER_A),
  [SERVER_B]: server(SERVER_B),
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

function tool(name: string) {
  return { name, inputSchema: { type: "object", properties: {} } };
}

describe("usePlaygroundState: a tool walk for a server no longer selected", () => {
  let releasePageTwo: (() => void) | undefined;
  let pageTwoRequested: Promise<void>;

  beforeEach(() => {
    let markPageTwoRequested: () => void = () => {};
    pageTwoRequested = new Promise((resolve) => {
      markPageTwoRequested = resolve;
    });
    setApiContext({
      projectId: "project-1",
      serverIdsByName: { [SERVER_A]: "srv-a", [SERVER_B]: "srv-b" },
    });
    mocks.authFetch.mockImplementation(
      async (path: string, init?: RequestInit) => {
        if (path !== "/api/web/tools/list") {
          return new Response("{}", { status: 404 });
        }
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (body.serverId === "srv-b") {
          return jsonResponse({ tools: [tool("b-tool")] });
        }
        if (body.cursor === "2") {
          await new Promise<void>((resolve) => {
            releasePageTwo = resolve;
            markPageTwoRequested();
          });
          return jsonResponse({ tools: [tool("a-tool-2")] });
        }
        return jsonResponse({ tools: [tool("a-tool-1")], nextCursor: "2" });
      },
    );
  });

  afterEach(() => {
    mocks.authFetch.mockReset();
    setApiContext(null);
  });

  it("keeps the new server's tools when the old walk answers late", async () => {
    const { result, rerender } = renderHook(
      ({ serverName }: { serverName: string }) =>
        usePlaygroundState({
          servers: SERVERS,
          serverName,
          serverConfig: SERVERS[serverName as keyof typeof SERVERS].config,
        }),
      { wrapper, initialProps: { serverName: SERVER_A } },
    );
    await waitFor(() =>
      expect(Object.keys(result.current.tools)).toEqual(["a-tool-1"]),
    );

    const command = executeInspectorCommand({
      id: "command-1",
      type: "selectTool",
      payload: { surface: "playground", toolName: "a-tool-2" },
    });
    await pageTwoRequested;

    rerender({ serverName: SERVER_B });
    await waitFor(() =>
      expect(Object.keys(result.current.tools)).toEqual(["b-tool"]),
    );

    await act(async () => {
      releasePageTwo?.();
      await command;
    });

    expect(Object.keys(result.current.tools)).toEqual(["b-tool"]);
    expect(result.current.fetchingTools).toBe(false);
  });
});

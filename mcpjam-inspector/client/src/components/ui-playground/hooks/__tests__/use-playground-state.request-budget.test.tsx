import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { PreferencesStoreProvider } from "@/stores/preferences/preferences-provider";
import type { ServerWithName } from "@/state/app-types";

/**
 * MJ-012: the hosted MCP operation routes carry a per-server request budget,
 * and a Playground `executeTool` command can spend more of it in one go than
 * the burst holds: it walks `tools/list` page by page until the tool turns up,
 * then calls `tools/execute`. Refusals from that budget are retried by
 * `webPost` after the wait they name, so the walk and the call both finish.
 *
 * Driven through the real hook, the real hosted API modules and the real
 * `webPost`; only the network is stubbed. Timers are real, and each refusal
 * asks for a one-second wait.
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
import { SERVER_REQUEST_BUDGET_REASON } from "@/shared/server-request-budget";

const SERVER = "paged-server";
const LAST_PAGE = 12;

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function budgetRefusal(): Response {
  return new Response(
    JSON.stringify({
      code: "RATE_LIMITED",
      message: "Too many requests to this server. Slow down and retry.",
      details: { reason: SERVER_REQUEST_BUDGET_REASON },
    }),
    {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": "1" },
    },
  );
}

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <PreferencesStoreProvider themeMode="light" themePreset="default">
      <SidebarProvider>{children}</SidebarProvider>
    </PreferencesStoreProvider>
  );
}

describe("usePlaygroundState — executeTool within the per-server request budget", () => {
  /** Pages requested, in order; a refused page appears twice. */
  let pagesRequested: number[];
  /** `toolName` of every `tools/execute` request, refused ones included. */
  let executeRequests: string[];

  beforeEach(() => {
    pagesRequested = [];
    executeRequests = [];
    const refusedOnce = new Set<string>();
    setApiContext({
      projectId: "project-1",
      serverIdsByName: { [SERVER]: "srv-1" },
    });

    mocks.authFetch.mockImplementation(
      async (path: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (path === "/api/web/tools/list") {
          const page = body.cursor === undefined ? 1 : Number(body.cursor);
          pagesRequested.push(page);
          // The ninth page of the walk is where the burst runs out.
          if (page === 9 && !refusedOnce.has("page-9")) {
            refusedOnce.add("page-9");
            return budgetRefusal();
          }
          return jsonResponse({
            tools: [
              {
                name: `tool-${page}`,
                inputSchema: { type: "object", properties: {} },
              },
            ],
            ...(page < LAST_PAGE ? { nextCursor: String(page + 1) } : {}),
          });
        }
        if (path === "/api/web/tools/execute") {
          executeRequests.push(body.toolName);
          if (!refusedOnce.has("execute")) {
            refusedOnce.add("execute");
            return budgetRefusal();
          }
          return jsonResponse({
            status: "completed",
            result: { content: [{ type: "text", text: "ran tool-12" }] },
          });
        }
        return jsonResponse({ code: "NOT_FOUND", message: path }, 404);
      },
    );
  });

  afterEach(() => {
    mocks.authFetch.mockReset();
    setApiContext(null);
  });

  it("walks past a refusal on page 9, finds the tool on page 12 and runs it", async () => {
    const { result } = renderHook(
      () =>
        usePlaygroundState({
          servers,
          serverName: SERVER,
          serverConfig: servers[SERVER].config,
        }),
      { wrapper },
    );
    // The mount-time listing of the first page settles before the command.
    await waitFor(() => expect(pagesRequested).toContain(1));
    await waitFor(() => expect(result.current.fetchingTools).toBe(false));

    const response = await executeInspectorCommand({
      id: "command-1",
      type: "executeTool",
      payload: { surface: "playground", toolName: `tool-${LAST_PAGE}` },
    });

    expect(response).toMatchObject({
      status: "success",
      result: {
        toolName: `tool-${LAST_PAGE}`,
        result: { content: [{ type: "text", text: "ran tool-12" }] },
      },
    });
    // Page 9 was refused once and asked for again; the walk went on to 12.
    expect(pagesRequested.filter((page) => page === 9)).toHaveLength(2);
    expect(pagesRequested.at(-1)).toBe(LAST_PAGE);
    // The call was refused once and sent again, for the same tool.
    expect(executeRequests).toEqual([`tool-${LAST_PAGE}`, `tool-${LAST_PAGE}`]);
  }, 20_000);
});

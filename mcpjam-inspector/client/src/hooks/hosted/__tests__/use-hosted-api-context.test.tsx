import { describe, it, expect, afterEach, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useApiContext } from "../use-hosted-api-context";
import {
  setApiContext,
  buildServerRequest,
  getApiContextRevision,
} from "@/lib/apis/web/context";
import { useAggregatedTools } from "@/hooks/use-aggregated-tools";
import { listTools } from "@/lib/apis/mcp-tools-api";

vi.mock("@/lib/apis/mcp-tools-api", () => ({
  listTools: vi.fn(),
}));

/**
 * The two `mcpProfile.toolListChanged` switches are carried, never derived:
 * App.tsx resolves them, this hook publishes them onto the global API
 * context, and every hosted request body spreads them. Each hop is a plain
 * hand-off, and the failure mode of dropping one is SILENT — the host asks
 * for a client that never listens, and the hosted connection listens anyway.
 *
 * So this asserts the hop end to end (hook → context → wire body) rather than
 * that the hook stored a field: only the body proves the switch left the
 * browser.
 */
const baseOptions = {
  projectId: "project-1",
  serverIdsByName: { asana: "server-1" },
  getAccessToken: async () => "token",
} as const;

describe("useApiContext — toolListChanged conformance knobs", () => {
  afterEach(() => {
    setApiContext(null);
  });

  it("puts both switches on the hosted request body", () => {
    renderHook(() =>
      useApiContext({
        ...baseOptions,
        suppressListenChannel: true,
        dropToolListChanged: true,
      }),
    );

    expect(buildServerRequest("asana")).toMatchObject({
      suppressListenChannel: true,
      dropToolListChanged: true,
    });
  });

  it("carries one switch without the other", () => {
    // A host that opens the listen channel but ignores the notification is a
    // real configuration; the two leaves are independent.
    renderHook(() =>
      useApiContext({ ...baseOptions, dropToolListChanged: true }),
    );

    const body = buildServerRequest("asana");
    expect(body).toMatchObject({ dropToolListChanged: true });
    expect(body).not.toHaveProperty("suppressListenChannel");
  });

  it("emits neither field for a conforming host", () => {
    // Absence is the conforming default the SDK reads, so a host with no
    // `toolListChanged` opinion must add nothing to the body.
    renderHook(() => useApiContext(baseOptions));

    const body = buildServerRequest("asana");
    expect(body).not.toHaveProperty("suppressListenChannel");
    expect(body).not.toHaveProperty("dropToolListChanged");
  });
});

/**
 * App.tsx rebuilds several of these inputs as fresh objects whenever server
 * state changes. Republishing on identity bumps the revision, every
 * all-server `tools/list` fan-out refetches, and its own state update starts
 * the next round. On 2026-09-30 that ran at ~330 requests/second against the
 * passthrough limiter (PLB-145).
 */
describe("useApiContext — publishes only real changes", () => {
  afterEach(() => {
    setApiContext(null);
    vi.clearAllMocks();
  });

  // Fresh objects on every call, equal in value — what App.tsx hands over.
  const freshOptions = () => ({
    ...baseOptions,
    serverIdsByName: { asana: "server-1", linear: "server-2" },
    supportedProtocolVersions: ["2025-11-25"],
    mcpProtocolVersionsByServerId: { "server-1": "2025-11-25" as const },
    oauthTokensByServerId: { "server-1": "oauth-token" },
    toolCallCancellation: { legacy: false },
  });

  it("keeps the revision when re-rendered with equal values", () => {
    const { rerender } = renderHook(() => useApiContext(freshOptions()));
    const revision = getApiContextRevision();

    rerender();
    rerender();

    expect(getApiContextRevision()).toBe(revision);
  });

  it("publishes a changed value", () => {
    const { rerender } = renderHook(
      ({ projectId }) => useApiContext({ ...freshOptions(), projectId }),
      { initialProps: { projectId: "project-1" } },
    );
    const revision = getApiContextRevision();

    rerender({ projectId: "project-2" });

    expect(getApiContextRevision()).not.toBe(revision);
    expect(buildServerRequest("asana")).toMatchObject({
      projectId: "project-2",
    });
  });

  it("clears the context on unmount", () => {
    const { unmount } = renderHook(() => useApiContext(freshOptions()));

    unmount();

    expect(() => buildServerRequest("asana")).toThrow(/projectId/);
  });

  it("does not loop tools/list when the caller re-renders with equal values", async () => {
    vi.mocked(listTools).mockImplementation(async ({ serverId }) => ({
      tools: [{ name: `${serverId}_tool`, inputSchema: { type: "object" } }],
    }));

    const { result, rerender } = renderHook(() => {
      useApiContext(freshOptions());
      return useAggregatedTools(["asana", "linear"]);
    });
    const settle = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

    await waitFor(() => {
      expect(result.current.flat).toHaveLength(2);
    });
    await settle();
    const callsAfterLoad = vi.mocked(listTools).mock.calls.length;

    rerender();
    rerender();
    await settle();

    expect(listTools).toHaveBeenCalledTimes(callsAfterLoad);
  });
});

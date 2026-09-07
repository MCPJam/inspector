import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INSPECTOR_MCP_RETRY_POLICY } from "../../../utils/mcp-retry-policy.js";

const { mcpClientManagerConstructorMock } = vi.hoisted(() => ({
  mcpClientManagerConstructorMock: vi.fn(),
}));

vi.mock("@mcpjam/sdk", async () => {
  const actual =
    await vi.importActual<typeof import("@mcpjam/sdk")>("@mcpjam/sdk");
  return {
    ...actual,
    MCPClientManager: mcpClientManagerConstructorMock,
  };
});

import {
  buildReplayManager,
  captureToolSnapshotForEvalAuthoring,
  fetchReplayConfig,
  storeReplayConfig,
} from "../route-helpers";

const ORIGINAL_CONVEX_HTTP_URL = process.env.CONVEX_HTTP_URL;

describe("fetchReplayConfig", () => {
  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://convex.example";
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (ORIGINAL_CONVEX_HTTP_URL === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX_HTTP_URL;
    }
  });

  it("sends the user bearer token to the public replay-config route", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          replayConfig: {
            runId: "run_123",
            suiteId: "suite_123",
            servers: [],
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    await fetchReplayConfig("run_123", "user-token");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://convex.example/v1/evals/runs/replay-config",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer user-token",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(
      new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).get(
        "X-Inspector-Service-Token",
      ),
    ).toBeNull();
  });
});

describe("storeReplayConfig", () => {
  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://convex.example";
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (ORIGINAL_CONVEX_HTTP_URL === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX_HTTP_URL;
    }
  });

  it("sends the user bearer token to the public store-replay-config route", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    await storeReplayConfig(
      "run_123",
      [
        {
          serverId: "asana",
          url: "https://example.com/mcp",
          accessToken: "at_123",
        },
      ],
      "user-token",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://convex.example/v1/evals/runs/store-replay-config",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer user-token",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(
      new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).get(
        "X-Inspector-Service-Token",
      ),
    ).toBeNull();
  });
});

describe("buildReplayManager", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("constructs an MCP client manager for tokenless replay configs", () => {
    buildReplayManager({
      runId: "run_123",
      suiteId: "suite_123",
      servers: [
        {
          serverId: "excalidraw",
          url: "https://mcp.excalidraw.com",
          preferSSE: true,
        },
      ],
    });

    expect(mcpClientManagerConstructorMock).toHaveBeenCalledWith(
      {
        excalidraw: {
          url: "https://mcp.excalidraw.com",
          timeout: expect.any(Number),
          preferSSE: true,
        },
      },
      {
        defaultTimeout: expect.any(Number),
        lazyConnect: true,
        // Replay dials server URLs a caller stored, so the manager must carry
        // the hosted egress guard (MJ-001). Asserted as a function here and
        // for its actual REFUSAL below — a fetch that guards nothing would
        // satisfy this line.
        baseFetch: expect.any(Function),
        // The shared inspector policy — asserts the replay manager uses it
        // rather than pinning its literal values here.
        retryPolicy: INSPECTOR_MCP_RETRY_POLICY,
      },
    );
  });

  it("gives that manager a fetch that refuses a private target", async () => {
    // The half `expect.any(Function)` cannot check. Hosted mode is what the
    // guard keys on, so it is set for this case only; the local-mode
    // passthrough is covered in `routes/web/__tests__/hosted-manager-base-fetch`.
    const previous = process.env.VITE_MCPJAM_HOSTED_MODE;
    process.env.VITE_MCPJAM_HOSTED_MODE = "true";
    vi.resetModules();
    try {
      const { buildReplayManager: build } = await import("../route-helpers.js");
      const { BlockedEgressTargetError } = await import(
        "../../../utils/hosted-egress-guard.js"
      );
      build({
        runId: "run_123",
        suiteId: "suite_123",
        servers: [{ serverId: "s1", url: "https://mcp.example.test/mcp" }],
      });
      const options = mcpClientManagerConstructorMock.mock.calls.at(-1)?.[1] as {
        baseFetch: typeof fetch;
      };
      await expect(
        options.baseFetch("http://169.254.169.254/latest/meta-data/"),
      ).rejects.toBeInstanceOf(BlockedEgressTargetError);
    } finally {
      if (previous === undefined) delete process.env.VITE_MCPJAM_HOSTED_MODE;
      else process.env.VITE_MCPJAM_HOSTED_MODE = previous;
      vi.resetModules();
    }
  });
});

describe("captureToolSnapshotForEvalAuthoring", () => {
  it("returns a best-effort snapshot plus rendered debug context", async () => {
    const clientManager = {
      listTools: vi.fn().mockImplementation(async (serverId: string) => {
        if (serverId === "offline") {
          throw new Error('MCP server "offline" is not connected.');
        }
        if (serverId === "broken") {
          throw new Error("tool listing failed");
        }
        return {
          tools: [
            {
              name: "bootstrap",
              description: "Call this before using search.",
              inputSchema: { type: "object" },
            },
          ],
        };
      }),
    } as any;

    const { toolSnapshot, toolSnapshotDebug } =
      await captureToolSnapshotForEvalAuthoring(
        clientManager,
        ["alpha", "broken", "offline"],
        {
          logPrefix: "tests",
          promptSectionMaxChars: 2048,
        },
      );

    expect(toolSnapshot.servers).toEqual([
      {
        serverId: "alpha",
        tools: [
          {
            name: "bootstrap",
            description: "Call this before using search.",
            inputSchema: { type: "object" },
          },
        ],
      },
      {
        serverId: "broken",
        tools: [],
        captureError: "tool listing failed",
      },
      {
        serverId: "offline",
        tools: [],
        captureError: 'MCP server "offline" is not connected.',
      },
    ]);

    expect(toolSnapshotDebug).toEqual({
      captureResult: {
        status: "partial",
        serverCount: 3,
        toolCount: 1,
        failedServerCount: 2,
        failedServerIds: ["broken", "offline"],
      },
      promptSection: expect.stringContaining("# Available MCP Tools"),
      promptSectionTruncated: false,
      promptSectionMaxChars: 2048,
      fallbackReason: "tool_snapshot_partial_capture",
      fullSnapshot: toolSnapshot,
    });
  });
});

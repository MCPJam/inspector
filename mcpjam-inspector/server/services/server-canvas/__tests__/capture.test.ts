import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { collectState } = vi.hoisted(() => ({ collectState: vi.fn() }));

vi.mock("@mcpjam/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mcpjam/sdk")>()),
  collectConnectedServerDoctorState: collectState,
}));

import {
  MCPClientManager,
  SERVER_FEATURE_SNAPSHOT_VERSION,
  computeCaptureContextHash,
} from "@mcpjam/sdk";
import {
  LOCAL_CAPTURE_BUDGET_MS,
  buildCaptureContext,
  captureServerFeatures,
} from "../capture.js";

const initInfo = {
  protocolVersion: "2025-11-25",
  transport: "streamable-http",
  serverVersion: { name: "fixture", version: "1.0.0" },
  serverCapabilities: { tools: {} },
  clientCapabilities: {
    elicitation: {},
    extensions: {
      "io.modelcontextprotocol/ui": {},
      "io.modelcontextprotocol/skills": {},
    },
  },
};

const ok = { status: "ok" as const, detail: "ok" };

/** A manager with no connections: no handshake seen, no skills declared. */
function fakeManager(): MCPClientManager {
  return new MCPClientManager();
}

beforeEach(() => {
  collectState.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildCaptureContext", () => {
  it("describes the negotiated version, transport and advertised client", () => {
    const context = buildCaptureContext(initInfo, { accountKey: "conn_123" });

    expect(context).toEqual({
      protocolVersion: "2025-11-25",
      era: "legacy",
      transport: "streamable-http",
      clientCapabilitiesHash: expect.stringMatching(/^cc_[0-9a-f]{16}$/),
      clientExtensions: [
        "io.modelcontextprotocol/skills",
        "io.modelcontextprotocol/ui",
      ],
      accountBinding: expect.stringMatching(/^acct_[0-9a-f]{16}$/),
    });
    // The account key is hashed, never stored as given.
    expect(JSON.stringify(context)).not.toContain("conn_123");
  });

  it("hashes equal contexts equally and different ones differently", () => {
    const reordered = {
      ...initInfo,
      clientCapabilities: {
        extensions: {
          "io.modelcontextprotocol/skills": {},
          "io.modelcontextprotocol/ui": {},
        },
        elicitation: {},
      },
    };
    const hash = (info: unknown, accountKey?: string) =>
      computeCaptureContextHash(buildCaptureContext(info, { accountKey }));

    expect(hash(initInfo, "a")).toBe(hash(reordered, "a"));
    expect(hash(initInfo, "a")).toMatch(/^ctx_[0-9a-f]{16}$/);
    expect(hash(initInfo, "a")).not.toBe(hash(initInfo, "b"));
    expect(hash(initInfo)).not.toBe(
      hash({ ...initInfo, protocolVersion: "2026-07-28" }),
    );
    expect(hash(initInfo)).not.toBe(hash({ ...initInfo, transport: "stdio" }));
  });

  it("reads missing init info as an unknown context", () => {
    expect(buildCaptureContext(undefined)).toEqual({
      transport: "unknown",
      era: "unknown",
    });
  });
});

describe("captureServerFeatures", () => {
  it("captures a v3 snapshot keyed by the project server id", async () => {
    collectState.mockResolvedValue({
      initInfo,
      capabilities: { tools: {} },
      tools: [{ name: "search", inputSchema: { type: "object" } }],
      toolsMetadata: {},
      resources: [],
      resourceTemplates: [],
      prompts: [],
      skills: [],
      checks: {
        initialization: ok,
        capabilities: ok,
        tools: ok,
        resources: ok,
        resourceTemplates: ok,
        prompts: ok,
        skills: { status: "skipped", detail: "not declared" },
      },
      errors: [],
    });
    const manager = fakeManager();

    const capture = await captureServerFeatures(manager, "Fixture", "srv_1");

    // Lists only: no skill file is read, so nothing can ask the user for input.
    expect(collectState).toHaveBeenCalledWith(manager, "Fixture", {
      verifySkills: false,
      signal: expect.any(AbortSignal),
    });
    expect(capture.snapshot.version).toBe(SERVER_FEATURE_SNAPSHOT_VERSION);
    expect(capture.snapshot.servers).toHaveLength(1);
    expect(capture.snapshot.servers[0]).toMatchObject({
      serverId: "srv_1",
      tools: [{ name: "search" }],
      coverage: { tools: "complete", skills: "complete" },
    });
    expect(capture.contextHash).toBe(computeCaptureContextHash(capture.context));
  });

  it("ends listing at its budget and keeps what was listed", async () => {
    let signal: AbortSignal | undefined;
    collectState.mockImplementation(
      async (_manager: unknown, _key: string, options: { signal?: AbortSignal }) => {
        signal = options.signal;
        return {
          initInfo,
          capabilities: { tools: {} },
          tools: [{ name: "search", inputSchema: { type: "object" } }],
          toolsMetadata: {},
          resources: [],
          resourceTemplates: [],
          prompts: [],
          skills: [],
          checks: {
            initialization: ok,
            capabilities: ok,
            tools: ok,
            resources: ok,
            resourceTemplates: ok,
            prompts: {
              status: "error",
              detail: "Listing did not finish before the collection deadline.",
            },
            skills: { status: "skipped", detail: "not declared" },
          },
          errors: [],
        };
      },
    );

    const capture = await captureServerFeatures(fakeManager(), "Fixture", "srv_1", {
      budgetMs: 5,
    });

    expect(signal).toBeInstanceOf(AbortSignal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(signal?.aborted).toBe(true);
    expect(capture.snapshot.servers[0]).toMatchObject({
      tools: [{ name: "search" }],
      coverage: { tools: "complete", prompts: "not-captured" },
    });
    expect(capture.snapshot.servers[0]?.captureError).toBeUndefined();
  });

  it("ends a local capture at its budget when a list never answers", async () => {
    const actual = await vi.importActual<typeof import("@mcpjam/sdk")>("@mcpjam/sdk");
    collectState.mockImplementation(actual.collectConnectedServerDoctorState);
    const manager = fakeManager();
    vi.spyOn(manager, "listTools").mockResolvedValue({
      tools: [{ name: "search", inputSchema: { type: "object" } }],
    });
    vi.spyOn(manager, "listResources").mockReturnValue(new Promise(() => {}));
    vi.spyOn(manager, "listPrompts").mockResolvedValue({ prompts: [] });
    vi.spyOn(manager, "listResourceTemplates").mockResolvedValue({
      resourceTemplates: [],
    });
    // The budget's deadline, ended by hand so the test does not wait for it.
    const deadline = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(deadline.signal);

    const capturing = captureServerFeatures(manager, "Fixture", "srv_1");
    expect(timeout).toHaveBeenCalledWith(LOCAL_CAPTURE_BUDGET_MS);
    // Every list but resources/list answers before the budget runs out.
    await new Promise((resolve) => setTimeout(resolve, 0));
    deadline.abort();
    const capture = await capturing;

    expect(capture.snapshot.servers[0]).toMatchObject({
      tools: [{ name: "search" }],
      coverage: { tools: "complete", resources: "not-captured" },
    });
    expect(capture.snapshot.servers[0]?.captureError).toBeUndefined();
  });

  it("stops listing when the connect's own signal aborts", async () => {
    let listing: AbortSignal | undefined;
    collectState.mockImplementation(
      async (_manager: unknown, _key: string, options: { signal?: AbortSignal }) => {
        listing = options.signal;
        throw new Error("not connected");
      },
    );
    const connect = new AbortController();

    await captureServerFeatures(fakeManager(), "Fixture", "srv_1", {
      signal: connect.signal,
    });
    expect(listing?.aborted).toBe(false);
    connect.abort();
    expect(listing?.aborted).toBe(true);
  });

  it("records a failed capture instead of throwing", async () => {
    collectState.mockRejectedValue(new Error("not connected"));

    const capture = await captureServerFeatures(fakeManager(), "Fixture", "srv_1");

    expect(capture.snapshot.servers).toEqual([
      { serverId: "srv_1", tools: [], captureError: "not connected" },
    ]);
    expect(capture.context.transport).toBe("unknown");
  });
});

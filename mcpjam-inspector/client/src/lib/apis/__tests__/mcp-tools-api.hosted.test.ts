import { beforeEach, describe, expect, it, vi } from "vitest";

const listHostedToolsMultiMock = vi.fn();
const resolveHostedServerIdMock = vi.fn();

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("@/lib/apis/web/tools-api", () => ({
  executeHostedTool: vi.fn(),
  listHostedTools: vi.fn(),
  listHostedToolsMulti: (...args: unknown[]) =>
    listHostedToolsMultiMock(...args),
}));

vi.mock("@/lib/apis/web/context", () => ({
  resolveHostedServerId: (...args: unknown[]) =>
    resolveHostedServerIdMock(...args),
}));

import { getToolsMetadata, listToolsForServers } from "../mcp-tools-api";
import { WebApiError } from "@/lib/apis/web/base";

describe("mcp-tools-api hosted mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveHostedServerIdMock.mockImplementation(
      (name: string) => `srv-${name.toLowerCase()}`,
    );
  });

  it("lists a server set with one request and answers in the caller's names", async () => {
    listHostedToolsMultiMock.mockResolvedValueOnce({
      results: {
        "srv-excalidraw": {
          tools: [{ name: "draw", inputSchema: { type: "object" } }],
          toolsMetadata: { draw: { ui: { resourceUri: "ui://draw" } } },
        },
      },
      errors: {
        "srv-other": {
          status: 424,
          code: "SERVER_UNREACHABLE",
          message: "connect ECONNREFUSED",
        },
      },
    });

    const result = await listToolsForServers(["Excalidraw", "Other"], {
      modelId: "anthropic/claude",
    });

    expect(listHostedToolsMultiMock).toHaveBeenCalledTimes(1);
    expect(listHostedToolsMultiMock).toHaveBeenCalledWith({
      serverNamesOrIds: ["Excalidraw", "Other"],
      modelId: "anthropic/claude",
    });
    expect(Object.keys(result.results)).toEqual(["Excalidraw"]);
    // Inspector metadata lands on `_meta`, as it does on the single-server path.
    expect(result.results.Excalidraw.tools[0]._meta).toEqual({
      ui: { resourceUri: "ui://draw" },
    });
    // The same error a single-server call would have thrown, status and all.
    const other = result.errors.Other as WebApiError;
    expect(other).toBeInstanceOf(WebApiError);
    expect(other).toMatchObject({
      status: 424,
      code: "SERVER_UNREACHABLE",
      message: "connect ECONNREFUSED",
    });
  });

  it("reports a name the context does not know on its own and lists the rest", async () => {
    resolveHostedServerIdMock.mockImplementation((name: string) => {
      if (name === "Ghost")
        throw new Error('Hosted server not found for "Ghost"');
      return `srv-${name.toLowerCase()}`;
    });
    listHostedToolsMultiMock.mockResolvedValueOnce({
      results: { "srv-excalidraw": { tools: [{ name: "draw" }] } },
    });

    const result = await listToolsForServers(["Excalidraw", "Ghost"]);

    expect(listHostedToolsMultiMock).toHaveBeenCalledWith({
      serverNamesOrIds: ["Excalidraw"],
      modelId: undefined,
    });
    expect(Object.keys(result.results)).toEqual(["Excalidraw"]);
    expect(result.errors.Ghost).toEqual(
      new Error('Hosted server not found for "Ghost"'),
    );
  });

  it("makes no request when no name resolves", async () => {
    resolveHostedServerIdMock.mockImplementation(() => {
      throw new Error("Hosted server not found");
    });

    const result = await listToolsForServers(["Ghost"]);

    expect(listHostedToolsMultiMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      results: {},
      errors: { Ghost: new Error("Hosted server not found") },
    });
  });

  it("answers every name that shares a hosted id", async () => {
    resolveHostedServerIdMock.mockReturnValue("srv-same");
    listHostedToolsMultiMock.mockResolvedValueOnce({
      results: { "srv-same": { tools: [{ name: "draw" }] } },
    });

    const result = await listToolsForServers(["Notion", "srv-same"]);

    expect(Object.keys(result.results).sort()).toEqual(["Notion", "srv-same"]);
  });

  it("keeps a server's authorization refusal with the rest of the batch", async () => {
    // The route authorizes each server on its own and answers a refusal in
    // `errors`, next to the servers that failed while listing, so the batch
    // is one request however many servers are refused.
    listHostedToolsMultiMock.mockResolvedValueOnce({
      results: { "srv-a": { tools: [{ name: "a" }], toolsMetadata: {} } },
      errors: {
        "srv-b": {
          status: 401,
          code: "UNAUTHORIZED",
          message: 'Server "B" requires OAuth authentication.',
        },
        "srv-c": {
          status: 409,
          code: "XAA_CONNECTION_NOT_CONFIGURED",
          message: 'Server "C" has no XAA client registration configured.',
        },
      },
    });

    const result = await listToolsForServers(["A", "B", "C"]);

    expect(listHostedToolsMultiMock).toHaveBeenCalledTimes(1);
    expect(Object.keys(result.results)).toEqual(["A"]);
    expect(result.errors.B).toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
    });
    expect(result.errors.C).toMatchObject({
      status: 409,
      code: "XAA_CONNECTION_NOT_CONFIGURED",
    });
  });

  it("fails the batch when the request itself fails", async () => {
    const failure = new WebApiError(401, "UNAUTHORIZED", "Session expired");
    listHostedToolsMultiMock.mockRejectedValueOnce(failure);

    await expect(listToolsForServers(["A", "B"])).rejects.toBe(failure);
    expect(listHostedToolsMultiMock).toHaveBeenCalledTimes(1);
  });

  it("aggregates tools metadata from one batch request", async () => {
    listHostedToolsMultiMock.mockResolvedValueOnce({
      results: {
        "srv-a": {
          tools: [{ name: "shared" }, { name: "only_a" }],
          toolsMetadata: { shared: { from: "a" }, only_a: {} },
          tokenCount: 10,
        },
        "srv-b": {
          tools: [{ name: "shared" }],
          toolsMetadata: { shared: { from: "b" } },
          tokenCount: 5,
        },
      },
    });

    const aggregate = await getToolsMetadata(["A", "B"], "anthropic/claude");

    expect(listHostedToolsMultiMock).toHaveBeenCalledTimes(1);
    expect(aggregate.toolServerMap).toEqual({ shared: "B", only_a: "A" });
    expect(aggregate.collidingToolNames).toEqual(["shared"]);
    expect(aggregate.scopedMetadata).toEqual({
      "A:shared": { from: "a" },
      "A:only_a": {},
      "B:shared": { from: "b" },
    });
    expect(aggregate.tokenCounts).toEqual({ A: 10, B: 5 });
    expect(Object.keys(aggregate.serializedTools).sort()).toEqual([
      "only_a",
      "shared",
    ]);
  });

  it("fails the aggregate with the failed server's own error", async () => {
    // Unchanged from the per-server days: the chat clears every tool on this
    // error rather than offering the model a partial set, and its scenario
    // branch reads the status off it.
    listHostedToolsMultiMock.mockResolvedValueOnce({
      results: { "srv-a": { tools: [], toolsMetadata: {} } },
      errors: {
        "srv-b": { status: 403, code: "FORBIDDEN", message: "Forbidden" },
      },
    });

    const error = await getToolsMetadata(["A", "B"]).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(WebApiError);
    expect(error).toMatchObject({ status: 403, code: "FORBIDDEN" });
  });
});

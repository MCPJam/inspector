import { afterEach, describe, expect, test, vi } from "vitest";
import type { ConvexHttpClient } from "convex/browser";
import type { ModelMessage } from "ai";
import type { MCPClientManager } from "@mcpjam/sdk";
import {
  captureMcpAppWidgetSnapshots,
  uploadScreenshotBlob,
  uploadVideoBlob,
  MAX_REPLAY_VIDEO_BYTES,
} from "../mcp-app-widget-capture.js";

function makeClient(uploadUrl: unknown): {
  client: ConvexHttpClient;
  mutation: ReturnType<typeof vi.fn>;
} {
  const mutation = vi.fn(async () => uploadUrl);
  return { client: { mutation } as unknown as ConvexHttpClient, mutation };
}

// Duck-typed Response so the test doesn't depend on a global `Response`.
const okJson = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
});
const errStatus = (status: number) => ({
  ok: false,
  status,
  json: async () => null,
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("uploadScreenshotBlob", () => {
  test("POSTs an image/png blob and returns the storageId", async () => {
    const { client, mutation } = makeClient("https://convex.example/upload");
    const fetchMock = vi.fn(async () => okJson({ storageId: "store-1" }));
    vi.stubGlobal("fetch", fetchMock);

    // PNG base64 begins with "iVBOR"; not "/9j/" so it's detected as PNG.
    const id = await uploadScreenshotBlob(client, "iVBORw0KGgo");

    expect(id).toBe("store-1");
    expect(mutation).toHaveBeenCalledWith(
      "chatSessions:generateSnapshotUploadUrl",
      {},
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://convex.example/upload");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "image/png",
    );
    expect((init.body as Blob).type).toBe("image/png");
  });

  test("detects image/jpeg from the base64 header", async () => {
    const { client } = makeClient("https://convex.example/upload");
    const fetchMock = vi.fn(async () => okJson({ storageId: "store-2" }));
    vi.stubGlobal("fetch", fetchMock);

    await uploadScreenshotBlob(client, "/9j/4AAQSkZJRg");

    const [, init] = fetchMock.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "image/jpeg",
    );
  });

  test("returns undefined when the upload URL can't be generated (no fetch)", async () => {
    const { client } = makeClient("");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await uploadScreenshotBlob(client, "iVBORw0")).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("throws on a non-2xx upload response", async () => {
    const { client } = makeClient("https://convex.example/upload");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => errStatus(500)),
    );

    await expect(uploadScreenshotBlob(client, "iVBORw0")).rejects.toThrow(/500/);
  });

  test("returns undefined when the response body lacks a storageId", async () => {
    const { client } = makeClient("https://convex.example/upload");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okJson({})),
    );

    expect(await uploadScreenshotBlob(client, "iVBORw0")).toBeUndefined();
  });
});

describe("uploadVideoBlob", () => {
  test("POSTs a video/webm blob and returns the storageId", async () => {
    const { client, mutation } = makeClient("https://convex.example/upload");
    const fetchMock = vi.fn(async () => okJson({ storageId: "vid-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const id = await uploadVideoBlob(client, Buffer.from([0x1a, 0x45, 0xdf]));

    expect(id).toBe("vid-1");
    expect(mutation).toHaveBeenCalledWith(
      "chatSessions:generateSnapshotUploadUrl",
      {},
    );
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://convex.example/upload");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "video/webm",
    );
    expect((init.body as Blob).type).toBe("video/webm");
  });

  test("returns undefined when the upload URL can't be generated (no fetch)", async () => {
    const { client } = makeClient("");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await uploadVideoBlob(client, Buffer.from([1]))).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("throws on a non-2xx upload response", async () => {
    const { client } = makeClient("https://convex.example/upload");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => errStatus(500)),
    );

    await expect(uploadVideoBlob(client, Buffer.from([1]))).rejects.toThrow(
      /500/,
    );
  });

  test("refuses an oversized video before touching the network", async () => {
    const { client, mutation } = makeClient("https://convex.example/upload");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // The backend rejects this at its write boundary anyway; refusing here
    // means we don't push tens of MB across the wire to find that out.
    const oversized = Buffer.alloc(MAX_REPLAY_VIDEO_BYTES + 1);
    await expect(uploadVideoBlob(client, oversized)).rejects.toThrow(
      /too large/i,
    );
    expect(mutation).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("bounds the upload with an abort signal so a stall can't hang teardown", async () => {
    const { client } = makeClient("https://convex.example/upload");
    const fetchMock = vi.fn(async () => okJson({ storageId: "vid-1" }));
    vi.stubGlobal("fetch", fetchMock);

    await uploadVideoBlob(client, Buffer.from([1]));

    const [, init] = fetchMock.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("captureMcpAppWidgetSnapshots — skipToolCallIds", () => {
  const widgetToolMessages = (toolCallId: string): ModelMessage[] =>
    [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId, toolName: "show_widget", input: {} },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName: "show_widget",
            serverId: "server-1",
            output: { type: "json", value: {} },
          },
        ],
      },
    ] as unknown as ModelMessage[];

  const makeManager = () => {
    const readResource = vi.fn(async () => ({
      contents: [{ mimeType: "text/html", text: "<html>widget</html>" }],
    }));
    const manager = {
      getAllToolsMetadata: vi.fn(() => ({
        show_widget: { ui: { resourceUri: "ui://widget/main" } },
      })),
      readResource,
    } as unknown as MCPClientManager;
    return { manager, readResource };
  };

  test("skips already-captured tool calls entirely (no readResource, no upload)", async () => {
    const { manager, readResource } = makeManager();
    const { client, mutation } = makeClient("https://convex.example/upload");
    const fetchMock = vi.fn(async () => okJson({ storageId: "html-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const messages = [
      ...widgetToolMessages("call-1"),
      ...widgetToolMessages("call-2"),
    ];

    const snapshots = await captureMcpAppWidgetSnapshots({
      messages,
      mcpClientManager: manager,
      convexClient: client,
      skipToolCallIds: new Set(["call-1"]),
    });

    expect(snapshots?.map((s) => s.toolCallId)).toEqual(["call-2"]);
    expect(readResource).toHaveBeenCalledTimes(1);
    expect(mutation).toHaveBeenCalledTimes(1);
  });

  test("returns undefined (and touches nothing) when every call is skipped", async () => {
    const { manager, readResource } = makeManager();
    const { client, mutation } = makeClient("https://convex.example/upload");
    vi.stubGlobal("fetch", vi.fn());

    const snapshots = await captureMcpAppWidgetSnapshots({
      messages: widgetToolMessages("call-1"),
      mcpClientManager: manager,
      convexClient: client,
      skipToolCallIds: new Set(["call-1"]),
    });

    expect(snapshots).toBeUndefined();
    expect(readResource).not.toHaveBeenCalled();
    expect(mutation).not.toHaveBeenCalled();
  });

  test("captures everything when no skip set is passed", async () => {
    const { manager, readResource } = makeManager();
    const { client } = makeClient("https://convex.example/upload");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okJson({ storageId: "html-1" })),
    );

    const snapshots = await captureMcpAppWidgetSnapshots({
      messages: widgetToolMessages("call-1"),
      mcpClientManager: manager,
      convexClient: client,
    });

    expect(snapshots?.map((s) => s.toolCallId)).toEqual(["call-1"]);
    expect(readResource).toHaveBeenCalledTimes(1);
    expect(snapshots?.[0]?.widgetHtmlBlobId).toBe("html-1");
  });
});

// INSPECTOR-CLIENT-227: tool `_meta` arrives verbatim from the connected
// server, so one tool declaring a malformed resourceUri must drop out of the
// batch rather than throw the whole capture away.
describe("captureMcpAppWidgetSnapshots — malformed tool metadata", () => {
  const toolMessages = (
    toolCallId: string,
    toolName: string,
  ): ModelMessage[] =>
    [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId, toolName, input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName,
            serverId: "server-1",
            output: { type: "json", value: {} },
          },
        ],
      },
    ] as unknown as ModelMessage[];

  test("skips the malformed tool and still captures the valid one", async () => {
    const readResource = vi.fn(async () => ({
      contents: [{ mimeType: "text/html", text: "<html>widget</html>" }],
    }));
    const manager = {
      getAllToolsMetadata: vi.fn(() => ({
        broken_widget: { ui: { resourceUri: "" } },
        good_widget: { ui: { resourceUri: "ui://widget/main" } },
      })),
      readResource,
    } as unknown as MCPClientManager;
    const { client } = makeClient("https://convex.example/upload");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okJson({ storageId: "html-1" })),
    );

    const snapshots = await captureMcpAppWidgetSnapshots({
      messages: [
        ...toolMessages("call-broken", "broken_widget"),
        ...toolMessages("call-good", "good_widget"),
      ],
      mcpClientManager: manager,
      convexClient: client,
    });

    expect(snapshots?.map((s) => s.toolCallId)).toEqual(["call-good"]);
    expect(readResource).toHaveBeenCalledTimes(1);
    expect(readResource).toHaveBeenCalledWith("server-1", {
      uri: "ui://widget/main",
    });
  });
});

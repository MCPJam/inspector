import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ModelMessage } from "ai";
import type { MCPClientManager } from "@mcpjam/sdk";

const { hostedMode } = vi.hoisted(() => ({ hostedMode: { value: false } }));

vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return {
    ...actual,
    get HOSTED_MODE() {
      return hostedMode.value;
    },
  };
});

import {
  captureMcpAppWidgetSnapshots,
  uploadScreenshotBlob,
  uploadVideoBlob,
  MAX_REPLAY_VIDEO_BYTES,
} from "../mcp-app-widget-capture.js";
import {
  evalIterationChatSessionId,
  evalSnapshotUploadTarget,
  snapshotScenarioScope,
} from "../snapshot-upload-target.js";

// Captured bytes go to the backend's upload route as the launching user,
// scoped to the chat they belong to (MJ-006).
const CONVEX_HTTP_URL = "https://demo.convex.site";
const target = { convexAuthToken: "user-bearer", chatSessionId: "chat-1" };
const UPLOAD_ROUTE =
  "https://demo.convex.site/web/uploads/blob?purpose=widget-snapshot&chatSessionId=chat-1";

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
const refused = (status: number, code: string) => ({
  ok: false,
  status,
  json: async () => ({ ok: false, code, error: `refused: ${code}` }),
});

const originalEnv = {
  CONVEX_HTTP_URL: process.env.CONVEX_HTTP_URL,
  INSPECTOR_SERVICE_TOKEN: process.env.INSPECTOR_SERVICE_TOKEN,
};

beforeEach(() => {
  process.env.CONVEX_HTTP_URL = CONVEX_HTTP_URL;
  delete process.env.INSPECTOR_SERVICE_TOKEN;
  hostedMode.value = false;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function uploadCall(fetchMock: ReturnType<typeof vi.fn>, index = 0) {
  return fetchMock.mock.calls[index]! as unknown as [string, RequestInit];
}

describe("evalSnapshotUploadTarget", () => {
  test("scopes an iteration's evidence to its eval chat session", () => {
    expect(evalSnapshotUploadTarget("user-bearer", "iter_1")).toEqual({
      convexAuthToken: "user-bearer",
      chatSessionId: "eval_iter_1",
    });
    expect(evalIterationChatSessionId("iter_1")).toBe("eval_iter_1");
  });

  test("is absent without a bearer or an iteration id", () => {
    expect(evalSnapshotUploadTarget(undefined, "iter_1")).toBeUndefined();
    expect(evalSnapshotUploadTarget("user-bearer", undefined)).toBeUndefined();
  });
});

describe("snapshotScenarioScope", () => {
  test("adds nothing for a direct session", () => {
    expect(snapshotScenarioScope(target)).toEqual({});
    expect(snapshotScenarioScope({ ...target, accessVersion: 3 })).toEqual({});
  });

  test("carries a hosted scenario and its access version", () => {
    expect(
      snapshotScenarioScope({
        ...target,
        scenarioId: "scn_1",
        accessVersion: 3,
      }),
    ).toEqual({ scenarioId: "scn_1", accessVersion: 3 });
  });

  test.each([-1, 1.5, Number.NaN])(
    "leaves out an access version of %s",
    (accessVersion) => {
      expect(
        snapshotScenarioScope({
          ...target,
          scenarioId: "scn_1",
          accessVersion,
        }),
      ).toEqual({ scenarioId: "scn_1" });
    },
  );
});

describe("uploadScreenshotBlob", () => {
  test("POSTs an image/png blob to the upload route and returns the storageId", async () => {
    const fetchMock = vi.fn(async () =>
      okJson({ ok: true, storageId: "store-1" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    // PNG base64 begins with "iVBOR"; not "/9j/" so it's detected as PNG.
    const id = await uploadScreenshotBlob(target, "iVBORw0KGgo");

    expect(id).toBe("store-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = uploadCall(fetchMock);
    expect(url).toBe(UPLOAD_ROUTE);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Content-Type": "image/png",
      Authorization: "Bearer user-bearer",
    });
    expect((init.body as Blob).type).toBe("image/png");
    expect(Buffer.from(await (init.body as Blob).arrayBuffer())).toEqual(
      Buffer.from("iVBORw0KGgo", "base64"),
    );
  });

  test("detects image/jpeg from the base64 header", async () => {
    const fetchMock = vi.fn(async () => okJson({ storageId: "store-2" }));
    vi.stubGlobal("fetch", fetchMock);

    await uploadScreenshotBlob(target, "/9j/4AAQSkZJRg");

    const [, init] = uploadCall(fetchMock);
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "image/jpeg",
    );
  });

  test("scopes a hosted-scenario session's upload to its grant", async () => {
    const fetchMock = vi.fn(async () => okJson({ storageId: "store-3" }));
    vi.stubGlobal("fetch", fetchMock);

    await uploadScreenshotBlob(
      { ...target, scenarioId: "scn_1", accessVersion: 2 },
      "iVBORw0KGgo",
    );

    const [url] = uploadCall(fetchMock);
    expect(url).toBe(`${UPLOAD_ROUTE}&scenarioId=scn_1&accessVersion=2`);
  });

  test.each([
    [401, "UNAUTHORIZED"],
    [403, "FORBIDDEN"],
    [413, "PAYLOAD_TOO_LARGE"],
    [429, "RATE_LIMITED"],
  ])("throws the route's %i refusal", async (status, code) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => refused(status, code)),
    );

    await expect(uploadScreenshotBlob(target, "iVBORw0")).rejects.toMatchObject(
      {
        status,
        code,
        message: `refused: ${code}`,
      },
    );
  });

  test("throws on a non-2xx answer without a body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => errStatus(500)),
    );

    await expect(uploadScreenshotBlob(target, "iVBORw0")).rejects.toMatchObject(
      {
        status: 500,
      },
    );
  });

  test("throws when the answer lacks a storageId", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okJson({})),
    );

    await expect(uploadScreenshotBlob(target, "iVBORw0")).rejects.toThrow(
      /storage id/,
    );
  });

  test("refuses to run without CONVEX_HTTP_URL", async () => {
    delete process.env.CONVEX_HTTP_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadScreenshotBlob(target, "iVBORw0")).rejects.toThrow(
      /CONVEX_HTTP_URL/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("uploadVideoBlob on a local install", () => {
  test("POSTs a video/webm blob to the upload route and returns the storageId", async () => {
    const fetchMock = vi.fn(async () => okJson({ storageId: "vid-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const id = await uploadVideoBlob(target, Buffer.from([0x1a, 0x45, 0xdf]));

    expect(id).toBe("vid-1");
    const [url, init] = uploadCall(fetchMock);
    expect(url).toBe(UPLOAD_ROUTE);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer user-bearer",
    );
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "video/webm",
    );
    expect((init.body as Blob).type).toBe("video/webm");
  });

  test("posts an mp4 as an mp4 when the caller says so", async () => {
    // Convex serves back exactly the content type the bytes were posted with,
    // so a hosted daemon's MP4 announced as webm is a file the browser refuses
    // to play — and the only symptom is an empty player on the trace page.
    const fetchMock = vi.fn(async () => okJson({ storageId: "vid-2" }));
    vi.stubGlobal("fetch", fetchMock);

    const id = await uploadVideoBlob(target, Buffer.from([0, 0, 0, 0x18]), {
      contentType: "video/mp4",
    });

    expect(id).toBe("vid-2");
    const [, init] = uploadCall(fetchMock);
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "video/mp4",
    );
    expect((init.body as Blob).type).toBe("video/mp4");
  });

  test("keeps webm for a caller that names no type", async () => {
    // Every caller that predates a second recorder is the local widget
    // harness, whose replay has always been a `.webm`.
    const fetchMock = vi.fn(async () => okJson({ storageId: "vid-3" }));
    vi.stubGlobal("fetch", fetchMock);

    await uploadVideoBlob(target, Buffer.from([1]), {});

    const [, init] = uploadCall(fetchMock);
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "video/webm",
    );
  });

  test.each([
    [413, "PAYLOAD_TOO_LARGE"],
    [429, "RATE_LIMITED"],
  ])("throws the route's %i refusal", async (status, code) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => refused(status, code)),
    );

    await expect(
      uploadVideoBlob(target, Buffer.from([1])),
    ).rejects.toMatchObject({
      status,
      code,
    });
  });

  test("refuses an oversized video before touching the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // The backend rejects this at its write boundary anyway; refusing here
    // means we don't push tens of MB across the wire to find that out.
    const oversized = Buffer.alloc(MAX_REPLAY_VIDEO_BYTES + 1);
    await expect(uploadVideoBlob(target, oversized)).rejects.toThrow(
      /too large/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("bounds the upload with an abort signal so a stall can't hang teardown", async () => {
    const fetchMock = vi.fn(async () => okJson({ storageId: "vid-1" }));
    vi.stubGlobal("fetch", fetchMock);

    await uploadVideoBlob(target, Buffer.from([1]));

    const [, init] = uploadCall(fetchMock);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test("reports a stalled upload as a timeout", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason),
            );
          }),
      ),
    );

    const pending = uploadVideoBlob(target, Buffer.from([1]));
    deadline.abort(new DOMException("deadline", "TimeoutError"));

    await expect(pending).rejects.toThrow("Timed out: replay video upload");
  });
});

describe("uploadVideoBlob with the inspector service credential", () => {
  const REPLAY_ISSUER =
    "https://demo.convex.site/internal/v1/chat-sessions/replay-video/upload-url";
  const DESTINATION =
    "https://storage.example.com/api/storage/upload?token=UNEXPECTED_MARKER";

  beforeEach(() => {
    process.env.INSPECTOR_SERVICE_TOKEN = "service-token-1";
    hostedMode.value = true;
  });

  test("asks the replay issuer as the user, then stores the bytes at the destination", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === REPLAY_ISSUER
        ? okJson({ uploadUrl: DESTINATION })
        : okJson({ storageId: "vid-1" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const id = await uploadVideoBlob(target, Buffer.from([0x1a, 0x45]), {
      contentType: "video/mp4",
    });

    expect(id).toBe("vid-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [issuerUrl, issuerInit] = uploadCall(fetchMock, 0);
    expect(issuerUrl).toBe(REPLAY_ISSUER);
    expect(issuerInit.method).toBe("POST");
    expect(issuerInit.headers).toEqual({
      Authorization: "Bearer user-bearer",
      "Content-Type": "application/json",
      "x-inspector-service-token": "service-token-1",
    });
    expect(JSON.parse(String(issuerInit.body))).toEqual({
      chatSessionId: "chat-1",
    });
    const [storageUrl, storageInit] = uploadCall(fetchMock, 1);
    expect(storageUrl).toBe(DESTINATION);
    expect(storageInit.redirect).toBe("error");
    expect(storageInit.headers).toEqual({ "Content-Type": "video/mp4" });
    expect(storageInit.signal).toBeInstanceOf(AbortSignal);
    expect(Buffer.from(await (storageInit.body as Blob).arrayBuffer())).toEqual(
      Buffer.from([0x1a, 0x45]),
    );
  });

  test("sends a hosted-scenario session's grant to the replay issuer", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === REPLAY_ISSUER
        ? okJson({ uploadUrl: DESTINATION })
        : okJson({ storageId: "vid-2" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await uploadVideoBlob(
      { ...target, scenarioId: "scn_1", accessVersion: 4 },
      Buffer.from([0x1a]),
    );

    const [, issuerInit] = uploadCall(fetchMock, 0);
    expect(JSON.parse(String(issuerInit.body))).toEqual({
      chatSessionId: "chat-1",
      scenarioId: "scn_1",
      accessVersion: 4,
    });
  });

  test("takes a replay larger than the upload route's cap", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === REPLAY_ISSUER
        ? okJson({ uploadUrl: DESTINATION })
        : okJson({ storageId: "vid-big" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const id = await uploadVideoBlob(target, Buffer.alloc(40 * 1024 * 1024));

    expect(id).toBe("vid-big");
    expect(uploadCall(fetchMock, 1)[0]).toBe(DESTINATION);
  });

  test.each([
    [401, "Unauthorized"],
    [403, "Forbidden"],
    [429, "Too many snapshot uploads right now."],
  ])("surfaces the issuer's %i and sends no bytes", async (status, error) => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status,
      json: async () => ({ error }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadVideoBlob(target, Buffer.from([1]))).rejects.toThrow(
      `Replay video upload was refused (${status}): ${error}`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("sends no bytes to a destination that is not https", async () => {
    const fetchMock = vi.fn(async () =>
      okJson({ uploadUrl: "http://storage.example.com/upload" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadVideoBlob(target, Buffer.from([1]))).rejects.toThrow(
      /no usable destination/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("throws when storage refuses the bytes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === REPLAY_ISSUER
          ? okJson({ uploadUrl: DESTINATION })
          : errStatus(500),
      ),
    );

    await expect(uploadVideoBlob(target, Buffer.from([1]))).rejects.toThrow(
      "Failed to upload replay video (500)",
    );
  });

  test("reads a malformed storage answer as no storage id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === REPLAY_ISSUER
          ? okJson({ uploadUrl: DESTINATION })
          : {
              ok: true,
              status: 200,
              json: async () => {
                throw new SyntaxError("Unexpected token");
              },
            },
      ),
    );

    expect(await uploadVideoBlob(target, Buffer.from([1]))).toBeUndefined();
  });

  test("refuses to run hosted without the service credential", async () => {
    delete process.env.INSPECTOR_SERVICE_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadVideoBlob(target, Buffer.from([1]))).rejects.toThrow(
      /INSPECTOR_SERVICE_TOKEN/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
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
    const fetchMock = vi.fn(async () => okJson({ storageId: "html-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const messages = [
      ...widgetToolMessages("call-1"),
      ...widgetToolMessages("call-2"),
    ];

    const snapshots = await captureMcpAppWidgetSnapshots({
      messages,
      mcpClientManager: manager,
      uploadTarget: target,
      skipToolCallIds: new Set(["call-1"]),
    });

    expect(snapshots?.map((s) => s.toolCallId)).toEqual(["call-2"]);
    expect(readResource).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("returns undefined (and touches nothing) when every call is skipped", async () => {
    const { manager, readResource } = makeManager();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const snapshots = await captureMcpAppWidgetSnapshots({
      messages: widgetToolMessages("call-1"),
      mcpClientManager: manager,
      uploadTarget: target,
      skipToolCallIds: new Set(["call-1"]),
    });

    expect(snapshots).toBeUndefined();
    expect(readResource).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("captures everything when no skip set is passed", async () => {
    const { manager, readResource } = makeManager();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okJson({ storageId: "html-1" })),
    );

    const snapshots = await captureMcpAppWidgetSnapshots({
      messages: widgetToolMessages("call-1"),
      mcpClientManager: manager,
      uploadTarget: target,
    });

    expect(snapshots?.map((s) => s.toolCallId)).toEqual(["call-1"]);
    expect(readResource).toHaveBeenCalledTimes(1);
    expect(snapshots?.[0]?.widgetHtmlBlobId).toBe("html-1");
  });

  test("builds the snapshot without an HTML blob when there is nothing to upload as", async () => {
    const { manager, readResource } = makeManager();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const snapshots = await captureMcpAppWidgetSnapshots({
      messages: widgetToolMessages("call-1"),
      mcpClientManager: manager,
      uploadTarget: undefined,
    });

    expect(snapshots?.map((s) => s.toolCallId)).toEqual(["call-1"]);
    expect(readResource).toHaveBeenCalledTimes(1);
    expect(snapshots?.[0]?.widgetHtmlBlobId).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("keeps the snapshot, without its blob, when the upload route refuses", async () => {
    const { manager } = makeManager();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => refused(403, "FORBIDDEN")),
    );

    const snapshots = await captureMcpAppWidgetSnapshots({
      messages: widgetToolMessages("call-1"),
      mcpClientManager: manager,
      uploadTarget: target,
    });

    expect(snapshots?.map((s) => s.toolCallId)).toEqual(["call-1"]);
    expect(snapshots?.[0]?.widgetHtmlBlobId).toBeUndefined();
  });

  test("uploads the widget HTML as text, never as text/html", async () => {
    const { manager } = makeManager();
    const fetchMock = vi.fn(async () => okJson({ storageId: "html-1" }));
    vi.stubGlobal("fetch", fetchMock);

    await captureMcpAppWidgetSnapshots({
      messages: widgetToolMessages("call-1"),
      mcpClientManager: manager,
      uploadTarget: target,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = uploadCall(fetchMock);
    expect(url).toBe(UPLOAD_ROUTE);
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "text/plain; charset=utf-8",
    );
    const body = init.body as Blob;
    expect(body.type).toBe("text/plain; charset=utf-8");
    expect(await body.text()).toBe("<html>widget</html>");
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
      uploadTarget: target,
    });

    expect(snapshots?.map((s) => s.toolCallId)).toEqual(["call-good"]);
    expect(readResource).toHaveBeenCalledTimes(1);
    expect(readResource).toHaveBeenCalledWith("server-1", {
      uri: "ui://widget/main",
    });
  });
});

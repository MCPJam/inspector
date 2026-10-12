import { ConvexHttpClient } from "convex/browser";
import { startSuiteRunWithRecorder } from "../../services/evals/recorder.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareToolSnapshotTransport,
  toolSnapshotDiagnostics,
} from "../tool-snapshot-upload.js";
import { prepareChatToolSnapshot } from "../chat-tool-snapshot.js";
import { createSecretScrubber } from "../secrets/secret-scrubber.js";

const upload = vi.hoisted(() => vi.fn());
vi.mock("@/shared/blob-upload", () => ({ uploadBlob: upload }));
vi.mock("../logger.js", () => ({ logger: { debug: vi.fn() } }));

beforeEach(() => {
  upload.mockReset().mockResolvedValue("blob-1");
});
afterEach(() => {
  vi.unstubAllEnvs();
});
const scope = { purpose: "tool-snapshot", projectId: "project-1" } as const;
const large = { version: 3, servers: [{ description: "🙂".repeat(70_000) }] };

describe("tool snapshot transport", () => {
  it("rejects captures beyond the backend HTTP cap before uploading", async () => {
    const snapshot = { description: "x".repeat(19 * 1024 * 1024) };
    await expect(
      prepareToolSnapshotTransport({ snapshot, scope, bearerToken: "token" }),
    ).rejects.toThrow("19 MiB");
    expect(upload).not.toHaveBeenCalled();
  });
  it("keeps diagnostics small instead of sending a second catalog", () => {
    expect(
      toolSnapshotDiagnostics({
        fullSnapshot: large,
        captureResult: { status: "complete" },
      }),
    ).toEqual({ captureResult: { status: "complete" } });
    expect(toolSnapshotDiagnostics()).toBeUndefined();
  });
  it("keeps a small snapshot inline and skips uploads for missing captures", async () => {
    const snapshot = { version: 3, servers: [] };
    expect(await prepareToolSnapshotTransport({ snapshot, scope })).toEqual({
      toolSnapshot: snapshot,
    });
    expect(
      await prepareToolSnapshotTransport({ snapshot: undefined, scope }),
    ).toEqual({});
    expect(upload).not.toHaveBeenCalled();
  });
  it("counts UTF-8 bytes and uploads large catalogs under their scope", async () => {
    expect(
      await prepareToolSnapshotTransport({
        snapshot: large,
        scope,
        bearerToken: "token",
        siteUrl: "https://demo.convex.site",
      }),
    ).toEqual({ toolSnapshotBlobId: "blob-1" });
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({
        scope,
        bearerToken: "token",
        contentType: "application/json",
        body: JSON.stringify(large),
      }),
    );
  });
  it("uploads small reserved schema keys unchanged instead of escaping them", async () => {
    const snapshot = {
      version: 3,
      servers: [
        {
          tools: [
            {
              inputSchema: {
                $schema: "https://json-schema.org/schema",
                $ref: "#/$defs/input",
              },
            },
          ],
        },
      ],
    };
    expect(
      await prepareToolSnapshotTransport({
        snapshot,
        scope,
        bearerToken: "token",
        siteUrl: "https://demo.convex.site",
      }),
    ).toEqual({ toolSnapshotBlobId: "blob-1" });
    expect(upload.mock.calls[0][0].body).toBe(JSON.stringify(snapshot));
  });
  it("refuses a large eval capture without upload auth", async () => {
    await expect(
      prepareToolSnapshotTransport({ snapshot: large, scope }),
    ).rejects.toThrow("authenticated upload");
  });
});

describe("best-effort chat snapshot", () => {
  const options = {
    chatSessionId: "chat-1",
    projectId: "project-1",
    authHeader: "Bearer token",
    startedAt: 1,
    toolSnapshot: large,
  };
  it("drops failed uploads while preserving transcript save options", async () => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://demo.convex.site");
    upload.mockRejectedValueOnce(new Error("offline"));
    expect(await prepareChatToolSnapshot(options)).toEqual({
      ...options,
      toolSnapshot: undefined,
      toolSnapshotUnavailable: true,
    });
  });
  it("uploads catalogs after secret scrubbing and saves only their reference", async () => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://demo.convex.site");
    const secret = "secret-test-token";
    const secretScrubber = createSecretScrubber([
      { value: secret, name: "TEST_TOKEN" },
    ]);
    if (!secretScrubber) throw new Error("Test secret was not registered");
    const result = await prepareChatToolSnapshot({
      ...options,
      toolSnapshot: { ...large, secret },
      secretScrubber,
    });
    expect(result.toolSnapshot).toBeUndefined();
    expect(result.toolSnapshotBlobId).toBe("blob-1");
    expect(upload.mock.calls[0][0].body).not.toContain(secret);
  });
  it("does not require uploads for legacy small captures", async () => {
    expect(
      await prepareChatToolSnapshot({
        ...options,
        toolSnapshot: { servers: [] },
      }),
    ).toEqual({ ...options, toolSnapshot: { servers: [] } });
  });
});

describe("eval launch upload integration", () => {
  it("calls the launch action with a file reference and bounded diagnostics", async () => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://demo.convex.site");
    const convexClient = new ConvexHttpClient("https://demo.convex.cloud");
    const mutation = vi
      .spyOn(convexClient, "mutation")
      .mockRejectedValue(new Error("Must use an action"));
    const action = vi
      .spyOn(convexClient, "action")
      .mockResolvedValueOnce({ runId: "run-1", testCases: [] })
      .mockResolvedValueOnce({ iterationIds: [] });
    const snapshot = {
      version: 3,
      capturedAt: 1,
      servers: [
        {
          serverId: "server-1",
          tools: [{ name: "large", description: "x".repeat(300_000) }],
        },
      ],
    };
    await startSuiteRunWithRecorder({
      convexClient,
      convexAuthToken: "token",
      suiteId: "suite-1",
      toolSnapshot: snapshot,
      toolSnapshotDebug: {
        fullSnapshot: snapshot,
        captureResult: { status: "complete" },
      },
    });
    expect(action).toHaveBeenNthCalledWith(
      1,
      "serverToolSnapshotActions:startTestSuiteRun",
      expect.objectContaining({
        toolSnapshotBlobId: "blob-1",
        toolSnapshotDebug: { captureResult: { status: "complete" } },
      }),
    );
    expect(action.mock.calls[0][1]).not.toHaveProperty("toolSnapshot");
    expect(upload.mock.calls[0][0].body).toBe(JSON.stringify(snapshot));
    expect(mutation).not.toHaveBeenCalled();
  });
});

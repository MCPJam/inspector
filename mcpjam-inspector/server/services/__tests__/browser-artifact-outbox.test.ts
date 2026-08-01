/**
 * browser-artifact-outbox — the durable, retryable hand-off that replaced
 * "drain and hope". Locks the three properties the old per-turn persister got
 * wrong: a failed write keeps its batch, a retry never re-uploads a screenshot,
 * and batches are keyed by each artifact's OWN promptIndex rather than by the
 * turn that happened to drain it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mutationMock = vi.fn();
const uploadScreenshotBlobMock = vi.fn();
const uploadVideoBlobMock = vi.fn();
// Delegates to the real serializer by default; a test overrides it to prove the
// per-artifact isolation of a SYSTEMIC serialization failure.
const serializeBrowserStepsMock = vi.fn();

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    mutation(...args: unknown[]) {
      return mutationMock(...args);
    }
  },
}));

vi.mock("../../utils/mcp-app-widget-capture.js", () => ({
  uploadScreenshotBlob: (...args: unknown[]) =>
    uploadScreenshotBlobMock(...args),
  uploadVideoBlob: (...args: unknown[]) => uploadVideoBlobMock(...args),
}));

vi.mock("../browser-artifact-serialization.js", async () => {
  const actual = await vi.importActual<
    typeof import("../browser-artifact-serialization.js")
  >("../browser-artifact-serialization.js");
  return {
    ...actual,
    serializeBrowserStepsForBackend: (...args: unknown[]) =>
      serializeBrowserStepsMock(...args),
  };
});

import { createBrowserArtifactOutbox } from "../browser-artifact-outbox.js";

/** Minimal stand-in for the browser context's drain cursor. */
function fakeBrowser(
  batches: Array<{
    observations: Array<Record<string, unknown>>;
    steps: Array<Record<string, unknown>>;
  }>,
) {
  let cursor = 0;
  return {
    drainNewArtifacts: () =>
      batches[cursor++] ?? { observations: [], steps: [] },
  } as never;
}

function observation(overrides: Record<string, unknown> = {}) {
  return {
    toolCallId: "tc-1",
    toolName: "create_view",
    serverId: "server-1",
    promptIndex: 0,
    status: "rendered",
    elapsedMs: 12,
    ts: 100,
    screenshotBase64: "iVBORw0KGgo=",
    ...overrides,
  };
}

function step(overrides: Record<string, unknown> = {}) {
  return {
    toolCallId: "tc-1",
    stepIndex: 0,
    promptIndex: 0,
    action: "left_click",
    elapsedMs: 8,
    ts: 101,
    screenshotBase64: "iVBORw0KGgo=",
    ...overrides,
  };
}

function makeOutbox() {
  return createBrowserArtifactOutbox({
    chatSessionId: "swarm_run-1_target-1_0",
    convexAuthToken: "token",
    logScope: "test",
  });
}

beforeEach(async () => {
  // `vi.mock` above intercepts every importer, including this file — so reach
  // for the genuine implementation explicitly and make it the default.
  const actual = await vi.importActual<
    typeof import("../browser-artifact-serialization.js")
  >("../browser-artifact-serialization.js");
  vi.stubEnv("CONVEX_URL", "https://example.convex.cloud");
  mutationMock.mockReset().mockResolvedValue({ observations: 1, steps: 1 });
  uploadScreenshotBlobMock.mockReset().mockResolvedValue("blob-1");
  uploadVideoBlobMock.mockReset().mockResolvedValue("video-1");
  serializeBrowserStepsMock
    .mockReset()
    .mockImplementation(actual.serializeBrowserStepsForBackend);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createBrowserArtifactOutbox", () => {
  it("writes a taken batch without a chatbox (the swarm auth branch)", async () => {
    const outbox = makeOutbox();
    outbox.take(fakeBrowser([{ observations: [observation()], steps: [step()] }]), 0);

    const result = await outbox.flush();

    expect(result).toMatchObject({ written: 1, pending: 0 });
    expect(mutationMock).toHaveBeenCalledTimes(1);
    const [name, args] = mutationMock.mock.calls[0]! as [string, any];
    expect(name).toBe("chatSessions:recordBrowserArtifacts");
    // No chatboxId/accessVersion ⇒ the mutation authorizes the session owner.
    expect(args.chatboxId).toBeUndefined();
    expect(args.accessVersion).toBeUndefined();
    expect(args.chatSessionId).toBe("swarm_run-1_target-1_0");
    expect(args.promptIndex).toBe(0);
    // Screenshots are uploaded, and the transient base64 never reaches the wire.
    expect(args.widgetRenderObservations[0]).toMatchObject({
      screenshotBlobId: "blob-1",
    });
    expect(args.widgetRenderObservations[0].screenshotBase64).toBeUndefined();
    // The row-level promptIndex is stripped — the mutation stamps the batch one.
    expect(args.widgetRenderObservations[0].promptIndex).toBeUndefined();
    expect(args.browserInteractionSteps[0].promptIndex).toBeUndefined();
  });

  it("keeps a batch whose write threw, and retries it without re-uploading", async () => {
    const outbox = makeOutbox();
    outbox.take(fakeBrowser([{ observations: [observation()], steps: [] }]), 0);

    mutationMock.mockRejectedValueOnce(new Error("boom"));
    const failed = await outbox.flush();
    expect(failed).toMatchObject({ written: 0, pending: 1 });

    mutationMock.mockResolvedValueOnce({ observations: 1, steps: 0 });
    const retried = await outbox.flush();
    expect(retried).toMatchObject({ written: 1, pending: 0 });

    // The whole point: the screenshot was uploaded ONCE across both attempts.
    expect(uploadScreenshotBlobMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a batch the mutation returned null for (the /ingest-chat race)", async () => {
    const outbox = makeOutbox();
    outbox.take(fakeBrowser([{ observations: [observation()], steps: [] }]), 0);

    // `null` means "session row not written yet" — retryable, not a failure.
    mutationMock.mockResolvedValueOnce(null);
    expect(await outbox.flush()).toMatchObject({ written: 0, pending: 1 });

    mutationMock.mockResolvedValueOnce({ observations: 1, steps: 0 });
    expect(await outbox.flush()).toMatchObject({ written: 1, pending: 0 });
    expect(uploadScreenshotBlobMock).toHaveBeenCalledTimes(1);
  });

  it("groups by each artifact's own promptIndex, not the draining turn", async () => {
    const outbox = makeOutbox();
    // A turn-3 drain that sweeps up a turn-0 artifact (the exact
    // misattribution the batch-level promptIndex would otherwise cause).
    outbox.take(
      fakeBrowser([
        {
          observations: [observation({ promptIndex: 0, toolCallId: "early" })],
          steps: [step({ promptIndex: 3, toolCallId: "late" })],
        },
      ]),
      3,
    );

    await outbox.flush();

    const byPromptIndex = mutationMock.mock.calls
      .map(([, args]) => args as any)
      .sort((a, b) => a.promptIndex - b.promptIndex);
    expect(byPromptIndex).toHaveLength(2);
    expect(byPromptIndex[0].promptIndex).toBe(0);
    expect(byPromptIndex[0].widgetRenderObservations[0].toolCallId).toBe(
      "early",
    );
    expect(byPromptIndex[1].promptIndex).toBe(3);
    expect(byPromptIndex[1].browserInteractionSteps[0].toolCallId).toBe("late");
  });

  it("falls back to the draining turn for an unstamped artifact", async () => {
    const outbox = makeOutbox();
    outbox.take(
      fakeBrowser([
        { observations: [observation({ promptIndex: undefined })], steps: [] },
      ]),
      7,
    );
    await outbox.flush();
    expect((mutationMock.mock.calls[0]![1] as any).promptIndex).toBe(7);
  });

  it("rides the staged video on the first artifact write", async () => {
    const outbox = makeOutbox();
    outbox.take(fakeBrowser([{ observations: [observation()], steps: [] }]), 0);
    await outbox.stageVideo(Buffer.from("webm-bytes"));

    const result = await outbox.flush();

    expect(result.videoAttached).toBe(true);
    expect(mutationMock).toHaveBeenCalledTimes(1);
    expect((mutationMock.mock.calls[0]![1] as any).videoBlobId).toBe("video-1");
  });

  it("attaches a video on its own when every batch already landed", async () => {
    const outbox = makeOutbox();
    outbox.take(fakeBrowser([{ observations: [observation()], steps: [] }]), 0);
    await outbox.flush();
    mutationMock.mockClear();

    // Terminal: nothing left to ride on, so the video goes video-only.
    await outbox.stageVideo(Buffer.from("webm-bytes"));
    const result = await outbox.flush();

    expect(result.videoAttached).toBe(true);
    expect(mutationMock).toHaveBeenCalledTimes(1);
    const args = mutationMock.mock.calls[0]![1] as any;
    expect(args.videoBlobId).toBe("video-1");
    expect(args.widgetRenderObservations).toBeUndefined();
    expect(args.browserInteractionSteps).toBeUndefined();
  });

  it("stages a video at most once", async () => {
    const outbox = makeOutbox();
    await outbox.stageVideo(Buffer.from("a"));
    await outbox.stageVideo(Buffer.from("b"));
    expect(uploadVideoBlobMock).toHaveBeenCalledTimes(1);
  });

  it("survives a failed video upload and still writes the artifacts", async () => {
    const outbox = makeOutbox();
    outbox.take(fakeBrowser([{ observations: [observation()], steps: [] }]), 0);
    uploadVideoBlobMock.mockRejectedValueOnce(new Error("too large"));

    await outbox.stageVideo(Buffer.from("webm-bytes"));
    const result = await outbox.flush();

    // Screenshots are the fallback the Replay UI renders when there is no video.
    expect(result).toMatchObject({ written: 1, pending: 0, videoAttached: false });
  });

  it("keeps every row when one screenshot upload fails, just without its blob", async () => {
    const outbox = makeOutbox();
    outbox.take(
      fakeBrowser([
        {
          observations: [],
          steps: [
            step({ stepIndex: 0 }),
            step({ stepIndex: 1 }),
            step({ stepIndex: 2 }),
          ],
        },
      ]),
      0,
    );
    // The shared serializers are fail-soft per screenshot: a failed upload drops
    // the blob id and KEEPS the row, because the action, verdict and timing are
    // still worth replaying without the picture.
    uploadScreenshotBlobMock
      .mockResolvedValueOnce("blob-0")
      .mockRejectedValueOnce(new Error("upload failed"))
      .mockResolvedValueOnce("blob-2");

    await outbox.flush();

    const steps = mutationMock.mock.calls
      .flatMap(([, args]) => (args as any).browserInteractionSteps ?? [])
      .sort((a: any, b: any) => a.stepIndex - b.stepIndex);
    expect(steps.map((st: any) => st.stepIndex)).toEqual([0, 1, 2]);
    expect(steps.map((st: any) => st.screenshotBlobId)).toEqual([
      "blob-0",
      undefined,
      "blob-2",
    ]);
  });

  it("keeps the artifacts behind one that could not be serialized at all", async () => {
    const outbox = makeOutbox();
    outbox.take(
      fakeBrowser([
        {
          observations: [],
          steps: [
            step({ stepIndex: 0 }),
            step({ stepIndex: 1 }),
            step({ stepIndex: 2 }),
          ],
        },
      ]),
      0,
    );
    // A SYSTEMIC serialization throw (not a screenshot failure — those are
    // absorbed above). Serialization is isolated per artifact, so the one before
    // the throw is already on the wire and the one after is still queued;
    // dropping the whole bucket here was the P1 this replaced.
    const real = serializeBrowserStepsMock.getMockImplementation()!;
    serializeBrowserStepsMock.mockImplementation(async (steps: any, client: any) => {
      if (steps?.[0]?.stepIndex === 1) throw new Error("systemic");
      return real(steps, client);
    });

    await outbox.flush();

    const stepIndexes = mutationMock.mock.calls
      .flatMap(([, args]) => (args as any).browserInteractionSteps ?? [])
      .map((st: any) => st.stepIndex)
      .sort();
    expect(stepIndexes).toEqual([0, 2]);
  });

  it("reports a video that uploaded to nothing as pending, not silently absent", async () => {
    const outbox = makeOutbox();
    outbox.take(fakeBrowser([{ observations: [observation()], steps: [] }]), 0);
    // `uploadVideoBlob` also returns undefined WITHOUT throwing.
    uploadVideoBlobMock.mockResolvedValueOnce(undefined);

    await outbox.stageVideo(Buffer.from("webm-bytes"));
    const result = await outbox.flush();

    // The artifacts still land...
    expect(result.written).toBe(1);
    // ...and nothing claims the video attached.
    expect(result.videoAttached).toBe(false);
    expect((mutationMock.mock.calls[0]![1] as any).videoBlobId).toBeUndefined();
  });

  it("counts a staged-but-unattached video as pending work", async () => {
    const outbox = makeOutbox();
    await outbox.stageVideo(Buffer.from("webm-bytes"));
    // The video-only attach fails. `pending` must say so — unlike a batch, a
    // video cannot be retried once the run is over, so a silent 0 here would
    // suppress the terminal warning about a permanently lost replay.
    mutationMock.mockRejectedValueOnce(new Error("convex down"));

    const result = await outbox.flush();
    expect(result).toMatchObject({ pending: 1, videoAttached: false });
  });

  it("degrades to no-op (never throws) without CONVEX_URL", async () => {
    vi.stubEnv("CONVEX_URL", "");
    const outbox = makeOutbox();
    outbox.take(fakeBrowser([{ observations: [observation()], steps: [] }]), 0);
    await outbox.stageVideo(Buffer.from("webm-bytes"));

    expect(await outbox.flush()).toMatchObject({ written: 0, pending: 1 });
    expect(mutationMock).not.toHaveBeenCalled();
    expect(uploadVideoBlobMock).not.toHaveBeenCalled();
  });

  it("passes the chatbox auth pair through when the surface has one", async () => {
    const outbox = createBrowserArtifactOutbox({
      chatSessionId: "synth_1",
      convexAuthToken: "token",
      chatboxId: "cb-1",
      accessVersion: 4,
      logScope: "test",
    });
    outbox.take(fakeBrowser([{ observations: [observation()], steps: [] }]), 0);
    await outbox.flush();
    expect(mutationMock.mock.calls[0]![1]).toMatchObject({
      chatboxId: "cb-1",
      accessVersion: 4,
    });
  });
});

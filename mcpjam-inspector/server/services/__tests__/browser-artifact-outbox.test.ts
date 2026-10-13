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
  it("writes a taken batch without a scenario (the swarm auth branch)", async () => {
    const outbox = makeOutbox();
    outbox.take(
      fakeBrowser([{ observations: [observation()], steps: [step()] }]),
      0,
    );

    const result = await outbox.flush();

    expect(result).toMatchObject({ written: 1, pending: 0 });
    expect(mutationMock).toHaveBeenCalledTimes(1);
    const [name, args] = mutationMock.mock.calls[0]! as [string, any];
    expect(name).toBe("chatSessions:recordBrowserArtifacts");
    // No scenarioId/accessVersion ⇒ the mutation authorizes the session owner.
    expect(args.scenarioId).toBeUndefined();
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

  it("uploads screenshots and the replay as the session's identity, scoped to its chat", async () => {
    const outbox = makeOutbox();
    outbox.take(fakeBrowser([{ observations: [observation()], steps: [] }]), 0);
    await outbox.stageVideo(Buffer.from("webm-bytes"));

    await outbox.flush();

    const uploadTarget = {
      convexAuthToken: "token",
      chatSessionId: "swarm_run-1_target-1_0",
    };
    expect(uploadScreenshotBlobMock.mock.calls[0]![0]).toEqual(uploadTarget);
    expect(uploadVideoBlobMock.mock.calls[0]![0]).toEqual(uploadTarget);
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

  it("splits a batch over the backend's per-call cap into writes it accepts", async () => {
    const outbox = makeOutbox();
    // One turn, 21 widget renders: `recordBrowserArtifacts` refuses more than
    // 20 observations in a call, and a refused batch would otherwise be
    // retried as-is on every flush, forever.
    const observations = Array.from({ length: 21 }, (_, i) =>
      observation({ toolCallId: `tc-${i}` }),
    );
    outbox.take(fakeBrowser([{ observations, steps: [] }]), 0);

    const result = await outbox.flush();

    expect(result).toMatchObject({ written: 1, pending: 0 });
    expect(mutationMock).toHaveBeenCalledTimes(2);
    const calls = mutationMock.mock.calls.map(([, args]) => args as any);
    expect(calls[0].widgetRenderObservations).toHaveLength(20);
    expect(calls[1].widgetRenderObservations).toHaveLength(1);
    expect(calls[1].widgetRenderObservations[0].toolCallId).toBe("tc-20");
    // Every chunk is stamped with the batch's own promptIndex.
    expect(calls.map((c) => c.promptIndex)).toEqual([0, 0]);
  });

  it("splits a run of interaction steps the same way", async () => {
    const outbox = makeOutbox();
    const steps = Array.from({ length: 121 }, (_, i) => step({ stepIndex: i }));
    outbox.enqueueSteps(steps as never, 0);

    const result = await outbox.flush();

    expect(result).toMatchObject({ written: 1, pending: 0 });
    expect(mutationMock).toHaveBeenCalledTimes(2);
    const calls = mutationMock.mock.calls.map(([, args]) => args as any);
    expect(calls[0].browserInteractionSteps).toHaveLength(120);
    expect(calls[1].browserInteractionSteps).toHaveLength(1);
    expect(calls[1].browserInteractionSteps[0].stepIndex).toBe(120);
  });

  it("retries only the chunk that failed, not the rows that already landed", async () => {
    const outbox = makeOutbox();
    const observations = Array.from({ length: 21 }, (_, i) =>
      observation({ toolCallId: `tc-${i}` }),
    );
    outbox.take(fakeBrowser([{ observations, steps: [] }]), 0);

    mutationMock
      .mockResolvedValueOnce({ observations: 20, steps: 0 })
      .mockRejectedValueOnce(new Error("boom"));
    expect(await outbox.flush()).toMatchObject({ written: 0, pending: 1 });

    mutationMock.mockResolvedValueOnce({ observations: 1, steps: 0 });
    expect(await outbox.flush()).toMatchObject({ written: 1, pending: 0 });

    expect(mutationMock).toHaveBeenCalledTimes(3);
    const retried = mutationMock.mock.calls[2]![1] as any;
    expect(retried.widgetRenderObservations).toHaveLength(1);
    expect(retried.widgetRenderObservations[0].toolCallId).toBe("tc-20");
    expect(uploadScreenshotBlobMock).toHaveBeenCalledTimes(21);
  });

  it("serializes overlapping flushes and retries only the failed chunk", async () => {
    const outbox = makeOutbox();
    outbox.take(
      fakeBrowser([
        {
          observations: Array.from({ length: 21 }, (_, i) =>
            observation({ toolCallId: `tc-${i}` }),
          ),
          steps: [],
        },
      ]),
      0,
    );
    let acknowledgeFirst!: (value: { observations: number; steps: number }) => void;
    const firstWrite = new Promise<{ observations: number; steps: number }>(
      (resolve) => {
        acknowledgeFirst = resolve;
      },
    );
    mutationMock
      .mockReturnValueOnce(firstWrite)
      .mockRejectedValueOnce(new Error("last chunk failed"));

    const firstFlush = outbox.flush();
    await vi.waitFor(() => expect(mutationMock).toHaveBeenCalledTimes(1));
    const secondFlush = outbox.flush();
    // Yield so an overlapping flush can reach its mutation before checking.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mutationMock).toHaveBeenCalledTimes(1);

    acknowledgeFirst({ observations: 20, steps: 0 });
    expect(await firstFlush).toMatchObject({ written: 0, pending: 1 });
    expect(await secondFlush).toMatchObject({ written: 1, pending: 0 });
    expect(
      mutationMock.mock.calls.map(([, args]) =>
        args.widgetRenderObservations.map(
          (row: { toolCallId: string }) => row.toolCallId,
        ),
      ),
    ).toEqual([
      Array.from({ length: 20 }, (_, i) => `tc-${i}`),
      ["tc-20"],
      ["tc-20"],
    ]);
    expect(uploadScreenshotBlobMock).toHaveBeenCalledTimes(21);
  });

  it("queues a flush during serialization without re-uploading or losing new steps", async () => {
    const outbox = makeOutbox();
    outbox.enqueueSteps([step({ stepIndex: 0 })] as never, 0);
    let finishUpload!: (blobId: string) => void;
    const firstUpload = new Promise<string>((resolve) => {
      finishUpload = resolve;
    });
    uploadScreenshotBlobMock.mockReturnValueOnce(firstUpload);

    const firstFlush = outbox.flush();
    await vi.waitFor(() =>
      expect(uploadScreenshotBlobMock).toHaveBeenCalledTimes(1),
    );
    const secondFlush = outbox.flush();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(uploadScreenshotBlobMock).toHaveBeenCalledTimes(1);

    outbox.enqueueSteps([step({ stepIndex: 1, promptIndex: 1 })] as never, 1);
    finishUpload("blob-0");
    await Promise.all([firstFlush, secondFlush]);

    expect(uploadScreenshotBlobMock).toHaveBeenCalledTimes(2);
    expect(
      mutationMock.mock.calls.map(([, args]) => ({
        promptIndex: args.promptIndex,
        stepIndexes: args.browserInteractionSteps.map(
          (row: { stepIndex: number }) => row.stepIndex,
        ),
      })),
    ).toEqual([
      { promptIndex: 0, stepIndexes: [0] },
      { promptIndex: 1, stepIndexes: [1] },
    ]);
    expect(outbox.pendingBatchCount).toBe(0);
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

  it("carries the container and the recording's own numbers", async () => {
    // A hosted daemon's MP4 must reach Convex as an MP4 — it serves back
    // exactly the type the bytes were posted with, and an mp4 announced as
    // webm plays nowhere. The metadata rides the SAME write as the blob: on
    // its own it would render a duration and an fps under an empty player.
    const outbox = makeOutbox();
    const meta = {
      source: "hosted" as const,
      fps: 15,
      durationMs: 9_000,
      distinctFrames: 42,
      truncated: true,
    };

    await outbox.stageVideo(Buffer.from("mp4-bytes"), {
      mime: "video/mp4",
      meta,
    });
    await outbox.flush();

    expect(uploadVideoBlobMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { contentType: "video/mp4" },
    );
    const args = mutationMock.mock.calls[0]![1] as any;
    expect(args.videoBlobId).toBe("video-1");
    expect(args.videoMeta).toEqual(meta);
  });

  it("rides the metadata along with an artifact write too", async () => {
    const outbox = makeOutbox();
    outbox.take(fakeBrowser([{ observations: [observation()], steps: [] }]), 0);
    await outbox.stageVideo(Buffer.from("mp4-bytes"), {
      mime: "video/mp4",
      meta: { source: "hosted", fps: 15 },
    });

    await outbox.flush();

    const args = mutationMock.mock.calls[0]![1] as any;
    expect(args.videoMeta).toEqual({ source: "hosted", fps: 15 });
  });

  it("sends no metadata when the upload produced no blob", async () => {
    const outbox = makeOutbox();
    outbox.take(fakeBrowser([{ observations: [observation()], steps: [] }]), 0);
    uploadVideoBlobMock.mockResolvedValueOnce(undefined);

    await outbox.stageVideo(Buffer.from("mp4-bytes"), {
      mime: "video/mp4",
      meta: { source: "hosted", fps: 15 },
    });
    await outbox.flush();

    const args = mutationMock.mock.calls[0]![1] as any;
    expect(args.videoBlobId).toBeUndefined();
    expect(args.videoMeta).toBeUndefined();
  });

  it("keeps the webm default for a caller that names no container", async () => {
    const outbox = makeOutbox();
    await outbox.stageVideo(Buffer.from("webm-bytes"));
    expect(uploadVideoBlobMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {},
    );
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
    expect(result).toMatchObject({
      written: 1,
      pending: 0,
      videoAttached: false,
    });
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
    serializeBrowserStepsMock.mockImplementation(
      async (steps: any, client: any) => {
        if (steps?.[0]?.stepIndex === 1) throw new Error("systemic");
        return real(steps, client);
      },
    );

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

  it("passes the scenario auth pair through when the surface has one", async () => {
    const outbox = createBrowserArtifactOutbox({
      chatSessionId: "synth_1",
      convexAuthToken: "token",
      scenarioId: "cb-1",
      accessVersion: 4,
      logScope: "test",
    });
    outbox.take(fakeBrowser([{ observations: [observation()], steps: [] }]), 0);
    await outbox.stageVideo(Buffer.from("webm-bytes"));
    await outbox.flush();
    expect(mutationMock.mock.calls[0]![1]).toMatchObject({
      scenarioId: "cb-1",
      accessVersion: 4,
    });
    // The uploads carry the same pair.
    const uploadTarget = {
      convexAuthToken: "token",
      chatSessionId: "synth_1",
      scenarioId: "cb-1",
      accessVersion: 4,
    };
    expect(uploadScreenshotBlobMock.mock.calls[0]![0]).toEqual(uploadTarget);
    expect(uploadVideoBlobMock.mock.calls[0]![0]).toEqual(uploadTarget);
  });
});

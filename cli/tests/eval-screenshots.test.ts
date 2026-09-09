import assert from "node:assert/strict";
import { test } from "node:test";

import {
  describeIterationVideo,
  extractIterationVideoMeta,
  extractIterationVideoUrl,
  extractRenderedScreenshots,
  iterationVideoExtension,
  screenshotFilename,
} from "../src/lib/eval-screenshots.js";

const traceResult = {
  project: { id: "p1" },
  runId: "r1",
  iterationId: "i1",
  trace: {
    widgetRenderObservations: [
      {
        status: "rendered",
        screenshotUrl: "https://example.com/a.png",
        toolName: "create_view",
        toolCallId: "call_1",
        promptIndex: 0,
      },
      // skipped render → no image, dropped
      { status: "skipped", toolName: "create_view" },
      // rendered but missing URL → dropped
      { status: "rendered", toolName: "create_view" },
    ],
  },
};

test("extracts only rendered observations that carry a screenshot URL", () => {
  const shots = extractRenderedScreenshots(traceResult);
  assert.equal(shots.length, 1);
  assert.deepEqual(shots[0], {
    status: "rendered",
    screenshotUrl: "https://example.com/a.png",
    toolName: "create_view",
    toolCallId: "call_1",
    promptIndex: 0,
  });
});

test("accepts a bare trace object as well as the full operation result", () => {
  const shots = extractRenderedScreenshots(traceResult.trace);
  assert.equal(shots.length, 1);
  assert.equal(shots[0].screenshotUrl, "https://example.com/a.png");
});

test("returns an empty list for malformed or empty traces", () => {
  assert.deepEqual(extractRenderedScreenshots(null), []);
  assert.deepEqual(extractRenderedScreenshots({}), []);
  assert.deepEqual(
    extractRenderedScreenshots({ trace: { widgetRenderObservations: "nope" } }),
    [],
  );
});

test("builds collision-safe, sanitized filenames", () => {
  assert.equal(
    screenshotFilename(
      { status: "rendered", screenshotUrl: "x", toolName: "create_view", toolCallId: "call_1" },
      0,
    ),
    "create_view-call_1.png",
  );
  // No toolCallId → fall back to the 1-based index.
  assert.equal(
    screenshotFilename(
      { status: "rendered", screenshotUrl: "x", toolName: "create/view" },
      2,
    ),
    "create-view-3.png",
  );
  // No toolName → "widget".
  assert.equal(
    screenshotFilename({ status: "rendered", screenshotUrl: "x", toolCallId: "../etc" }, 0),
    "widget--etc.png",
  );
});

test("also extracts per-step browserInteractionSteps screenshots", () => {
  const result = {
    trace: {
      widgetRenderObservations: [
        {
          status: "rendered",
          screenshotUrl: "https://example.com/render.png",
          toolName: "create_view",
          toolCallId: "call_1",
        },
      ],
      browserInteractionSteps: [
        {
          screenshotUrl: "https://example.com/click.png",
          action: "click",
          locatorLabel: "Add to cart",
          toolCallId: "call_2",
          promptIndex: 0,
        },
        {
          screenshotUrl: "https://example.com/assert.png",
          action: "screenshot",
          assertion: { passed: false, reason: "missing" },
          toolCallId: "call_3",
        },
        // No screenshot URL → dropped.
        { action: "click", locatorLabel: "nope" },
      ],
    },
  };
  const shots = extractRenderedScreenshots(result);
  assert.equal(shots.length, 3);
  // Render observation first, then interaction steps in order.
  assert.equal(shots[0].screenshotUrl, "https://example.com/render.png");
  assert.deepEqual(
    { url: shots[1].screenshotUrl, status: shots[1].status, label: shots[1].toolName },
    { url: "https://example.com/click.png", status: "click", label: "Add to cart" },
  );
  assert.deepEqual(
    { url: shots[2].screenshotUrl, status: shots[2].status },
    { url: "https://example.com/assert.png", status: "assert:failed" },
  );
});

test("extractIterationVideoUrl reads the resolved video URL (or undefined)", () => {
  assert.equal(
    extractIterationVideoUrl({ trace: { videoUrl: "https://example.com/run.webm" } }),
    "https://example.com/run.webm",
  );
  // Bare trace object works too.
  assert.equal(
    extractIterationVideoUrl({ videoUrl: "https://example.com/run.webm" }),
    "https://example.com/run.webm",
  );
  assert.equal(extractIterationVideoUrl({ trace: {} }), undefined);
  assert.equal(extractIterationVideoUrl(null), undefined);
});

test("extractIterationVideoMeta reads only what the recording reported", () => {
  assert.deepEqual(
    extractIterationVideoMeta({
      trace: {
        videoMeta: {
          source: "hosted",
          fps: 15,
          durationMs: 9000,
          distinctFrames: 42,
          truncated: true,
        },
      },
    }),
    {
      source: "hosted",
      fps: 15,
      durationMs: 9000,
      distinctFrames: 42,
      truncated: true,
    },
  );
  // A partially-shaped answer yields the fields it does carry, not nothing:
  // the payload is server-defined and reaches the CLI untyped.
  assert.deepEqual(
    extractIterationVideoMeta({ trace: { videoMeta: { source: "widget" } } }),
    { source: "widget" },
  );
  assert.deepEqual(
    extractIterationVideoMeta({
      trace: { videoMeta: { fps: "fast", durationMs: null } },
    }),
    undefined,
  );
  // Every trace written before recordings reported anything.
  assert.equal(extractIterationVideoMeta({ trace: {} }), undefined);
  assert.equal(extractIterationVideoMeta(null), undefined);
});

test("iterationVideoExtension follows the recorder, and defaults to webm", () => {
  // The URL is a Convex storage link and carries no extension, so `source` is
  // what there is to go on. A file named for the wrong container is one a
  // player refuses before reading a byte.
  assert.equal(iterationVideoExtension({ source: "hosted" }), "mp4");
  assert.equal(iterationVideoExtension({ source: "widget" }), "webm");
  // Everything that predates a second recorder is a `.webm`.
  assert.equal(iterationVideoExtension(undefined), "webm");
  assert.equal(iterationVideoExtension({ source: "something-new" }), "webm");
});

test("describeIterationVideo derives nothing, and says truncated loudly", () => {
  assert.equal(describeIterationVideo(undefined), "");
  assert.equal(describeIterationVideo({ source: "widget" }), "");
  assert.equal(
    describeIterationVideo({ source: "hosted", durationMs: 9000, fps: 15 }),
    "9s · 15fps",
  );
  // A take that stopped at its size cap is a complete, playable PREFIX of the
  // run — and reads as the whole run unless this says otherwise.
  assert.match(
    describeIterationVideo({
      source: "hosted",
      durationMs: 600000,
      distinctFrames: 12,
      truncated: true,
    }),
    /STOPPED AT THE SIZE LIMIT/,
  );
  // A zero duration is "unknown", not "an instant".
  assert.equal(describeIterationVideo({ source: "hosted", durationMs: 0 }), "");
});

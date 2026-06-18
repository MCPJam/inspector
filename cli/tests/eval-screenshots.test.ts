import assert from "node:assert/strict";
import { test } from "node:test";

import {
  extractRenderedScreenshots,
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

import { afterEach, describe, expect, test, vi } from "vitest";
import type { ConvexHttpClient } from "convex/browser";
import type {
  RunnerBrowserInteractionStep,
  RunnerWidgetRenderObservation,
} from "@/shared/eval-trace";

// Mock the upload helper so the serializers never hit Convex storage. Use
// vi.hoisted so the spy exists when vi.mock's factory runs (hoisted above imports).
const { uploadScreenshotBlob } = vi.hoisted(() => ({
  uploadScreenshotBlob: vi.fn(),
}));
vi.mock("../../../utils/mcp-app-widget-capture.js", () => ({
  uploadScreenshotBlob,
}));

import {
  serializeBrowserStepsForBackend,
  serializeRenderObservationsForBackend,
  toBrowserStepPayload,
  toObservationPayload,
} from "../finalize-iteration-browser-artifacts.js";

const client = {} as ConvexHttpClient;

const makeObs = (
  overrides: Partial<RunnerWidgetRenderObservation> = {},
): RunnerWidgetRenderObservation => ({
  toolCallId: "tc-0",
  toolName: "create_view",
  serverId: "excalidraw",
  status: "rendered",
  screenshotBase64: "c2hvdA==",
  elapsedMs: 5,
  ts: 1,
  promptIndex: 0,
  ...overrides,
});

const makeStep = (
  overrides: Partial<RunnerBrowserInteractionStep> = {},
): RunnerBrowserInteractionStep => ({
  toolCallId: "tc-0",
  stepIndex: 0,
  promptIndex: 0,
  action: "left_click",
  coordinateX: 1,
  coordinateY: 2,
  screenshotBase64: "c2hvdA==",
  elapsedMs: 3,
  ts: 1,
  ...overrides,
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("serializeRenderObservationsForBackend", () => {
  test("returns [] for empty/undefined input without uploading", async () => {
    expect(
      await serializeRenderObservationsForBackend(undefined, client),
    ).toEqual([]);
    expect(await serializeRenderObservationsForBackend([], client)).toEqual([]);
    expect(uploadScreenshotBlob).not.toHaveBeenCalled();
  });

  test("uploads one screenshot per row and swaps base64 → screenshotBlobId", async () => {
    uploadScreenshotBlob.mockResolvedValue("blob-xyz");

    const out = await serializeRenderObservationsForBackend(
      [makeObs(), makeObs({ toolCallId: "tc-1", promptIndex: 1 })],
      client,
    );

    expect(uploadScreenshotBlob).toHaveBeenCalledTimes(2);
    expect(uploadScreenshotBlob).toHaveBeenCalledWith(client, "c2hvdA==");
    expect(out).toHaveLength(2);
    expect(out[0]!.screenshotBlobId).toBe("blob-xyz");
    expect(out[0]).not.toHaveProperty("screenshotBase64");
    // promptIndex retained for per-turn bucketing in the fanout.
    expect(out[0]!.promptIndex).toBe(0);
    expect(out[1]!.promptIndex).toBe(1);
  });

  test("never uploads when a row has no screenshot", async () => {
    const out = await serializeRenderObservationsForBackend(
      [makeObs({ screenshotBase64: undefined, status: "no_ui_resource" })],
      client,
    );
    expect(uploadScreenshotBlob).not.toHaveBeenCalled();
    expect(out[0]).not.toHaveProperty("screenshotBlobId");
    expect(out[0]!.status).toBe("no_ui_resource");
  });

  test("drops screenshotBlobId but KEEPS the row when upload throws", async () => {
    uploadScreenshotBlob.mockRejectedValue(new Error("convex down"));

    const out = await serializeRenderObservationsForBackend(
      [makeObs({ consoleErrors: ["boom"] })],
      client,
    );

    expect(out).toHaveLength(1);
    expect(out[0]).not.toHaveProperty("screenshotBlobId");
    // Status / diagnostics stay useful for replay even without the image.
    expect(out[0]!.status).toBe("rendered");
    expect(out[0]!.consoleErrors).toEqual(["boom"]);
  });
});

describe("serializeBrowserStepsForBackend", () => {
  test("returns [] for empty/undefined input without uploading", async () => {
    expect(await serializeBrowserStepsForBackend(undefined, client)).toEqual([]);
    expect(await serializeBrowserStepsForBackend([], client)).toEqual([]);
    expect(uploadScreenshotBlob).not.toHaveBeenCalled();
  });

  test("uploads one screenshot per step and swaps base64 → screenshotBlobId", async () => {
    uploadScreenshotBlob.mockResolvedValue("blob-step");

    const out = await serializeBrowserStepsForBackend(
      [makeStep(), makeStep({ stepIndex: 1 })],
      client,
    );

    expect(uploadScreenshotBlob).toHaveBeenCalledTimes(2);
    expect(out[0]!.screenshotBlobId).toBe("blob-step");
    expect(out[0]).not.toHaveProperty("screenshotBase64");
  });

  test("sanitizes $-prefixed keys inside widgetToolCalls[].args", async () => {
    uploadScreenshotBlob.mockResolvedValue(undefined);

    const out = await serializeBrowserStepsForBackend(
      [
        makeStep({
          screenshotBase64: undefined,
          widgetToolCalls: [
            {
              name: "reserve",
              // A JSON-Schema-shaped arg — `$ref` would be rejected by Convex's
              // validator and collapse the whole appendEvalTurnTrace call.
              args: { $ref: "#/x", nested: { $schema: "s" } },
              ok: true,
              elapsedMs: 2,
            },
          ],
        }),
      ],
      client,
    );

    const args = out[0]!.widgetToolCalls![0]!.args as Record<string, unknown>;
    expect(args.$ref).toBeUndefined();
    expect(args.__convexReserved__ref).toBe("#/x");
    expect((args.nested as Record<string, unknown>).$schema).toBeUndefined();
    expect((args.nested as Record<string, unknown>).__convexReserved__schema).toBe(
      "s",
    );
  });
});

describe("payload converters", () => {
  test("toObservationPayload strips promptIndex, keeps the rest", () => {
    const payload = toObservationPayload({
      toolCallId: "tc-0",
      toolName: "create_view",
      serverId: "excalidraw",
      status: "rendered",
      screenshotBlobId: "blob",
      elapsedMs: 5,
      ts: 1,
      promptIndex: 3,
    });
    expect(payload).not.toHaveProperty("promptIndex");
    expect(payload.screenshotBlobId).toBe("blob");
    expect(payload.status).toBe("rendered");
  });

  test("toBrowserStepPayload strips promptIndex, keeps the rest", () => {
    const payload = toBrowserStepPayload({
      toolCallId: "tc-0",
      stepIndex: 2,
      promptIndex: 3,
      action: "scroll",
      elapsedMs: 3,
      ts: 1,
    });
    expect(payload).not.toHaveProperty("promptIndex");
    expect(payload.stepIndex).toBe(2);
    expect(payload.action).toBe("scroll");
  });
});

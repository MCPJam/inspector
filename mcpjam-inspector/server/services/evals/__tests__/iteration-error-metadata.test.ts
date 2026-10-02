import { describe, expect, test } from "vitest";
import { buildIterationErrorMetadata } from "../iteration-error-metadata";

describe("compact error metadata", () => {
  test("keeps distinct tool messages without declaring a completed rejection stopped", () => {
    const value = buildIterationErrorMetadata({
      status: "completed",
      toolErrors: [
        { kind: "tool-error", message: "Missing filterId" },
        { kind: "tool-error", message: "Missing filterId" },
        { kind: "protocol-error", message: "Invalid request" },
      ],
    });
    expect(value.evalErrors).toEqual([
      { reason: "toolError", message: "Missing filterId" },
      { reason: "protocolError", message: "Invalid request" },
    ]);
    expect(value.evalExecutionFailure).toBeUndefined();
  });
  test("records fatal model errors even if lifecycle is completed", () => {
    expect(
      buildIterationErrorMetadata({
        status: "completed",
        error: "Provider unavailable",
        stepError: { source: "model", code: "provider_unavailable" },
      }),
    ).toMatchObject({
      evalErrors: [
        { reason: "providerError", message: "Provider unavailable" },
      ],
      evalExecutionFailure: {
        phase: "execution",
        reason: "provider_unavailable",
      },
    });
  });
  test.each(["cancelled", "skipped"])(
    "does not report %s as stopped",
    (status) => {
      expect(
        buildIterationErrorMetadata({ status, error: "Stopped" })
          .evalExecutionFailure,
      ).toBeUndefined();
    },
  );
  test("records setup failure after acceptance", () => {
    expect(
      buildIterationErrorMetadata({
        status: "setup_failed",
        error: "Connection closed",
      }).evalExecutionFailure,
    ).toEqual({ phase: "setup", reason: "execution_stopped" });
  });
});

test("persists and sanitizes messages that were previously only in the trace", () => {
  const value = buildIterationErrorMetadata({
    status: "completed",
    messages: [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "find_records",
            output: {
              type: "json",
              value: {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: "Missing filterId. client_secret=private123",
                  },
                ],
              },
            },
          },
        ],
      },
    ],
  });
  expect(value.evalErrors).toEqual([
    {
      reason: "toolError",
      message: "Missing filterId. client_secret=[REDACTED]",
    },
  ]);
  expect(JSON.stringify(value)).not.toContain("private123");
});

test("keeps errors recorded by widget interactions and failed renders", () => {
  const value = buildIterationErrorMetadata({
    status: "completed",
    browserInteractionSteps: [
      {
        widgetToolCalls: [
          { name: "find_records", ok: false, error: "Record unavailable" },
        ],
      },
    ] as never,
    widgetRenderObservations: [
      {
        status: "render_error",
        consoleErrors: ["Widget could not read record"],
      },
    ] as never,
  });
  expect(value.evalErrors).toEqual([
    { reason: "renderFailed", message: "Widget could not read record" },
    { reason: "protocolError", message: "Record unavailable" },
  ]);
  expect(value.evalExecutionFailure).toBeUndefined();
});

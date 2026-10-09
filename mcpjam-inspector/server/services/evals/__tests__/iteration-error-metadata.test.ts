import { describe, expect, test } from "vitest";
import { attachAuthChallenge, parseChallengeHeader } from "@mcpjam/sdk";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import { buildIterationErrorMetadata } from "../iteration-error-metadata";
import {
  annotateToolAuthChallenge,
  classifyToolAuthChallenge,
  TOOL_AUTH_CHALLENGES_METADATA_KEY,
} from "../run-setup-signals";

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

describe("a tool step that hit a sign-in challenge", () => {
  const HEADER =
    'Bearer error="invalid_token", resource_metadata="https://x.example/.well-known/oauth-protected-resource", scope="orders:read"';

  function challengedSpan() {
    const refused = Object.assign(
      new Error(
        `Error POSTing to endpoint (HTTP 401): unauthorized\nWWW-Authenticate: ${HEADER}`,
      ),
      { status: 401 },
    );
    attachAuthChallenge(refused, parseChallengeHeader(HEADER));
    const span: EvalTraceSpan = {
      id: "tool-call-1",
      name: "list_orders",
      category: "tool",
      startMs: 0,
      endMs: 1,
      toolCallId: "call-1",
      toolName: "list_orders",
      serverId: "orders",
      status: "error",
    };
    annotateToolAuthChallenge(span, {
      ...classifyToolAuthChallenge(
        { error: refused },
        { serverId: "orders", toolName: "list_orders" },
      )!,
      toolCallId: "call-1",
      toolName: "list_orders",
      serverId: "orders",
      spanId: span.id,
      promptIndex: 0,
    });
    return { span, refused };
  }

  test("reports the classification and remediation instead of the raw refusal, and records the challenge", () => {
    const { span, refused } = challengedSpan();
    const value = buildIterationErrorMetadata({
      status: "completed",
      spans: [span],
      messages: [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "list_orders",
              output: { type: "error-text", value: refused.message },
            },
          ],
        },
      ] as never,
    });
    expect(value.evalErrors).toEqual([
      {
        reason: "protocolError",
        message: expect.stringMatching(
          /^"orders": asked for sign-in when "list_orders" was called \(invalid_token; scope "orders:read"\) Connect this server with OAuth in the eval environment/,
        ),
      },
    ]);
    expect(value[TOOL_AUTH_CHALLENGES_METADATA_KEY]).toEqual([
      expect.objectContaining({
        setupFailureSource: "authorization_required",
        attribution: "ours",
        toolCallId: "call-1",
        spanId: "tool-call-1",
        authChallenge: expect.objectContaining({
          source: "http_401",
          requiredScope: "orders:read",
        }),
      }),
    ]);
    // A completed iteration is not declared stopped by it.
    expect(value.evalExecutionFailure).toBeUndefined();
  });

  test("files a pinned call's annotated error record the same way", () => {
    const toolError = {
      toolName: "list_orders",
      kind: "content-error",
      message: "Sign in required.",
    };
    annotateToolAuthChallenge(toolError, {
      ...classifyToolAuthChallenge({
        result: {
          isError: true,
          _meta: { "mcp/www_authenticate": HEADER },
        },
      })!,
      toolCallId: "pinned-0-1",
    });
    const value = buildIterationErrorMetadata({
      status: "completed",
      toolErrors: [toolError],
    });
    expect(value.evalErrors).toEqual([
      {
        reason: "toolError",
        message: expect.stringContaining("asked for sign-in"),
      },
    ]);
    expect(value[TOOL_AUTH_CHALLENGES_METADATA_KEY]).toHaveLength(1);
  });

  test("adds nothing when no tool step was challenged", () => {
    expect(
      buildIterationErrorMetadata({ status: "completed", spans: [] }),
    ).not.toHaveProperty(TOOL_AUTH_CHALLENGES_METADATA_KEY);
  });
});

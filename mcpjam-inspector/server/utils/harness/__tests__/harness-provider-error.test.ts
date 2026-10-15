import { describe, expect, it } from "vitest";
import {
  HarnessInfraSetupError,
  codexProviderEvidenceFromNotification,
  harnessFailureEvidenceOf,
  harnessFailureMessageOf,
} from "../harness-provider-error";
import { providerCallEvidenceOf } from "../../infra-failure-evidence";

describe("harnessFailureEvidenceOf", () => {
  it("reads a typed setup error's source and fields", () => {
    const error = new HarnessInfraSetupError("box gone", {
      source: "sandbox_setup",
      code: "harness_sandbox_unavailable",
      httpStatus: 404,
    });
    expect(harnessFailureEvidenceOf(error)).toEqual({
      source: "sandbox_setup",
      code: "harness_sandbox_unavailable",
      httpStatus: 404,
    });
  });

  it("reads a bridge's typed provider error (a plain object over the wire)", () => {
    expect(
      harnessFailureEvidenceOf({
        name: "HarnessProviderError",
        message: "API Error: 529",
        source: "model",
        code: "claude_code_server_error",
        httpStatus: 529,
      }),
    ).toEqual({
      source: "harness_runtime",
      code: "claude_code_server_error",
      httpStatus: 529,
    });
  });

  it("returns nothing for untyped errors, whatever they say or carry", () => {
    expect(
      harnessFailureEvidenceOf(new Error("HTTP 503 overloaded")),
    ).toBeUndefined();
    expect(harnessFailureEvidenceOf("rate limit exceeded")).toBeUndefined();
    // An MCP tool / server error with a status is NOT trusted evidence.
    expect(
      harnessFailureEvidenceOf({ name: "McpError", statusCode: 503 }),
    ).toBeUndefined();
    // A spoofed wire object with the wrong source is not trusted either.
    expect(
      harnessFailureEvidenceOf({
        name: "HarnessProviderError",
        message: "x",
        source: "tool",
        httpStatus: 503,
      }),
    ).toBeUndefined();
    // The hosted turn never reads an AI SDK call error as harness evidence.
    expect(
      harnessFailureEvidenceOf({ name: "AI_APICallError", statusCode: 503 }),
    ).toBeUndefined();
  });

  it("formats a wire object's message instead of [object Object]", () => {
    expect(
      harnessFailureMessageOf({
        name: "HarnessProviderError",
        message: "API Error: overloaded",
        source: "model",
      }),
    ).toBe("API Error: overloaded");
    expect(harnessFailureMessageOf(new Error("boom"))).toBe("boom");
    expect(harnessFailureMessageOf("plain")).toBe("plain");
  });
});

describe("providerCallEvidenceOf", () => {
  it("reads an AI SDK APICallError, directly or through RetryError", () => {
    const apiCallError = {
      name: "AI_APICallError",
      message: "Service Unavailable",
      statusCode: 503,
      isRetryable: true,
    };
    expect(providerCallEvidenceOf(apiCallError)).toEqual({
      source: "provider_call",
      httpStatus: 503,
    });
    expect(
      providerCallEvidenceOf({
        name: "AI_RetryError",
        message: "Failed after 3 attempts",
        lastError: apiCallError,
      }),
    ).toEqual({ source: "provider_call", httpStatus: 503 });
  });

  it("returns nothing for anything that is not the provider's typed answer", () => {
    expect(providerCallEvidenceOf(new Error("503"))).toBeUndefined();
    expect(
      providerCallEvidenceOf({ name: "McpError", statusCode: 503 }),
    ).toBeUndefined();
    expect(providerCallEvidenceOf(undefined)).toBeUndefined();
  });
});

describe("codexProviderEvidenceFromNotification", () => {
  it("types a terminal error notification with its upstream status", () => {
    expect(
      codexProviderEvidenceFromNotification({
        method: "error",
        params: {
          error: {
            message: "stream disconnected",
            codexErrorInfo: {
              responseStreamDisconnected: { httpStatusCode: 503 },
            },
          },
          willRetry: false,
          threadId: "t",
          turnId: "u",
        },
      }),
    ).toEqual({
      source: "harness_runtime",
      code: "codex_responseStreamDisconnected",
      httpStatus: 503,
    });
  });

  it("ignores an error Codex is about to retry", () => {
    expect(
      codexProviderEvidenceFromNotification({
        method: "error",
        params: {
          error: { message: "x", codexErrorInfo: "serverOverloaded" },
          willRetry: true,
        },
      }),
    ).toBeUndefined();
  });

  it("reads a failed turn/completed", () => {
    expect(
      codexProviderEvidenceFromNotification({
        method: "turn/completed",
        params: {
          turn: {
            status: "failed",
            error: { message: "x", codexErrorInfo: "unauthorized" },
          },
        },
      }),
    ).toEqual({ source: "harness_runtime", code: "codex_unauthorized" });
    expect(
      codexProviderEvidenceFromNotification({
        method: "turn/completed",
        params: { turn: { status: "completed" } },
      }),
    ).toBeUndefined();
  });

  it("leaves non-model-call variants unclassified", () => {
    for (const codexErrorInfo of [
      "sandboxError",
      "badRequest",
      "contextWindowExceeded",
      "other",
      null,
    ]) {
      expect(
        codexProviderEvidenceFromNotification({
          method: "error",
          params: { error: { message: "x", codexErrorInfo }, willRetry: false },
        }),
      ).toBeUndefined();
    }
    expect(
      codexProviderEvidenceFromNotification({
        method: "item/started",
        params: {},
      }),
    ).toBeUndefined();
  });
});

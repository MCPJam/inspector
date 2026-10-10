/**
 * Which refusal a model-call failure is, from what the provider or the MCPJam
 * model proxy actually answers — not from the status alone, which reads a
 * spend refusal as a rate limit and a rejected key as a bad request.
 */
import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import {
  classifyInferenceError,
  isTerminalRefusal,
  orgPolicyRefusalMessage,
  refusalMessage,
} from "../src/suite-file-run/inference.js";

function refused(statusCode: number, body?: unknown): APICallError {
  return new APICallError({
    message: "refused",
    url: "https://provider.example.com/v1",
    requestBodyValues: {},
    statusCode,
    ...(body !== undefined
      ? { responseBody: typeof body === "string" ? body : JSON.stringify(body) }
      : {}),
    isRetryable: statusCode === 429 || statusCode >= 500,
  });
}

describe("classifyInferenceError — the MCPJam model proxy", () => {
  it("reads its prose-only spend refusals as billing, not a rate limit", () => {
    for (const error of [
      "Spending limit reached",
      "Organization spend budget reached",
      "Spending limit reached; add credits or retry later.",
    ]) {
      expect(
        classifyInferenceError(refused(429, { ok: false, error }), "mcpjam")
      ).toBe("billing");
    }
  });

  it("still reads a real rate limit as one", () => {
    expect(
      classifyInferenceError(
        refused(429, { ok: false, error: "Lease max_in_flight" }),
        "mcpjam"
      )
    ).toBe("rateLimited");
    expect(classifyInferenceError(refused(429), "mcpjam")).toBe("rateLimited");
  });
});

describe("classifyInferenceError — providers", () => {
  it("reads a rejected key that is not a 401/403 as credentials", () => {
    // Gemini.
    expect(
      classifyInferenceError(
        refused(400, {
          error: {
            code: 400,
            message: "API key not valid. Please pass a valid API key.",
            status: "INVALID_ARGUMENT",
            details: [{ reason: "API_KEY_INVALID" }],
          },
        }),
        "byok"
      )
    ).toBe("credentials");
    // xAI.
    expect(
      classifyInferenceError(
        refused(400, {
          code: "Client specified an invalid argument",
          error:
            "Incorrect API key provided: xa***. Obtain one from the console.",
        }),
        "byok"
      )
    ).toBe("credentials");
  });

  it("reads an exhausted quota or credit balance as billing", () => {
    // OpenAI, as a 429.
    expect(
      classifyInferenceError(
        refused(429, {
          error: {
            message: "You exceeded your current quota, please check your plan.",
            type: "insufficient_quota",
            code: "insufficient_quota",
          },
        }),
        "byok"
      )
    ).toBe("billing");
    // Anthropic, as a 400.
    expect(
      classifyInferenceError(
        refused(400, {
          type: "error",
          error: {
            type: "invalid_request_error",
            message:
              "Your credit balance is too low to access the Anthropic API.",
          },
        }),
        "byok"
      )
    ).toBe("billing");
  });

  it("leaves an ordinary bad request an ordinary failure, and a 429 a rate limit", () => {
    expect(
      classifyInferenceError(
        refused(400, { error: { message: "max_tokens is too large" } }),
        "byok"
      )
    ).toBeUndefined();
    expect(classifyInferenceError(refused(429, "{}"), "byok")).toBe(
      "rateLimited"
    );
    expect(classifyInferenceError(refused(401), "byok")).toBe("credentials");
    expect(classifyInferenceError(refused(503), "byok")).toBe("unavailable");
  });

  it("does not read the proxy's prose on the BYOK rail, or a provider's on the MCPJam rail", () => {
    // A provider body that happens to say "spending limit" is the provider's.
    expect(
      classifyInferenceError(
        refused(429, { error: "Spending limit reached" }),
        "byok"
      )
    ).toBe("rateLimited");
    // MCPJam's gateway account running dry is not the caller's key to rotate.
    expect(
      classifyInferenceError(
        refused(400, { error: { message: "API key not valid." } }),
        "mcpjam"
      )
    ).toBeUndefined();
  });
});

describe("refusalMessage", () => {
  it("carries the body's prose when the SDK message lacks it", () => {
    const bare = new APICallError({
      message: "",
      url: "https://proxy.example.com",
      requestBodyValues: {},
      statusCode: 429,
      responseBody: JSON.stringify({
        ok: false,
        error: "Spending limit reached",
      }),
    });
    expect(refusalMessage(bare)).toBe("Spending limit reached");
    const generic = new APICallError({
      message: "Too Many Requests",
      url: "https://proxy.example.com",
      requestBodyValues: {},
      statusCode: 429,
      responseBody: JSON.stringify({
        ok: false,
        error: "Spending limit reached",
      }),
    });
    expect(refusalMessage(generic)).toBe(
      "Too Many Requests: Spending limit reached"
    );
  });

  it("does not repeat prose the message already carries", () => {
    const error = new APICallError({
      message: "invalid x-api-key",
      url: "https://api.anthropic.com/v1/messages",
      requestBodyValues: {},
      statusCode: 401,
      responseBody: "invalid x-api-key",
    });
    expect(refusalMessage(error)).toBe("invalid x-api-key");
    expect(refusalMessage(new Error("plain"))).toBe("plain");
  });
});

describe("classifyInferenceError — the organization AI-key policy", () => {
  it("reads the proxy's 409 policy refusal as orgPolicy, not credentials", () => {
    expect(
      classifyInferenceError(
        refused(409, {
          ok: false,
          code: "org_keys_required",
          error:
            "This organization requires its own provider keys for AI features.",
        }),
        "mcpjam"
      )
    ).toBe("orgPolicy");
  });

  it("reads a 403 policy refusal as orgPolicy, not credentials", () => {
    expect(
      classifyInferenceError(
        refused(403, {
          error: { code: "FORBIDDEN", details: { code: "org_keys_required" } },
        }),
        "mcpjam"
      )
    ).toBe("orgPolicy");
  });

  it("reads the policy's transient refusals as unavailable", () => {
    expect(
      classifyInferenceError(
        refused(409, { ok: false, code: "provider_unavailable", error: "x" }),
        "mcpjam"
      )
    ).toBe("unavailable");
  });

  it("stops the run, with a sentence that names the fix", () => {
    expect(isTerminalRefusal("orgPolicy")).toBe(true);
    const message = orgPolicyRefusalMessage("mcpjam/anthropic/claude-haiku-4.5");
    expect(message).toMatch(/requires its own provider keys/);
    expect(message).toMatch(/Choose a model from an organization provider/);
    expect(message).not.toMatch(/credential|rotate/i);
  });
});

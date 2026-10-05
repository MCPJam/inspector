import { describe, expect, it } from "vitest";
import { classifyEvalInfraError } from "../infra-error-classification";
import { resolveIterationInfraError } from "../../evals-runner";

describe("classifyEvalInfraError — our backend's codes are an allowlist", () => {
  it.each([
    ["mcpjam_rate_limit", 429, "rate_limited", "model", true],
    ["provider_rate_limit", 429, "rate_limited", "model", true],
    ["mcpjam_api_error", 401, "auth", "model", false],
    ["mcpjam_config_error", 500, "configuration", "model", false],
    ["provider_not_allowlisted", 403, "configuration", "model", false],
    ["invalid_model", 404, "configuration", "model", false],
    ["model_retired", 410, "configuration", "model", false],
    ["provider_error", 503, "provider_unavailable", "model", true],
    ["provider_overloaded", 529, "provider_unavailable", "model", true],
    ["fallback_prohibited", 502, "provider_unavailable", "model", true],
    ["fallback_prohibited", 401, "auth", "model", false],
    ["fallback_prohibited", 429, "rate_limited", "model", true],
  ] as const)(
    "%s (upstream %s) → %s",
    (code, httpStatus, cls, layer, retryable) => {
      expect(
        classifyEvalInfraError({ source: "backend_model", code, httpStatus }),
      ).toEqual({ class: cls, layer, retryable, code, httpStatus });
    },
  );

  it("files the gateway's upstream 429 as rate_limited, not as an account limit", () => {
    // `mcpjam_rate_limit` is ALSO on the account-limit list; asking that list
    // first would call a provider throttle a wallet problem.
    expect(
      classifyEvalInfraError({
        source: "backend_model",
        code: "mcpjam_rate_limit",
        httpStatus: 429,
      }),
    ).toMatchObject({ class: "rate_limited", layer: "model" });
  });

  it("agent_turn_limit is an account limit on the platform layer, never retried", () => {
    expect(
      classifyEvalInfraError({
        source: "backend_model",
        code: "agent_turn_limit",
      }),
    ).toEqual({
      class: "account_limit",
      layer: "platform",
      retryable: false,
      code: "agent_turn_limit",
    });
  });

  it("the other account and admission limits are account_limit", () => {
    for (const code of [
      "user_rate_limit",
      "billing_limit_reached",
      "spend_budget_reached",
      "platform_capacity",
      "free_tier_model_restricted",
    ]) {
      expect(
        classifyEvalInfraError({ source: "backend_model", code }),
      ).toMatchObject({ class: "account_limit", retryable: false });
    }
  });

  it("an input-size cap stays unclassified: the server's own output can trip it", () => {
    expect(
      classifyEvalInfraError({
        source: "backend_model",
        code: "guest_input_too_large",
      }),
    ).toBeUndefined();
  });

  it("unknown_error is never infra, whatever status our backend answered with", () => {
    // `/stream` answers every failure it could not categorize — a tool result
    // that broke the request included — with `unknown_error` and a bare 500.
    expect(
      classifyEvalInfraError({
        source: "backend_model",
        code: "unknown_error",
      }),
    ).toBeUndefined();
    expect(
      classifyEvalInfraError({
        source: "backend_model",
        code: "unknown_error",
        httpStatus: 500,
      }),
    ).toBeUndefined();
  });

  it("an unrecognized backend code is unclassified, and so is a status with no code", () => {
    for (const code of [
      "invalid_request",
      "policy_no_zdr_endpoint",
      "auth_required",
      "something_new",
    ]) {
      expect(
        classifyEvalInfraError({
          source: "backend_model",
          code,
          httpStatus: 503,
        }),
      ).toBeUndefined();
    }
    // No status-only fallback for our own backend.
    for (const httpStatus of [401, 429, 500, 502, 503]) {
      expect(
        classifyEvalInfraError({ source: "backend_model", httpStatus }),
      ).toBeUndefined();
    }
  });

  it("provider_overloaded and streaming_error need the upstream status that proves a provider answered", () => {
    // The backend mints both from MESSAGE TEXT when the error had no status.
    expect(
      classifyEvalInfraError({
        source: "backend_model",
        code: "provider_overloaded",
      }),
    ).toBeUndefined();
    expect(
      classifyEvalInfraError({
        source: "backend_model",
        code: "streaming_error",
      }),
    ).toBeUndefined();
    expect(
      classifyEvalInfraError({
        source: "backend_model",
        code: "streaming_error",
        httpStatus: 502,
      }),
    ).toMatchObject({ class: "provider_unavailable" });
    // A provider 4xx that happens to say "overloaded" is not an outage.
    expect(
      classifyEvalInfraError({
        source: "backend_model",
        code: "provider_overloaded",
        httpStatus: 400,
      }),
    ).toBeUndefined();
  });

  it("provider_error is infra only when the provider itself failed", () => {
    expect(
      classifyEvalInfraError({
        source: "backend_model",
        code: "provider_error",
        httpStatus: 400,
      }),
    ).toBeUndefined();
    expect(
      classifyEvalInfraError({
        source: "backend_model",
        code: "provider_error",
      }),
    ).toBeUndefined();
  });
});

describe("classifyEvalInfraError — the trusted-source gate", () => {
  it("no evidence, or evidence from no typed producer, is never classified", () => {
    expect(classifyEvalInfraError(undefined)).toBeUndefined();
    expect(classifyEvalInfraError({ source: "tool" } as never)).toBeUndefined();
  });

  it("a status the server under test returned through a tool is never infra", () => {
    // A customer's MCP server answering 401/429/503 never reaches a typed
    // producer, so the only shape it could take here is one with no source.
    for (const httpStatus of [401, 429, 503]) {
      expect(classifyEvalInfraError({ httpStatus } as never)).toBeUndefined();
      expect(
        classifyEvalInfraError({
          code: "provider_error",
          httpStatus,
        } as never),
      ).toBeUndefined();
    }
  });
});

describe("classifyEvalInfraError — a direct provider call", () => {
  it("decides by the provider's own status", () => {
    expect(
      classifyEvalInfraError({ source: "provider_call", httpStatus: 401 }),
    ).toMatchObject({ class: "auth", layer: "model", retryable: false });
    expect(
      classifyEvalInfraError({ source: "provider_call", httpStatus: 403 }),
    ).toMatchObject({ class: "auth" });
    expect(
      classifyEvalInfraError({ source: "provider_call", httpStatus: 429 }),
    ).toMatchObject({ class: "rate_limited", retryable: true });
    expect(
      classifyEvalInfraError({ source: "provider_call", httpStatus: 503 }),
    ).toMatchObject({ class: "provider_unavailable", retryable: true });
  });

  it("a request the provider rejected, or no status at all, is unclassified", () => {
    // A 400 can be a tool schema the customer's server advertised.
    expect(
      classifyEvalInfraError({ source: "provider_call", httpStatus: 400 }),
    ).toBeUndefined();
    expect(classifyEvalInfraError({ source: "provider_call" })).toBeUndefined();
  });
});

describe("classifyEvalInfraError — harness producers", () => {
  it.each([
    ["claude_code_rate_limit", 429, "rate_limited"],
    ["claude_code_server_error", 529, "provider_unavailable"],
    ["claude_code_overloaded", undefined, "provider_unavailable"],
    ["claude_code_authentication_failed", 401, "auth"],
    ["claude_code_billing_error", undefined, "account_limit"],
    ["codex_serverOverloaded", undefined, "provider_unavailable"],
    ["codex_internalServerError", undefined, "provider_unavailable"],
    ["codex_unauthorized", 401, "auth"],
    ["codex_usageLimitExceeded", undefined, "account_limit"],
  ] as const)("%s → %s", (code, httpStatus, cls) => {
    expect(
      classifyEvalInfraError({
        source: "harness_runtime",
        code,
        ...(httpStatus !== undefined ? { httpStatus } : {}),
      }),
    ).toMatchObject({ class: cls, layer: "model" });
  });

  it("Codex connection failures are decided by their upstream status", () => {
    expect(
      classifyEvalInfraError({
        source: "harness_runtime",
        code: "codex_responseTooManyFailedAttempts",
        httpStatus: 429,
      }),
    ).toMatchObject({ class: "rate_limited" });
    expect(
      classifyEvalInfraError({
        source: "harness_runtime",
        code: "codex_httpConnectionFailed",
      }),
    ).toMatchObject({ class: "provider_unavailable", retryable: true });
  });

  it("an untyped harness code is unclassified", () => {
    expect(
      classifyEvalInfraError({
        source: "harness_runtime",
        code: "claude_code_invalid_request",
        httpStatus: 503,
      }),
    ).toBeUndefined();
  });

  it("a typed sandbox setup failure is `sandbox` whatever the status", () => {
    expect(
      classifyEvalInfraError({
        source: "sandbox_setup",
        code: "harness_sandbox_unavailable",
        httpStatus: 503,
      }),
    ).toEqual({
      class: "sandbox",
      layer: "sandbox",
      retryable: true,
      code: "harness_sandbox_unavailable",
      httpStatus: 503,
    });
    expect(
      classifyEvalInfraError({
        source: "sandbox_setup",
        code: "harness_box_reservation_failed",
        httpStatus: 409,
      }),
    ).toMatchObject({ class: "sandbox", retryable: false });
  });

  it("the credential broker is a platform-layer failure; its own codes keep their meaning", () => {
    expect(
      classifyEvalInfraError({
        source: "platform_setup",
        code: "harness_broker_unavailable",
        httpStatus: 502,
      }),
    ).toMatchObject({ class: "sandbox", layer: "platform", retryable: true });
    expect(
      classifyEvalInfraError({
        source: "platform_setup",
        code: "spend_budget_reached",
        httpStatus: 429,
      }),
    ).toMatchObject({ class: "account_limit", layer: "platform" });
    // A box that is gone is the sandbox layer whoever reported it.
    expect(
      classifyEvalInfraError({
        source: "platform_setup",
        code: "sandbox_not_found",
        httpStatus: 404,
      }),
    ).toMatchObject({ class: "sandbox", layer: "sandbox", retryable: false });
    expect(
      classifyEvalInfraError({
        source: "sandbox_setup",
        code: "at_capacity",
        httpStatus: 503,
      }),
    ).toMatchObject({ class: "capacity", retryable: true });
  });
});

describe("resolveIterationInfraError", () => {
  const provider503 = {
    iterationError: "The AI provider is temporarily unavailable.",
    errorInfra: {
      source: "backend_model" as const,
      code: "provider_error",
      httpStatus: 503,
    },
  };

  it("classifies a failed iteration's typed evidence", () => {
    expect(resolveIterationInfraError(provider503)).toMatchObject({
      class: "provider_unavailable",
      httpStatus: 503,
    });
  });

  it("a turn timeout is a measured failure, never infra", () => {
    expect(
      resolveIterationInfraError({
        ...provider503,
        timeout: { clock: "turn", budgetMs: 1000, elapsedMs: 1000 },
      }),
    ).toBeUndefined();
  });

  it("an agent_turn_limit refusal is an excluded account limit, distinct from a timeout", () => {
    expect(
      resolveIterationInfraError({
        iterationError: "Too many Ask MCPJam turns in a row.",
        errorInfra: { source: "backend_model", code: "agent_turn_limit" },
      }),
    ).toMatchObject({
      class: "account_limit",
      layer: "platform",
      retryable: false,
    });
  });

  it("no iteration error, or no typed evidence, → nothing", () => {
    expect(
      resolveIterationInfraError({ errorInfra: provider503.errorInfra }),
    ).toBeUndefined();
    expect(
      resolveIterationInfraError({ iterationError: "HTTP 503 overloaded" }),
    ).toBeUndefined();
  });
});

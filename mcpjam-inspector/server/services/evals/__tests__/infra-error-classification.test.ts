import { describe, expect, it } from "vitest";
import {
  classifyEvalInfraError,
  resolveInfraClassifyMode,
  toPersistedInfraError,
} from "../infra-error-classification";
import { resolveIterationInfraError } from "../../evals-runner";

describe("classifyEvalInfraError — the code table", () => {
  it.each([
    ["provider_overloaded", 529, "provider_unavailable", true],
    ["mcpjam_rate_limit", 429, "rate_limited", true],
    ["provider_rate_limit", 429, "rate_limited", true],
    ["mcpjam_api_error", 401, "auth", false],
    ["mcpjam_config_error", 500, "configuration", false],
    ["invalid_model", 404, "configuration", false],
    ["model_retired", 410, "configuration", false],
    ["at_capacity", 503, "capacity", true],
  ] as const)("%s → %s", (code, httpStatus, cls, retryable) => {
    expect(
      classifyEvalInfraError({ layer: "model", code, httpStatus }),
    ).toMatchObject({ class: cls, retryable, code, httpStatus });
  });

  it("files the gateway's upstream 429 as rate_limited, not as an account limit", () => {
    // `mcpjam_rate_limit` is ALSO on the account-limit list; asking the retry
    // classifier first would call a provider throttle a wallet problem.
    expect(
      classifyEvalInfraError({
        layer: "model",
        code: "mcpjam_rate_limit",
        httpStatus: 429,
        retryAfterMs: 30_000,
      }),
    ).toEqual({
      class: "rate_limited",
      layer: "model",
      retryable: true,
      code: "mcpjam_rate_limit",
      httpStatus: 429,
      retryAfterMs: 30_000,
    });
  });

  it("agent_turn_limit is an account limit on the platform layer, never retried", () => {
    expect(
      classifyEvalInfraError({
        layer: "model",
        code: "agent_turn_limit",
        httpStatus: 429,
        retryAfterMs: 5_000,
      }),
    ).toMatchObject({
      class: "account_limit",
      layer: "platform",
      retryable: false,
    });
  });

  it("other account-limit codes are account_limit", () => {
    for (const code of [
      "user_rate_limit",
      "billing_limit_reached",
      "spend_budget_reached",
      "platform_capacity",
    ]) {
      expect(
        classifyEvalInfraError({ layer: "model", code, httpStatus: 429 }),
      ).toMatchObject({ class: "account_limit", retryable: false });
    }
  });

  it("provider_error is infra only at 5xx", () => {
    expect(
      classifyEvalInfraError({
        layer: "model",
        code: "provider_error",
        httpStatus: 503,
      }),
    ).toMatchObject({ class: "provider_unavailable", retryable: true });
    expect(
      classifyEvalInfraError({
        layer: "model",
        code: "provider_error",
        httpStatus: 400,
      }),
    ).toBeUndefined();
  });

  it("streaming_error is infra only when the backend called it retryable", () => {
    expect(
      classifyEvalInfraError({
        layer: "model",
        code: "streaming_error",
        isRetryable: true,
      }),
    ).toMatchObject({ class: "provider_unavailable" });
    expect(
      classifyEvalInfraError({ layer: "model", code: "streaming_error" }),
    ).toBeUndefined();
  });

  it("a bare provider 401/403 is auth", () => {
    expect(
      classifyEvalInfraError({ layer: "model", httpStatus: 401 }),
    ).toMatchObject({ class: "auth", retryable: false });
    expect(
      classifyEvalInfraError({ layer: "model", httpStatus: 403 }),
    ).toMatchObject({ class: "auth" });
  });

  it("falls back to the retry classifier with no message", () => {
    expect(
      classifyEvalInfraError({ layer: "model", httpStatus: 502 }),
    ).toMatchObject({ class: "provider_unavailable", retryable: true });
    expect(
      classifyEvalInfraError({ layer: "model", httpStatus: 429 }),
    ).toMatchObject({ class: "rate_limited" });
    // An `invalid_request` 400 can be caused by a tool schema the customer's
    // server advertised: not ours, stays a measured failure.
    expect(
      classifyEvalInfraError({
        layer: "model",
        code: "invalid_request",
        httpStatus: 400,
      }),
    ).toBeUndefined();
  });
});

describe("classifyEvalInfraError — the trusted-source gate", () => {
  it("prose-only failures are never classified", () => {
    expect(classifyEvalInfraError(undefined)).toBeUndefined();
    expect(classifyEvalInfraError({})).toBeUndefined();
    // Even a layer with NOTHING structured is not enough.
    expect(classifyEvalInfraError({ layer: "model" })).toBeUndefined();
  });

  it("a status the server under test returned (no layer) is never infra", () => {
    // A customer's MCP server answering 401/429/503 through a tool never
    // carries one of OUR layers, whatever the status or code says.
    for (const httpStatus of [401, 429, 503]) {
      expect(classifyEvalInfraError({ httpStatus })).toBeUndefined();
      expect(
        classifyEvalInfraError({ httpStatus, code: "provider_error" }),
      ).toBeUndefined();
    }
    expect(
      classifyEvalInfraError({ code: "mcpjam_rate_limit", httpStatus: 429 }),
    ).toBeUndefined();
  });
});

describe("classifyEvalInfraError — harness producers", () => {
  it("a typed sandbox failure is `sandbox` whatever the status", () => {
    expect(
      classifyEvalInfraError({
        layer: "sandbox",
        code: "harness_sandbox_unavailable",
        httpStatus: 503,
      }),
    ).toMatchObject({ class: "sandbox", layer: "sandbox", retryable: true });
    expect(
      classifyEvalInfraError({
        layer: "sandbox",
        code: "sandbox_not_found",
        httpStatus: 404,
      }),
    ).toMatchObject({ class: "sandbox", retryable: false });
    // ...not the server's 401.
    expect(
      classifyEvalInfraError({
        layer: "sandbox",
        code: "harness_box_reservation_failed",
        httpStatus: 401,
      }),
    ).toMatchObject({ class: "sandbox" });
  });

  it("the credential broker is a platform-layer sandbox failure", () => {
    expect(
      classifyEvalInfraError({
        layer: "platform",
        code: "harness_broker_unavailable",
        httpStatus: 502,
      }),
    ).toMatchObject({ class: "sandbox", layer: "platform", retryable: true });
    expect(
      classifyEvalInfraError({
        layer: "platform",
        code: "harness_broker_unavailable",
        httpStatus: 400,
      }),
    ).toMatchObject({ class: "sandbox", retryable: false });
  });

  it.each([
    ["claude_code_rate_limit", 429, "rate_limited"],
    ["claude_code_server_error", 529, "provider_unavailable"],
    ["claude_code_authentication_failed", 401, "auth"],
    ["claude_code_billing_error", undefined, "account_limit"],
    ["codex_serverOverloaded", undefined, "provider_unavailable"],
    ["codex_internalServerError", undefined, "provider_unavailable"],
    ["codex_unauthorized", 401, "auth"],
    ["codex_usageLimitExceeded", undefined, "account_limit"],
  ] as const)("%s → %s", (code, httpStatus, cls) => {
    expect(
      classifyEvalInfraError({
        layer: "model",
        code,
        ...(httpStatus !== undefined ? { httpStatus } : {}),
      }),
    ).toMatchObject({ class: cls, layer: "model" });
  });

  it("Codex connection failures are decided by their upstream status", () => {
    expect(
      classifyEvalInfraError({
        layer: "model",
        code: "codex_responseStreamDisconnected",
        httpStatus: 429,
      }),
    ).toMatchObject({ class: "rate_limited" });
    expect(
      classifyEvalInfraError({
        layer: "model",
        code: "codex_httpConnectionFailed",
      }),
    ).toMatchObject({ class: "provider_unavailable", retryable: true });
  });
});

describe("rollout + persistence", () => {
  it("reads the rollout mode, defaulting to off", () => {
    expect(resolveInfraClassifyMode({})).toBe("off");
    expect(resolveInfraClassifyMode({ MCPJAM_EVAL_INFRA_CLASSIFY: "shadow" })).toBe(
      "shadow",
    );
    expect(resolveInfraClassifyMode({ MCPJAM_EVAL_INFRA_CLASSIFY: "on" })).toBe("on");
    expect(resolveInfraClassifyMode({ MCPJAM_EVAL_INFRA_CLASSIFY: "maybe" })).toBe(
      "off",
    );
  });

  it("never persists the transient Retry-After", () => {
    const classified = classifyEvalInfraError({
      layer: "model",
      code: "mcpjam_rate_limit",
      httpStatus: 429,
      retryAfterMs: 10_000,
    })!;
    expect(toPersistedInfraError(classified)).toEqual({
      class: "rate_limited",
      layer: "model",
      retryable: true,
      code: "mcpjam_rate_limit",
      httpStatus: 429,
    });
  });
});

describe("resolveIterationInfraError", () => {
  const provider503 = {
    iterationError: "The AI provider is temporarily unavailable.",
    errorCode: "provider_error",
    errorHttpStatus: 503,
    errorInfra: { layer: "model" as const },
  };

  it("off writes nothing", () => {
    expect(resolveIterationInfraError(provider503, "off")).toEqual({});
  });

  it("shadow classifies without changing the row", () => {
    const result = resolveIterationInfraError(provider503, "shadow");
    expect(result.infraError).toBeUndefined();
    expect(result.shadow).toMatchObject({ class: "provider_unavailable" });
  });

  it("on classifies the row", () => {
    expect(resolveIterationInfraError(provider503, "on").infraError).toMatchObject(
      { class: "provider_unavailable", httpStatus: 503 },
    );
  });

  it("a turn timeout is a measured failure, never infra", () => {
    expect(
      resolveIterationInfraError(
        {
          ...provider503,
          timeout: { clock: "turn", budgetMs: 1000, elapsedMs: 1000 },
        },
        "on",
      ),
    ).toEqual({});
  });

  it("an agent_turn_limit refusal is an excluded account limit, distinct from a timeout", () => {
    expect(
      resolveIterationInfraError(
        {
          iterationError: "Too many Ask MCPJam turns in a row.",
          errorCode: "agent_turn_limit",
          errorHttpStatus: 429,
          errorInfra: { layer: "model", retryAfterMs: 4_000 },
        },
        "on",
      ),
    ).toMatchObject({
      infraError: { class: "account_limit", layer: "platform", retryable: false },
    });
  });

  it("no iteration error → nothing", () => {
    expect(
      resolveIterationInfraError({ errorCode: "provider_error" }, "on"),
    ).toEqual({});
  });
});

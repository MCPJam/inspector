import { describe, expect, it } from "vitest";
import {
  accountLimitCode,
  humanizeSwarmAttemptError,
  humanizeSwarmAttemptErrorMessage,
  isAccountLimit,
  isBusyReservation,
  isHeldCreditsRefusal,
  isTransientSpendRefusal,
  MAX_ATTEMPT_ERROR_CHARS,
} from "../swarm-attempt-error";
import { isCreditExhaustion, isHoldRefusal } from "../credit-exhaustion";

/**
 * The exact string that was being stored on every attempt of a rate-limited
 * run — the thrown `SwarmAgentError` message, provider JSON and all.
 */
const REAL_RATE_LIMIT_ERROR =
  'swarm-agent https://tough-cassowary-291.convex.site/journey-execution/persona-next-turn failed (429): {"ok":false,"code":"user_rate_limit","limitKind":"total","error":"Daily MCPJam model limit reached. Use BYOK or try again tomorrow.","isRetryable":true,"retryAfter":9259503,"details":"Try again in 155 minutes.","canTopUp":true,"walletLocked":false}';

describe("humanizeSwarmAttemptError", () => {
  it("extracts the readable message from a real rate-limit payload", () => {
    const info = humanizeSwarmAttemptError(REAL_RATE_LIMIT_ERROR);
    expect(info.message).toBe(
      "Daily MCPJam model limit reached. Use BYOK or try again tomorrow. Try again in 155 minutes.",
    );
    expect(info.code).toBe("user_rate_limit");
    expect(info.retryAfterMs).toBe(9259503);
    expect(info.canTopUp).toBe(true);
    expect(info.httpStatus).toBe(429);
  });

  it("never leaks the deployment URL, which the field contract forbids", () => {
    const info = humanizeSwarmAttemptError(REAL_RATE_LIMIT_ERROR);
    expect(info.message).not.toMatch(/https?:\/\//);
    expect(info.message).not.toContain("convex.site");
    expect(info.message).not.toContain("tough-cassowary");
  });

  it("drops the raw JSON rather than showing it to a user", () => {
    const info = humanizeSwarmAttemptError(REAL_RATE_LIMIT_ERROR);
    expect(info.message).not.toContain('{"ok"');
    expect(info.message).not.toContain("isRetryable");
    expect(info.message).not.toContain("walletLocked");
  });

  it("is idempotent — re-humanizing a clean message changes nothing", () => {
    const once = humanizeSwarmAttemptErrorMessage(REAL_RATE_LIMIT_ERROR);
    const twice = humanizeSwarmAttemptErrorMessage(once);
    expect(twice).toBe(once);
  });

  it("does not repeat a detail the headline already states", () => {
    const info = humanizeSwarmAttemptError(
      '{"error":"Try again in 155 minutes.","details":"Try again in 155 minutes."}',
    );
    expect(info.message).toBe("Try again in 155 minutes.");
  });

  it("joins headline and details with sane punctuation", () => {
    const info = humanizeSwarmAttemptError(
      '{"error":"Spend cap reached","details":"Raise the cap in Billing."}',
    );
    expect(info.message).toBe("Spend cap reached. Raise the cap in Billing.");
  });

  it("passes a plain human message through untouched", () => {
    const info = humanizeSwarmAttemptError("Sandbox was unavailable.");
    expect(info.message).toBe("Sandbox was unavailable.");
    expect(info.code).toBeUndefined();
  });

  it("lifts the engine's code suffix out of the sentence", () => {
    const info = humanizeSwarmAttemptError(
      "A tool on your MCP server has an input schema this model can't accept (JSON Schema propertyNames that does not use a string schema). Try a different model, or simplify that tool's input schema. (invalid_request)",
    );
    expect(info.message).toBe(
      "A tool on your MCP server has an input schema this model can't accept (JSON Schema propertyNames that does not use a string schema). Try a different model, or simplify that tool's input schema.",
    );
    expect(info.code).toBe("invalid_request");
  });

  it("lifts a code and HTTP status suffix together", () => {
    const info = humanizeSwarmAttemptError(
      "Daily MCPJam model limit reached. Use BYOK or try again tomorrow. Try again in 1010 minutes. (user_rate_limit, HTTP 429)",
    );
    expect(info.message).toBe(
      "Daily MCPJam model limit reached. Use BYOK or try again tomorrow. Try again in 1010 minutes.",
    );
    expect(info.code).toBe("user_rate_limit");
    expect(info.httpStatus).toBe(429);
  });

  it.each([
    [" (provider_error)", { code: "provider_error" }],
    [
      "   (user_rate_limit, HTTP 429)",
      { code: "user_rate_limit", httpStatus: 429 },
    ],
    ["(HTTP 502)", { httpStatus: 502 }],
    [".  (provider_error)", { code: "provider_error" }],
  ])(
    "falls back to the generic sentence when %j has no message of its own",
    (raw, lifted) => {
      expect(humanizeSwarmAttemptError(raw)).toEqual({
        message: "The session failed for an unknown reason.",
        ...lifted,
      });
    },
  );

  it("keeps a trailing parenthetical that is not an engine code", () => {
    for (const message of [
      "Could not reach the server (timeout)",
      "Tool call rejected (see server logs)",
    ]) {
      expect(humanizeSwarmAttemptError(message)).toEqual({ message });
    }
  });

  it("degrades an unparseable envelope to its scrubbed body", () => {
    const info = humanizeSwarmAttemptError(
      "swarm-agent https://x.convex.site/foo failed (500): upstream exploded",
    );
    expect(info.message).toBe("upstream exploded");
    expect(info.httpStatus).toBe(500);
  });

  it("survives malformed JSON without throwing", () => {
    const info = humanizeSwarmAttemptError(
      "swarm-agent https://x.convex.site/foo failed (429): {oops",
    );
    expect(info.message).toBe("{oops");
    expect(info.httpStatus).toBe(429);
  });

  it("never returns an empty message", () => {
    expect(humanizeSwarmAttemptError("").message).toBeTruthy();
    expect(humanizeSwarmAttemptError(undefined).message).toBeTruthy();
    expect(humanizeSwarmAttemptError(null).message).toBeTruthy();
    expect(humanizeSwarmAttemptError("   ").message).toBeTruthy();
  });

  it("caps the message length", () => {
    const info = humanizeSwarmAttemptError(
      JSON.stringify({ error: "x".repeat(2000) }),
    );
    expect(info.message.length).toBeLessThanOrEqual(MAX_ATTEMPT_ERROR_CHARS);
  });

  it("reads `message` when the payload has no `error`", () => {
    const info = humanizeSwarmAttemptError('{"message":"Model unavailable"}');
    expect(info.message).toBe("Model unavailable");
  });

  it("omits canTopUp when the provider did not offer it", () => {
    const info = humanizeSwarmAttemptError('{"error":"Nope","canTopUp":false}');
    expect(info.canTopUp).toBeUndefined();
  });
});

describe("humanizeSwarmAttemptError — sandbox error codes", () => {
  it("maps each sandbox code to a cloud-framed sentence", () => {
    for (const code of [
      "sandbox_unavailable",
      "sandbox_at_capacity",
      "sandbox_error",
    ]) {
      const info = humanizeSwarmAttemptError("whatever was stored", code);
      expect(info.code).toBe(code);
      expect(info.message).toMatch(/MCPJam cloud|cloud sandbox/i);
      expect(info.message.length).toBeLessThanOrEqual(MAX_ATTEMPT_ERROR_CHARS);
    }
  });

  it("prefers the code over the stored operator-framed message", () => {
    // The stored sentence talks about data planes — accurate for operators,
    // opaque for the user whose swarm didn't run.
    const info = humanizeSwarmAttemptError(
      "This server is not configured to provision disposable sandboxes (the computers data plane is unavailable), so this session cannot run the shell its target requires.",
      "sandbox_unavailable",
    );
    expect(info.message).not.toMatch(/data plane/i);
    expect(info.message).toMatch(/MCPJam cloud/i);
  });

  it("ignores unknown codes and falls back to message parsing", () => {
    const info = humanizeSwarmAttemptError(
      '{"error":"Daily limit reached"}',
      "spend_cap_exceeded",
    );
    expect(info.message).toBe("Daily limit reached");
  });

  it("maps a recognized code even with no stored message at all", () => {
    const info = humanizeSwarmAttemptError(undefined, "sandbox_at_capacity");
    expect(info.message).toMatch(/at capacity/i);
    expect(info.code).toBe("sandbox_at_capacity");
  });

  it("stays idempotent-compatible when no code is passed", () => {
    const info = humanizeSwarmAttemptError("Could not provision a sandbox.");
    expect(info.message).toBe("Could not provision a sandbox.");
    expect(info.code).toBeUndefined();
  });
});

describe("humanizeSwarmAttemptError — connect-time XAA failures", () => {
  // The whole point of the reason code: a swarm attempt row is a status + a
  // string, and "an authorization handshake needs re-running" cannot be
  // recovered from that string without guessing at its wording.
  it("marks an expired sign-in re-runnable and keeps the server-named sentence", () => {
    const stored =
      'Your sign-in no longer proves your identity to "Billing MCP", so its enterprise access token couldn\'t be issued — sign in again, then re-run.';
    const info = humanizeSwarmAttemptError(stored, "xaa_reauth_required");

    expect(info.message).toBe(stored);
    expect(info.code).toBe("xaa_reauth_required");
    expect(info.rerunnable).toBe(true);
  });

  it("does not mark a configuration failure re-runnable", () => {
    const info = humanizeSwarmAttemptError(
      'Server "Billing MCP" isn\'t fully configured for enterprise-managed authorization: Client ID is required.',
      "xaa_configuration_invalid",
    );

    expect(info.rerunnable).toBeUndefined();
    expect(info.code).toBe("xaa_configuration_invalid");
  });

  it("never says 'unknown reason' about an XAA failure it can name", () => {
    for (const code of [
      "xaa_reauth_required",
      "xaa_authorization_server_unknown",
      "xaa_not_supported_here",
      "xaa_authorization_rejected",
      "xaa_configuration_invalid",
      "xaa_handshake_failed",
    ]) {
      const info = humanizeSwarmAttemptError(undefined, code);
      expect(info.message).not.toMatch(/unknown reason/i);
      expect(info.message).toMatch(
        /sign in again|auth settings|XAA settings|try again/i,
      );
      expect(info.message.length).toBeLessThanOrEqual(MAX_ATTEMPT_ERROR_CHARS);
    }
  });
});

describe("isAccountLimit", () => {
  it("reads the MCPJam denial code out of the real agent envelope", () => {
    // The humanizer lifts `code` out of the JSON, so the cleaned sentence no
    // longer carries it — the code has to be passed alongside the message.
    const info = humanizeSwarmAttemptError(REAL_RATE_LIMIT_ERROR);
    expect(info.message).not.toContain("user_rate_limit");
    expect(isAccountLimit(info.message, info.code)).toBe(true);
  });

  it("recognizes the wire form the swarm runner composes", () => {
    // `runner.ts` builds "<sentence> (<code>, HTTP <status>)".
    expect(
      isAccountLimit("Daily credit limit reached. (user_rate_limit, HTTP 429)"),
    ).toBe(true);
    expect(
      isAccountLimit(
        "Your organization's credit limit was reached. (billing_limit_reached, HTTP 402)",
      ),
    ).toBe(true);
  });

  it("treats the whole-run finalize code as an account limit", () => {
    // `finalizePendingAttempts` stamps this code and stores no message.
    expect(isAccountLimit(undefined, "spend_cap_exceeded")).toBe(true);
  });

  it("recognizes MCPJam's model-limit sentence stored under the generic code", () => {
    // Rows written before the runner kept the denial code: the humanized
    // sentence is all that is left to say MCPJam, not a provider, stopped it.
    expect(
      isAccountLimit(
        "Daily MCPJam model limit reached. Use BYOK or try again tomorrow. Try again in 621 minutes.",
        "rate_limited",
      ),
    ).toBe(true);
    expect(
      isAccountLimit(
        "Monthly MCPJam model limit reached. Top up or use BYOK to keep chatting.",
      ),
    ).toBe(true);
  });

  it.each([
    // MCPJam's own daily budget for the feature: every remaining target in a
    // fan-out meets the same wall.
    "platform_capacity",
    // Keyed on the USER, and every session in a fan-out is the same user.
    "agent_turn_limit",
    // The attestation did not hold — a property of the deployment, not of one
    // host, so another host cannot escape it either.
    "agent_billing_rejected",
  ])("stops the whole run on %s", (code) => {
    // Asserted DIRECTLY, not only through the parity loop in
    // `swarm-runner.test.ts`: that one iterates `USER_OWNED_DENIAL_CODES`, so
    // dropping a code from BOTH that set and this regex would keep it green
    // while silently restoring the per-host behaviour these three must not
    // have. Both forms, because the runner composes the wire string and the
    // humanizer lifts the code out of the JSON envelope.
    expect(isAccountLimit(undefined, code)).toBe(true);
    expect(isAccountLimit(`Limit reached. (${code}, HTTP 429)`)).toBe(true);
  });

  it("does NOT claim a 429 on the user's own provider key", () => {
    // BB-172: the user's own key really was throttled. No MCPJam code appears,
    // and the advice differs — MCPJam cannot lift someone else's rate limit.
    expect(isAccountLimit("429 Too Many Requests")).toBe(false);
    expect(isAccountLimit("Anthropic returned Too Many Requests")).toBe(false);
    // The per-host sweep stamps this code with no message.
    expect(isAccountLimit(undefined, "rate_limited")).toBe(false);
  });
});

describe("accountLimitCode", () => {
  it("reads the code out of the raw agent envelope", () => {
    expect(accountLimitCode(REAL_RATE_LIMIT_ERROR)).toBe("user_rate_limit");
  });

  it("reads the code out of the wire form the runner composes", () => {
    expect(
      accountLimitCode(
        "Daily credit limit reached. (ORG_RATE_LIMIT, HTTP 429)",
      ),
    ).toBe("org_rate_limit");
  });

  it("prefers the structured code over the message", () => {
    expect(
      accountLimitCode("(user_rate_limit, HTTP 429)", "wallet_locked"),
    ).toBe("wallet_locked");
  });

  it("returns nothing for a provider throttle or the humanized sentence", () => {
    expect(accountLimitCode("429 Too Many Requests")).toBeUndefined();
    expect(accountLimitCode(undefined, "rate_limited")).toBeUndefined();
    // The sentence identifies the limit, but it names no code to store.
    expect(
      accountLimitCode(humanizeSwarmAttemptErrorMessage(REAL_RATE_LIMIT_ERROR)),
    ).toBeUndefined();
  });
});

describe("spending reservation contention", () => {
  it("does not describe a queued admission timeout as a database conflict", () => {
    const info = humanizeSwarmAttemptError(
      "MCPJam could not reserve spending capacity because this organization has many model calls starting at once.",
      "spending_reservation_busy",
    );
    expect(info).toEqual({
      code: "spending_reservation_busy",
      message:
        "MCPJam is temporarily busy reserving spending capacity. Retry this attempt.",
    });
  });

  it("explains a truncated historical database conflict", () => {
    const info = humanizeSwarmAttemptError(
      'Backend stream error: 500 {"code":"Server Error: Documents read from or written to the \\"streamSpendingReservations\\" table changed while this mutation was being run and on every subsequent retry.',
    );
    expect(info.code).toBe("spending_reservation_busy");
    expect(info.message).toContain("internal execution failure");
    expect(info.message).not.toContain("streamSpendingReservations");
  });

  it("reads the structured busy response from the shared stream engine", () => {
    const info = humanizeSwarmAttemptError(
      'Backend stream error: 503 {"code":"spending_reservation_busy","error":"MCPJam is temporarily busy. Please retry.","isRetryable":true}',
    );
    expect(info).toMatchObject({
      code: "spending_reservation_busy",
      httpStatus: 503,
      message: "MCPJam is temporarily busy. Please retry.",
    });
  });

  it("does not classify other database errors as spending contention", () => {
    const info = humanizeSwarmAttemptError(
      'Documents read from or written to the "chatSessions" table changed while this mutation was being run',
    );
    expect(info.code).toBeUndefined();
  });
});

it.each([
  "platform_free_budget_exhausted",
  "account_suspended",
  "guest_model_not_allowed",
  "guest_input_too_large",
])("treats %s as an account refusal", (code) => {
  const info = humanizeSwarmAttemptError(
    JSON.stringify({ code, error: "Admission refused" }),
  );
  expect(isAccountLimit(info.message, info.code)).toBe(true);
});

it("keeps transient admission metadata from persona refusals", () => {
  const result = humanizeSwarmAttemptError(
    'swarm-agent https://example.test/persona failed (429): {"code":"user_rate_limit","error":"MCPJam model limit reached for the moment.","refusalReason":"holds_committed","isRetryable":true,"retryAfter":15000,"outstandingHolds":2}',
  );
  expect(result).toMatchObject({
    refusalReason: "holds_committed",
    isRetryable: true,
    retryAfterMs: 15000,
    outstandingHolds: 2,
  });
});
it.each([
  "<!DOCTYPE html><html>Cloudflare",
  "<!-- proxy --><html><head>502",
  "<html>truncated",
])("scrubs HTML error pages: %s", (body) => {
  const result = humanizeSwarmAttemptError(
    `swarm-agent https://example.test/persona failed (502): ${body}`,
  );
  expect(result.code).toBe("upstream_error_page");
  expect(result.message).toContain("HTTP 502");
  expect(result.message).not.toMatch(/<|Cloudflare/);
});

describe("humanizeSwarmAttemptError provider_not_allowlisted", () => {
  it("keeps the backend headline and leaves the gateway's upstream details out", () => {
    const headline =
      'The "openai" provider is not enabled on MCPJam\'s AI Gateway provider allowlist, so MCPJam cannot serve this model right now.';
    const info = humanizeSwarmAttemptError(
      `Backend stream error: 403 ${JSON.stringify({
        ok: false,
        code: "provider_not_allowlisted",
        error: headline,
        isRetryable: false,
        details:
          "Your team has restricted access to this provider. Update your Provider Allowlist settings to enable it.",
      })}`,
    );

    expect(info.message).toBe(headline);
    expect(info.code).toBe("provider_not_allowlisted");
    expect(info.httpStatus).toBe(403);
  });
});

describe("isHeldCreditsRefusal", () => {
  const STORED_HOLDS_SENTENCE =
    "MCPJam model limit reached for the moment: 2 in-flight request(s) hold the remaining credits and release them as they finish. Retry in a few seconds.";

  it("is the held-credits half of a transient refusal", () => {
    expect(isHeldCreditsRefusal("user_rate_limit", "holds_committed")).toBe(
      true,
    );
    expect(
      isHeldCreditsRefusal("user_rate_limit", undefined, STORED_HOLDS_SENTENCE),
    ).toBe(true);
    expect(isHeldCreditsRefusal("user_rate_limit", "allowance_exhausted")).toBe(
      false,
    );
    expect(
      isHeldCreditsRefusal(
        "user_rate_limit",
        undefined,
        "Daily MCPJam model limit reached.",
      ),
    ).toBe(false);
  });

  it("leaves a busy reservation out: a wait, but not about credits", () => {
    expect(isHeldCreditsRefusal("spending_reservation_busy")).toBe(false);
    expect(isTransientSpendRefusal("spending_reservation_busy")).toBe(true);
  });

  it("lets a structured reason decide, and reads the sentence only without one", () => {
    // A caller that passes `refusalReason` has the backend's own verdict; the
    // regex over its prose is the fallback for a stored row that lost it.
    expect(
      isHeldCreditsRefusal(
        "user_rate_limit",
        "allowance_exhausted",
        STORED_HOLDS_SENTENCE,
      ),
    ).toBe(false);
    expect(
      isTransientSpendRefusal(
        "user_rate_limit",
        "allowance_exhausted",
        STORED_HOLDS_SENTENCE,
      ),
    ).toBe(false);
    expect(
      isHeldCreditsRefusal("user_rate_limit", "holds_committed", "Retry."),
    ).toBe(true);
    expect(
      isHeldCreditsRefusal("user_rate_limit", undefined, STORED_HOLDS_SENTENCE),
    ).toBe(true);
  });

  it("reads the sentence as a hold only under the code a hold rides", () => {
    // A locked wallet answers `wallet_locked` with the same sentence
    // (`buildSpendRefusalBody`), and a stored row keeps that code. Any other
    // code names a different refusal, so the sentence cannot turn it into a wait.
    for (const code of [
      "wallet_locked",
      "spend_budget_reached",
      "billing_limit_reached",
      "org_rate_limit",
      "mcpjam_rate_limit",
    ]) {
      expect(isHeldCreditsRefusal(code, undefined, STORED_HOLDS_SENTENCE)).toBe(
        false,
      );
      expect(
        isTransientSpendRefusal(code, undefined, STORED_HOLDS_SENTENCE),
      ).toBe(false);
    }
    // No code at all (a flattened message) and the generic one still read it.
    expect(
      isHeldCreditsRefusal(undefined, undefined, STORED_HOLDS_SENTENCE),
    ).toBe(true);
    expect(isHeldCreditsRefusal(null, null, STORED_HOLDS_SENTENCE)).toBe(true);
  });
});

describe("isBusyReservation", () => {
  it("names only MCPJam's own busy reservation", () => {
    expect(isBusyReservation("spending_reservation_busy")).toBe(true);
    for (const code of [
      undefined,
      null,
      "",
      "user_rate_limit",
      "rate_limited",
      "platform_capacity",
    ]) {
      expect(isBusyReservation(code)).toBe(false);
    }
  });
});

describe("isTransientSpendRefusal", () => {
  /** What `buildSpendRefusalBody` writes, humanized as an attempt row stores it. */
  const STORED_HOLDS_SENTENCE =
    "MCPJam model limit reached for the moment: 2 in-flight request(s) hold the remaining credits and release them as they finish. Retry in a few seconds.";

  it("reads the structured pair", () => {
    expect(isTransientSpendRefusal("user_rate_limit", "holds_committed")).toBe(
      true,
    );
    expect(
      isTransientSpendRefusal("user_rate_limit", "allowance_exhausted"),
    ).toBe(false);
  });

  it("waits out a busy spending reservation, which committed nothing", () => {
    expect(isTransientSpendRefusal("spending_reservation_busy")).toBe(true);
    const info = humanizeSwarmAttemptError(
      'Backend stream error: 503 {"code":"spending_reservation_busy","error":"MCPJam is temporarily busy. Please retry.","isRetryable":true}',
    );
    expect(isTransientSpendRefusal(info.code, info.refusalReason)).toBe(true);
  });

  it("reads a stored row, which keeps the sentence but not the reason", () => {
    expect(
      isTransientSpendRefusal(
        "user_rate_limit",
        undefined,
        STORED_HOLDS_SENTENCE,
      ),
    ).toBe(true);
    expect(
      isTransientSpendRefusal(
        null,
        null,
        humanizeSwarmAttemptErrorMessage(
          'swarm-agent https://example.test/turn failed (429): {"code":"user_rate_limit","error":"MCPJam model limit reached for the moment: 1 in-flight request(s) hold the remaining credits and release them as they finish.","details":"Retry in a few seconds."}',
        ),
      ),
    ).toBe(true);
  });

  it.each([
    "Daily MCPJam model limit reached. Use BYOK or try again tomorrow.",
    "Stopped 2 in-flight tool calls before the credit limit was reached.",
    "MCPJam model limit reached for the momentum tracker",
  ])("stays anchored to the backend's own words: %s", (message) => {
    expect(isTransientSpendRefusal("user_rate_limit", undefined, message)).toBe(
      false,
    );
  });

  it("keeps a stored held-credits row out of credit exhaustion", () => {
    expect(
      isCreditExhaustion({
        code: "user_rate_limit",
        message: STORED_HOLDS_SENTENCE,
      }),
    ).toBe(false);
    expect(isCreditExhaustion(STORED_HOLDS_SENTENCE)).toBe(false);
    // A real exhaustion still counts, whatever `details` happens to quote.
    expect(
      isCreditExhaustion({
        code: "user_rate_limit",
        message: "Daily MCPJam model limit reached.",
        details: { history: [STORED_HOLDS_SENTENCE] },
      }),
    ).toBe(true);
  });

  it("reads the held-credits sentence only at the top, never off a nested object's own message", () => {
    // A nested object under `details` whose own message/error states the
    // sentence is quoted text: it must not veto a real exhaustion.
    for (const key of ["message", "error", "errorMessage"]) {
      expect(
        isCreditExhaustion({
          code: "user_rate_limit",
          message: "Daily MCPJam model limit reached.",
          details: { previous: { [key]: STORED_HOLDS_SENTENCE } },
        }),
      ).toBe(true);
    }
    // A string value under `details` is quoted too.
    expect(
      isCreditExhaustion({
        code: "user_rate_limit",
        message: "Daily MCPJam model limit reached.",
        details: { reason: STORED_HOLDS_SENTENCE },
      }),
    ).toBe(true);
    // The refusal's own words still count: the top-level message fields and
    // a string `details`.
    expect(
      isCreditExhaustion({
        code: "user_rate_limit",
        message: "Request refused.",
        details: STORED_HOLDS_SENTENCE,
      }),
    ).toBe(false);
    expect(
      isCreditExhaustion({
        code: "user_rate_limit",
        error: STORED_HOLDS_SENTENCE,
      }),
    ).toBe(false);
    // The structured reason decides at any depth.
    expect(
      isCreditExhaustion({
        code: "user_rate_limit",
        message: "Daily MCPJam model limit reached.",
        details: { refusal: { refusalReason: "holds_committed" } },
      }),
    ).toBe(false);
  });
});

describe("isCreditExhaustion when a hold and an exhaustion are both in play", () => {
  const HELD =
    "MCPJam model limit reached for the moment: 2 in-flight request(s) hold the remaining credits and release them as they finish. Retry in a few seconds.";
  const SPENT = "Daily MCPJam model limit reached.";
  const envelope = (body: Record<string, unknown>) =>
    `Backend stream error: 429 ${JSON.stringify(body)}`;

  it("lets a structured non-hold reason win over the sentence on the same object", () => {
    expect(
      isCreditExhaustion({
        code: "user_rate_limit",
        refusalReason: "allowance_exhausted",
        message: HELD,
      }),
    ).toBe(true);
    expect(
      isCreditExhaustion({
        code: "user_rate_limit",
        refusalReason: "holds_committed",
        message: SPENT,
      }),
    ).toBe(false);
  });

  it("counts an exhaustion that shares a string with a hold", () => {
    // One string aggregating several session errors: the hold must not hide
    // the exhaustion next to it.
    expect(
      isCreditExhaustion({
        message: "Some sessions failed",
        details: `Session 1: ${HELD} Session 2: ${SPENT}`,
      }),
    ).toBe(true);
    expect(isCreditExhaustion(`${HELD} ${SPENT}`)).toBe(true);
    // The refusal's own fields disagree: the stated exhaustion counts.
    expect(
      isCreditExhaustion({
        code: "user_rate_limit",
        message: SPENT,
        details: HELD,
      }),
    ).toBe(true);
  });

  it("counts a code-only exhaustion next to a hold's sentence", () => {
    // `billing_limit_reached`, `org_rate_limit` and `mcpjam_rate_limit` never
    // ride a hold (its code is `user_rate_limit`), so one beside the sentence
    // is a real exhaustion that the hold must not hide.
    for (const code of [
      "billing_limit_reached",
      "org_rate_limit",
      "mcpjam_rate_limit",
    ]) {
      expect(isCreditExhaustion(`${HELD} (${code}, HTTP 429)`)).toBe(true);
      expect(isCreditExhaustion({ code, message: HELD })).toBe(true);
      expect(isCreditExhaustion(envelope({ code, error: HELD }))).toBe(true);
    }
    // The hold's own code is not an exhaustion signal.
    expect(isCreditExhaustion(`${HELD} (user_rate_limit, HTTP 429)`)).toBe(
      false,
    );
  });

  it("does not read a hold under another refusal's code", () => {
    // The object form: the code is on the refusal, so it decides.
    expect(
      isCreditExhaustion({ code: "billing_limit_reached", message: HELD }),
    ).toBe(true);
    // A locked wallet sends `wallet_locked` with the same sentence. It is not a
    // wait and not a top-up either, so it stays out of exhaustion.
    expect(isCreditExhaustion({ code: "wallet_locked", message: HELD })).toBe(
      false,
    );
  });

  it("reads the envelope a string wraps, so a quoted hold cannot hide a real exhaustion", () => {
    const exhaustedQuotingAHold = envelope({
      code: "user_rate_limit",
      refusalReason: "allowance_exhausted",
      message: "MCPJam daily credit limit reached.",
      details: { previous: HELD },
    });
    expect(isCreditExhaustion(exhaustedQuotingAHold)).toBe(true);
    expect(isCreditExhaustion({ message: exhaustedQuotingAHold })).toBe(true);
  });

  it("still reads a hold as a hold, in every shape it arrives in", () => {
    // With and without the structured reason, bare or wrapped.
    const withReason = envelope({
      code: "user_rate_limit",
      refusalReason: "holds_committed",
      error: HELD,
    });
    const withoutReason = envelope({ code: "user_rate_limit", error: HELD });
    for (const held of [
      HELD,
      withReason,
      withoutReason,
      { code: "user_rate_limit", message: HELD },
      { message: withReason },
      { message: withoutReason },
    ]) {
      expect(isCreditExhaustion(held)).toBe(false);
    }
    // A truncated envelope cannot be parsed; the sentence still says hold.
    expect(isCreditExhaustion(withoutReason.slice(0, -12))).toBe(false);
  });
});

describe("one verdict on a hold", () => {
  const HELD =
    "MCPJam model limit reached for the moment: 2 in-flight request(s) hold the remaining credits and release them as they finish. Retry in a few seconds.";
  const SPENT = "Daily MCPJam model limit reached.";

  // A stored row keeps the sentence under whatever code the RUNNER gave a failed
  // session when the backend's own code was lost, so a code that names no other
  // refusal cannot be what keeps a hold from being read as one.
  it.each(["rate_limited", "session_failed"])(
    "reads the sentence as a hold under the runner's generic code %s",
    (code) => {
      expect(isHeldCreditsRefusal(code, undefined, HELD)).toBe(true);
      expect(isTransientSpendRefusal(code, undefined, HELD)).toBe(true);
      expect(isHoldRefusal({ code, message: HELD })).toBe(true);
      expect(isCreditExhaustion({ code, message: HELD })).toBe(false);
    },
  );

  it("never calls a locked wallet a hold, with or without the structured reason", () => {
    // `buildSpendRefusalBody` can emit both at once.
    expect(isHeldCreditsRefusal("wallet_locked", "holds_committed")).toBe(
      false,
    );
    expect(
      isHoldRefusal({ code: "wallet_locked", refusalReason: "holds_committed" }),
    ).toBe(false);
  });

  it("reads a hold joined with a stated exhaustion as the exhaustion, wherever it is asked", () => {
    const joined = `${HELD} ${SPENT}`;
    expect(isHeldCreditsRefusal(undefined, undefined, joined)).toBe(false);
    expect(isTransientSpendRefusal("user_rate_limit", undefined, joined)).toBe(
      false,
    );
    expect(isHoldRefusal(joined)).toBe(false);
    expect(isCreditExhaustion(joined)).toBe(true);
  });

  it("lets exhaustion nested under details win over a top-level hold sentence", () => {
    const refusal = {
      message: HELD,
      details: {
        code: "billing_limit_reached",
        error: "Daily credit limit reached",
      },
    };
    expect(isHoldRefusal(refusal)).toBe(false);
    expect(isCreditExhaustion(refusal)).toBe(true);
  });

  it("lets a structured reason decide at any depth, as the dialog's scan does", () => {
    const nested = {
      code: "user_rate_limit",
      message: SPENT,
      details: { refusal: { refusalReason: "holds_committed" } },
    };
    expect(isHoldRefusal(nested)).toBe(true);
    expect(isCreditExhaustion(nested)).toBe(false);
  });

  it("gives the field form and the value form of one refusal the same verdict", () => {
    const refusals: Array<{
      code?: string;
      refusalReason?: string;
      message?: string;
    }> = [
      { code: "user_rate_limit", refusalReason: "holds_committed" },
      {
        code: "user_rate_limit",
        refusalReason: "allowance_exhausted",
        message: HELD,
      },
      { code: "user_rate_limit", message: HELD },
      { code: "user_rate_limit", message: SPENT },
      { code: "user_rate_limit", message: `${HELD} ${SPENT}` },
      { code: "wallet_locked", message: HELD },
      { code: "wallet_locked", refusalReason: "holds_committed" },
      { code: "billing_limit_reached", message: HELD },
      { code: "rate_limited", message: HELD },
      { message: HELD },
    ];
    for (const refusal of refusals) {
      expect(isHoldRefusal(refusal), JSON.stringify(refusal)).toBe(
        isHeldCreditsRefusal(
          refusal.code,
          refusal.refusalReason,
          refusal.message,
        ),
      );
    }
  });
});

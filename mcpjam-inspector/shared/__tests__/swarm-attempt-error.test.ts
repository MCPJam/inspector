import { describe, expect, it } from "vitest";
import {
  humanizeSwarmAttemptError,
  humanizeSwarmAttemptErrorMessage,
  isAccountLimit,
  MAX_ATTEMPT_ERROR_CHARS,
} from "../swarm-attempt-error";

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
      "Daily MCPJam model limit reached. Use BYOK or try again tomorrow. Try again in 155 minutes."
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
      '{"error":"Try again in 155 minutes.","details":"Try again in 155 minutes."}'
    );
    expect(info.message).toBe("Try again in 155 minutes.");
  });

  it("joins headline and details with sane punctuation", () => {
    const info = humanizeSwarmAttemptError(
      '{"error":"Spend cap reached","details":"Raise the cap in Billing."}'
    );
    expect(info.message).toBe("Spend cap reached. Raise the cap in Billing.");
  });

  it("passes a plain human message through untouched", () => {
    const info = humanizeSwarmAttemptError("Sandbox was unavailable.");
    expect(info.message).toBe("Sandbox was unavailable.");
    expect(info.code).toBeUndefined();
  });

  it("degrades an unparseable envelope to its scrubbed body", () => {
    const info = humanizeSwarmAttemptError(
      "swarm-agent https://x.convex.site/foo failed (500): upstream exploded"
    );
    expect(info.message).toBe("upstream exploded");
    expect(info.httpStatus).toBe(500);
  });

  it("survives malformed JSON without throwing", () => {
    const info = humanizeSwarmAttemptError(
      "swarm-agent https://x.convex.site/foo failed (429): {oops"
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
      JSON.stringify({ error: "x".repeat(2000) })
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
      "sandbox_unavailable"
    );
    expect(info.message).not.toMatch(/data plane/i);
    expect(info.message).toMatch(/MCPJam cloud/i);
  });

  it("ignores unknown codes and falls back to message parsing", () => {
    const info = humanizeSwarmAttemptError(
      '{"error":"Daily limit reached"}',
      "spend_cap_exceeded"
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
      "xaa_configuration_invalid"
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
        /sign in again|auth settings|XAA settings|try again/i
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
      isAccountLimit("Daily credit limit reached. (user_rate_limit, HTTP 429)")
    ).toBe(true);
    expect(
      isAccountLimit(
        "Your organization's credit limit was reached. (billing_limit_reached, HTTP 402)"
      )
    ).toBe(true);
  });

  it("treats the whole-run finalize code as an account limit", () => {
    // `finalizePendingAttempts` stamps this code and stores no message.
    expect(isAccountLimit(undefined, "spend_cap_exceeded")).toBe(true);
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

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ERROR_CATALOG } from "@mcpjam/sdk/browser";
import {
  describeProviderRateLimit,
  describeSwarmAttemptFailure,
  providerLabelForModelId,
} from "../session-rate-limit";

describe("providerLabelForModelId", () => {
  it("names a provider the model id actually declares", () => {
    expect(providerLabelForModelId("anthropic/claude-opus-5")).toBe(
      "Anthropic",
    );
    expect(providerLabelForModelId("openai/gpt-5")).toBe("OpenAI");
  });

  it("names an org provider by its slug", () => {
    expect(providerLabelForModelId("custom:Acme Models:llama-3")).toBe(
      "Acme Models",
    );
  });

  it("stays generic for a bare id rather than blaming Ollama", () => {
    // `classifyModelIdProvider` is total: every unprefixed id falls through to
    // `ollama`. Naming a provider we only defaulted to would blame the wrong
    // vendor for someone else's throttle.
    expect(providerLabelForModelId("llama-3.1-70b")).toBe("Your provider");
    expect(providerLabelForModelId("some-unknown-model")).toBe("Your provider");
  });

  it("still names Ollama when the id says so outright", () => {
    expect(providerLabelForModelId("ollama/llama-3.1")).toBe("Ollama");
  });

  it("stays generic for a missing or blank id", () => {
    expect(providerLabelForModelId(undefined)).toBe("Your provider");
    expect(providerLabelForModelId("   ")).toBe("Your provider");
  });
});

describe("describeProviderRateLimit", () => {
  it("uses the copy written for this failure, with the provider filled in", () => {
    const normalized = describeProviderRateLimit("Anthropic");
    expect(normalized.title).toBe("Your provider hit its limit");
    expect(normalized.oneLine).toBe(
      "Anthropic rate-limited this key. Retry again later or switch models.",
    );
  });

  it("reads correctly with the generic label too", () => {
    expect(describeProviderRateLimit("Your provider").oneLine).toBe(
      "Your provider rate-limited this key. Retry again later or switch models.",
    );
  });

  it("takes slug, severity, origin and docs from the catalog entry", () => {
    // Asserted against the catalog rather than restated here: a literal would
    // keep this test green while the card drifted away from how every other
    // quota failure renders. Amber and user-owned is what it must stay.
    const entry = ERROR_CATALOG["provider/quota"];
    const normalized = describeProviderRateLimit("Anthropic");
    expect(normalized.slug).toBe(entry.slug);
    expect(normalized.severity).toBe(entry.severity);
    expect(normalized.origin).toBe(entry.origin);
    expect(normalized.docsAnchor).toBe(entry.docsAnchor);
    expect(entry.severity).toBe("warning");
  });

  it("offers no MCPJam purchase, which would be a false promise", () => {
    // No spend on MCPJam lifts a limit the user's own provider imposed.
    // Upgrading that provider's own plan is fair advice and stays.
    const steps = describeProviderRateLimit("Anthropic").nextSteps.join(" ");
    expect(steps).not.toMatch(/credit|top up|byok|mcpjam/i);
  });
});

describe("describeSwarmAttemptFailure", () => {
  it("uses calm copy for rerunnable authentication and preserves diagnostics", () => {
    expect(describeSwarmAttemptFailure("Sign in again.", "xaa_reauth_required", "Anthropic")).toMatchObject({
      severity: "info", oneLine: "Sign in again.", rawMessage: "Sign in again.", rawCode: "xaa_reauth_required",
    });
  });
  it("retains a failure's humanized meaning and machine code", () => {
    const error = describeSwarmAttemptFailure("Runner stopped.", "execution_failed", "Your provider");
    expect(error.title).toBe("Session failed");
    expect(error.oneLine).toBe("Runner stopped.");
    expect(error.rawCode).toBe("execution_failed");
  });
});

it.each([
  ["Daily MCPJam model limit reached.", "provider/mcpjam_limit_daily"],
  ["Available spending capacity is committed.", "provider/mcpjam_limit"],
  [
    "MCPJam model limit reached for the moment: 2 in-flight requests hold the remaining credits.",
    "provider/mcpjam_limit",
  ],
])(
  "maps MCPJam allowance refusals without provider advice: %s",
  (message, slug) => {
    const result = describeSwarmAttemptFailure(
      message,
      "user_rate_limit",
      "Anthropic",
    );
    expect(result.slug).toBe(slug);
    expect(result.nextSteps.join(" ")).not.toContain(
      "Upgrade your provider plan",
    );
  },
);

describe("describeSwarmAttemptFailure held credits", () => {
  // What the runner stores for a `holds_committed` refusal: the backend's
  // sentence under the generic code, with the refusal reason gone.
  const HELD =
    "MCPJam model limit reached for the moment: 13 in-flight request(s) hold the remaining credits and release them as they finish. Retry in a few seconds.";

  it("titles a hold as a wait, not as an empty balance", () => {
    const result = describeSwarmAttemptFailure(
      HELD,
      "user_rate_limit",
      "Anthropic",
    );
    expect(result.title).toBe("Credits temporarily held");
    expect(result.title).not.toBe(ERROR_CATALOG["provider/mcpjam_limit"].title);
    // The backend's sentence stays as the body: it says how many requests hold credits.
    expect(result.oneLine).toContain("13 in-flight request(s)");
    expect(result.rawCode).toBe("user_rate_limit");
    expect(result.rawMessage).toBe(HELD);
  });

  it("still renders like every other MCPJam limit", () => {
    const entry = ERROR_CATALOG["provider/mcpjam_limit"];
    const result = describeSwarmAttemptFailure(
      HELD,
      "user_rate_limit",
      "Anthropic",
    );
    expect(result.slug).toBe(entry.slug);
    expect(result.severity).toBe(entry.severity);
  });

  it("recognizes the sentence without a stored code", () => {
    expect(describeSwarmAttemptFailure(HELD, null, "Anthropic").title).toBe(
      "Credits temporarily held",
    );
  });

  it("reads a hold from the structured reason when the row kept it", () => {
    const result = describeSwarmAttemptFailure(
      'Backend stream error: 429 {"code":"user_rate_limit","refusalReason":"holds_committed","error":"Try again shortly."}',
      "user_rate_limit",
      "Anthropic",
    );
    expect(result.title).toBe("Credits temporarily held");
  });

  it("offers no purchase, which would be a false promise", () => {
    // The balance is not empty and nothing bought lifts a hold.
    const result = describeSwarmAttemptFailure(
      HELD,
      "user_rate_limit",
      "Anthropic",
    );
    const advice = [...result.likelyCauses, ...result.nextSteps].join(" ");
    expect(advice).not.toMatch(/upgrade|buy|top.?up|purchase|byok|api key/i);
  });

  it("keeps the top-up sentence out of the body and links the hold's own docs note", () => {
    // With `canTopUp` the backend ends a hold's details with "Top up to add
    // more credits." Nothing bought lifts a hold, so the card must not say it,
    // and its "Learn more" must not land on the buy-credits section.
    const body = `Backend stream error: 429 ${JSON.stringify({
      code: "user_rate_limit",
      error:
        "MCPJam model limit reached for the moment: 13 in-flight request(s) hold the remaining credits and release them as they finish.",
      details: "Retry in a few seconds. Top up to add more credits.",
      canTopUp: true,
      retryAfter: 15000,
    })}`;
    const result = describeSwarmAttemptFailure(
      body,
      "user_rate_limit",
      "Anthropic",
    );
    expect(result.title).toBe("Credits temporarily held");
    expect(result.oneLine).toContain("13 in-flight request(s)");
    expect(result.oneLine).toContain("Retry in a few seconds.");
    expect(result.oneLine).not.toMatch(/top.?up/i);
    expect(result.docsAnchor).toMatch(/#credits-temporarily-held$/);
    expect(result.docsAnchor).not.toBe(
      ERROR_CATALOG["provider/mcpjam_limit"].docsAnchor,
    );
  });

  it("points at a heading that exists in the docs", () => {
    const docs = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../../../../../docs/troubleshooting/error-codes.mdx",
      ),
      "utf8",
    );
    expect(docs).toMatch(/^#{2,4} Credits temporarily held$/m);
  });

  it("leaves a locked wallet's row to its own card: the same sentence rides that code", () => {
    // `buildSpendRefusalBody` answers `wallet_locked` with the hold sentence when
    // a locked wallet and a hold coincide, and a stored row keeps that code.
    const result = describeSwarmAttemptFailure(
      HELD,
      "wallet_locked",
      "Anthropic",
    );
    expect(result.title).not.toBe("Credits temporarily held");
    expect(result.rawCode).toBe("wallet_locked");
  });

  it("still cards a spent allowance and a shortfall as running out", () => {
    const spent = describeSwarmAttemptFailure(
      "Daily MCPJam model limit reached. Use BYOK or try again tomorrow.",
      "user_rate_limit",
      "Anthropic",
    );
    expect(spent.title).toBe(
      ERROR_CATALOG["provider/mcpjam_limit_daily"].title,
    );
    const shortfall = describeSwarmAttemptFailure(
      "This request needs about 25 MCPJam credits; your organization has 23 left.",
      "user_rate_limit",
      "Anthropic",
    );
    expect(shortfall.title).toBe(
      ERROR_CATALOG["provider/mcpjam_limit_insufficient"].title,
    );
  });

  it("does not retitle a busy reservation as a hold", () => {
    const busy = describeSwarmAttemptFailure(
      "MCPJam is temporarily busy reserving spending capacity. Retry this attempt.",
      "spending_reservation_busy",
      "Anthropic",
    );
    expect(busy.title).not.toBe("Credits temporarily held");
  });
});

describe("describeSwarmAttemptFailure provider_not_allowlisted", () => {
  const backendBody = JSON.stringify({
    ok: false,
    code: "provider_not_allowlisted",
    error:
      'The "openai" provider is not enabled on MCPJam\'s AI Gateway provider allowlist, so MCPJam cannot serve this model right now.',
    statusCode: 403,
    isRetryable: false,
    details:
      "Your team has restricted access to this provider. Update your Provider Allowlist settings to enable it.",
  });

  it("cards the gateway refusal from the envelope code, with no API-key remedy", () => {
    const result = describeSwarmAttemptFailure(
      `Backend stream error: 403 ${backendBody}`,
      null,
      "OpenAI",
    );

    expect(result.slug).toBe("provider/not_allowlisted");
    expect(result.title).toBe("Model provider not enabled on MCPJam");
    expect(result.oneLine).toContain('The "openai" provider is not enabled');
    expect(result.rawCode).toBe("provider_not_allowlisted");
    expect(result.nextSteps.join(" ")).not.toMatch(
      /(check|update|verify) (your|the) (api )?key/i,
    );
    expect(result.slug).not.toBe(ERROR_CATALOG["provider/auth_error"].slug);
  });

  it("keeps the provider-naming headline without the gateway's upstream instruction", () => {
    const result = describeSwarmAttemptFailure(
      `Backend stream error: 403 ${backendBody}`,
      "provider_not_allowlisted",
      "OpenAI",
    );

    expect(result.oneLine).toBe(
      "The \"openai\" provider is not enabled on MCPJam's AI Gateway provider allowlist, so MCPJam cannot serve this model right now. Retrying or changing your API key won't help.",
    );
    expect(result.oneLine).not.toMatch(/Update your Provider Allowlist settings/i);
    expect(result.oneLine).not.toMatch(/Your team has restricted access/i);
  });

  it("strips the upstream instruction from a row stored with it folded in", () => {
    const result = describeSwarmAttemptFailure(
      'The "openai" provider is not enabled on MCPJam\'s AI Gateway provider allowlist. Your team has restricted access to this provider. Update your Provider Allowlist settings to enable it.',
      "provider_not_allowlisted",
      "OpenAI",
    );

    expect(result.oneLine).toBe(
      "The \"openai\" provider is not enabled on MCPJam's AI Gateway provider allowlist. Retrying or changing your API key won't help.",
    );
  });

  it("cards it from the attempt row's stored code too", () => {
    const result = describeSwarmAttemptFailure(
      "The provider is not enabled on MCPJam's gateway.",
      "provider_not_allowlisted",
      "OpenAI",
    );

    expect(result.slug).toBe("provider/not_allowlisted");
    expect(result.oneLine).toBe(
      "The provider is not enabled on MCPJam's gateway. Retrying or changing your API key won't help.",
    );
  });
});

describe("describeSwarmAttemptFailure organization AI-key refusals", () => {
  it("cards org_keys_required as configuration, never a credential or credit failure", () => {
    const error = describeSwarmAttemptFailure(
      "This organization requires its own provider keys for AI features.",
      "org_keys_required",
      "Anthropic",
    );
    expect(error).toMatchObject({
      slug: "swarm/ai_refused",
      title: "Organization provider required",
      severity: "warning",
      rawCode: "org_keys_required",
      nextSteps: ["Choose a model from an organization provider."],
    });
    expect(error.oneLine).not.toMatch(/credit|top up/i);
  });

  it("reads the code out of the raw message when the row has none", () => {
    expect(
      describeSwarmAttemptFailure(
        "provider_auth_failed: 401 from the provider",
        null,
        "OpenAI",
      ),
    ).toMatchObject({
      slug: "swarm/ai_refused",
      rawCode: "provider_auth_failed",
      nextSteps: ["Ask an organization admin to update the provider's API key."],
    });
  });

  it("offers another run for a transient refusal", () => {
    expect(
      describeSwarmAttemptFailure("busy", "provider_unavailable", "OpenAI"),
    ).toMatchObject({
      severity: "info",
      nextSteps: ["Run the session again in a moment."],
    });
  });
});

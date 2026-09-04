import { describe, expect, it } from "vitest";
import { ERROR_CATALOG } from "@mcpjam/sdk/browser";
import {
  describeProviderRateLimit,
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

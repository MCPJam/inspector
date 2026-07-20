import { describe, expect, it } from "vitest";
import { HOSTED_MODEL_IDS } from "@/shared/hosted-model-ids.generated";
import {
  getProviderColor,
  getProviderDisplayName,
  getProviderLogo,
  normalizeProviderKey,
  providerHasLogo,
} from "@/lib/provider-registry";

// Vendors present in the hosted snapshot that INTENTIONALLY ship no bundled
// logo (they render a monogram). This is a snapshot-time guard: a vendor the
// hourly catalog adds AFTER the last snapshot regen won't appear in
// HOSTED_MODEL_IDS yet — runtime miss telemetry (hosted_provider_logo_missing)
// covers that gap. What this test catches: a vendor that IS in the snapshot,
// has no logo, and isn't listed here — add a logo, or add it here on purpose.
const KNOWN_MONOGRAM_PREFIXES = new Set([
  "amazon",
  "arcee-ai",
  "bytedance",
  "cohere",
  "inception",
  "kwaipilot",
  "nvidia",
  "sakana",
  "stepfun",
  "xiaomi",
]);

describe("provider-registry — snapshot-time logo guard", () => {
  const prefixes = [...new Set(HOSTED_MODEL_IDS.map((id) => id.split("/")[0]))];

  it.each(prefixes)(
    "hosted vendor '%s' has a logo or is a known monogram",
    (prefix) => {
      expect(
        providerHasLogo(prefix) || KNOWN_MONOGRAM_PREFIXES.has(prefix)
      ).toBe(true);
    }
  );
});

describe("normalizeProviderKey", () => {
  it("collapses every raw/aliased prefix to one canonical key", () => {
    expect(normalizeProviderKey("x-ai")).toBe("xai");
    expect(normalizeProviderKey("xai")).toBe("xai");
    expect(normalizeProviderKey("meta-llama")).toBe("meta");
    expect(normalizeProviderKey("meta")).toBe("meta");
    expect(normalizeProviderKey("mistralai")).toBe("mistral");
    expect(normalizeProviderKey("zai")).toBe("z-ai");
    expect(normalizeProviderKey("moonshot")).toBe("moonshotai");
    expect(normalizeProviderKey("custom:my-slug")).toBe("custom");
    // Unknown passes through unchanged.
    expect(normalizeProviderKey("nvidia")).toBe("nvidia");
  });

  it("raw and aliased forms resolve to the same logo + color", () => {
    expect(getProviderLogo("x-ai", "light")).toBe(
      getProviderLogo("xai", "light")
    );
    expect(getProviderLogo("meta-llama")).toBe(getProviderLogo("meta"));
    expect(getProviderColor("mistralai")).toBe(getProviderColor("mistral"));
  });
});

describe("getProviderDisplayName", () => {
  it("resolves known providers, custom slugs, and title-cases unknowns", () => {
    expect(getProviderDisplayName("anthropic")).toBe("Anthropic");
    expect(getProviderDisplayName("x-ai")).toBe("xAI");
    expect(getProviderDisplayName("z-ai")).toBe("Zhipu AI");
    expect(getProviderDisplayName("custom:My Provider")).toBe("My Provider");
    // Unknown catalog vendors → clean title-cased name, no code change needed.
    expect(getProviderDisplayName("arcee-ai")).toBe("Arcee Ai");
    expect(getProviderDisplayName("nvidia")).toBe("Nvidia");
  });
});

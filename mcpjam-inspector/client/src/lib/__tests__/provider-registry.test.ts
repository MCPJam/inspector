import { describe, expect, it } from "vitest";
import { HOSTED_MODEL_IDS } from "@/shared/hosted-model-ids.generated";
import {
  getProviderColor,
  getProviderDisplayName,
  getProviderLogo,
  normalizeProviderKey,
  providerHasLogo,
} from "@/lib/provider-registry";

// Vendors that INTENTIONALLY ship no bundled logo (they render a monogram),
// split by whether the committed snapshot actually contains them.
//
// The split is not cosmetic. The guard below walks HOSTED_MODEL_IDS, so it only
// ever consults a prefix the snapshot has — an entry for a vendor that is NOT
// in it is never asserted and cannot fail, which is how a wrong entry sits
// green forever. The reverse assertions further down close that: a snapshot
// entry must be in the snapshot, and a pre-snapshot entry must not be. When a
// regen lands, the pre-snapshot list is what tells you to promote.
const SNAPSHOT_MONOGRAM_PREFIXES = new Set([
  "sakana",
  // Only a `Xiaomi MiMo` WORDMARK is available upstream — unreadable at the
  // 12px the badge renders at, so the monogram is the better badge here.
  "xiaomi",
]);

// Registered AHEAD of the next snapshot regen: these vendors appear in the
// catalog but not yet in the committed HOSTED_MODEL_IDS, so nothing here
// asserts them. Runtime miss telemetry (hosted_provider_logo_missing) is what
// covers the gap until the regen promotes them above.
const PRE_SNAPSHOT_MONOGRAM_PREFIXES = new Set([
  "inclusionai",
  "interfaze",
  "thinkingmachines",
]);

const KNOWN_MONOGRAM_PREFIXES = new Set([
  ...SNAPSHOT_MONOGRAM_PREFIXES,
  ...PRE_SNAPSHOT_MONOGRAM_PREFIXES,
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

  // The other direction. Without these, an entry can name a vendor the
  // snapshot never had and no test ever notices.
  it("keeps every snapshot monogram entry backed by the snapshot", () => {
    const inSnapshot = new Set(prefixes);
    for (const prefix of SNAPSHOT_MONOGRAM_PREFIXES) {
      expect(inSnapshot.has(prefix)).toBe(true);
    }
  });

  it("keeps pre-snapshot entries out of the snapshot list", () => {
    // A hit here is good news, not a failure to paper over: the regen landed
    // and the vendor belongs in SNAPSHOT_MONOGRAM_PREFIXES now.
    const inSnapshot = new Set(prefixes);
    for (const prefix of PRE_SNAPSHOT_MONOGRAM_PREFIXES) {
      expect(inSnapshot.has(prefix)).toBe(false);
    }
  });

  // `it.each` only generates cases for prefixes the snapshot has, so a brand
  // entry for a vendor it does not have yet is unasserted — a typo'd key or a
  // broken asset import would ship green. These three are that case today.
  it.each(["tencent", "morph", "poolside"])(
    "pre-snapshot brand entry '%s' resolves a logo",
    (prefix) => {
      expect(providerHasLogo(prefix)).toBe(true);
    }
  );
});

describe("normalizeProviderKey", () => {
  it("collapses every raw/aliased prefix to one canonical key", () => {
    expect(normalizeProviderKey("x-ai")).toBe("xai");
    expect(normalizeProviderKey("xai")).toBe("xai");
    expect(normalizeProviderKey("spacexai")).toBe("xai");
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
    expect(getProviderDisplayName("spacexai")).toBe("xAI");
    expect(getProviderDisplayName("custom:My Provider")).toBe("My Provider");
    // Registered vendors keep their branded casing rather than the fallback.
    expect(getProviderDisplayName("arcee-ai")).toBe("Arcee AI");
    expect(getProviderDisplayName("nvidia")).toBe("NVIDIA");
    // Unknown catalog vendors → clean title-cased name, no code change needed.
    expect(getProviderDisplayName("sakana")).toBe("Sakana");
    // The catalog slug has no hyphen (`thinkingmachines/inkling`), and
    // `titleCaseProviderKey` only splits on [-_], so this is the string the
    // product actually renders. Asserting the hyphenated spelling pinned a
    // prettier name nothing ever produces. A brand entry is what would fix
    // the casing, if it turns out to be worth one when the vendor lands.
    expect(getProviderDisplayName("thinkingmachines")).toBe("Thinkingmachines");
    // The one brand entry whose displayName deliberately diverges from its
    // key — the intent a future refactor would silently revert.
    expect(getProviderDisplayName("tencent")).toBe("Tencent Hunyuan");
  });
});

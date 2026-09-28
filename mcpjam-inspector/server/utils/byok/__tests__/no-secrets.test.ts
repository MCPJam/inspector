import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURE_DIR } from "./fixture-fetch.js";

// Key shapes of the providers the adapters talk to. A fixture must never hold
// one: fixtures are committed to a public repository.
const KEY_SHAPES: Array<[string, RegExp]> = [
  ["OpenAI / Anthropic / OpenRouter style", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{30,}/],
  ["Bedrock API key", /\bABSK[A-Za-z0-9+/=]{20,}/],
  ["AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
  ["bearer token", /Bearer\s+[A-Za-z0-9._-]{8,}/i],
];

describe("BYOK adapter fixtures", () => {
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"));

  it("exist", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s holds no key", (file) => {
    const text = readFileSync(path.join(FIXTURE_DIR, file), "utf8");
    for (const [label, pattern] of KEY_SHAPES) {
      expect(pattern.test(text), `${file}: ${label}`).toBe(false);
    }
  });
});

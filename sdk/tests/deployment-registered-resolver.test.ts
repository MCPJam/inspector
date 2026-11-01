import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBaseUrl } from "../src/deployment/address.js";
import "../src/deployment/node-entry.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the resolver the SDK main entry registers", () => {
  it("reads the environment it is given, not process.env", () => {
    vi.stubEnv("MCPJAM_API_URL", "https://process.example.test/api/v1");
    expect(
      resolveBaseUrl(undefined, {
        MCPJAM_API_URL: "https://given.example.test/api/v1",
      })
    ).toBe("https://given.example.test");
    expect(resolveBaseUrl(undefined, {})).toBe("https://app.mcpjam.com");
  });
});

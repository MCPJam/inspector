import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCacheKey } from "../org-model-config.js";
import { buildRuntimeCacheKey } from "../org-runtime-admission.js";

afterEach(() => vi.unstubAllEnvs());

describe("model authority cache install scope", () => {
  const target = { projectId: "same-project-id" };
  const auth = { authHeader: "Bearer same-subject", serverIds: ["server"] };
  const keys = () => [
    buildCacheKey(target, auth),
    buildRuntimeCacheKey(target, "ollama", "llama3", auth),
  ];

  it("does not reuse model or admission authority across backend installs", () => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://first.example.test");
    const first = keys();
    vi.stubEnv("CONVEX_HTTP_URL", "https://second.example.test");
    const second = keys();
    expect(second[0]).not.toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(second.join(" ")).not.toContain("same-subject");
    expect(second.join(" ")).not.toContain("second.example.test");
  });

  it("retains stable reuse within the same install and authority", () => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://first.example.test");
    expect(keys()).toEqual(keys());
    expect(
      buildCacheKey(target, { ...auth, authHeader: "Bearer another-subject" }),
    ).not.toBe(buildCacheKey(target, auth));
  });
});

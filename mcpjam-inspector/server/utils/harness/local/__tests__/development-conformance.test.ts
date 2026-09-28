import { afterEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({ HOSTED_MODE: false, LOCAL_HARNESS_ENABLED: true }));
vi.mock("../../../../config.js", () => config);
import { LOCAL_HARNESS_MANIFEST } from "../compatibility.js";
import { localHarnessManifestsForDevelopment } from "../availability.js";

afterEach(() => { vi.unstubAllEnvs(); config.HOSTED_MODE = false; });

describe("development conformance evidence", () => {
  it("overrides only the unpublished Claude Code evidence in local development", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("MCPJAM_LOCAL_HARNESS_CONFORMANCE_VERSION", "dev-run-42");
    const manifests = localHarnessManifestsForDevelopment();
    expect(manifests["claude-code"].lifecycleConformanceVersion).toBe("dev-run-42");
    expect(LOCAL_HARNESS_MANIFEST["claude-code"].lifecycleConformanceVersion).toBe("");
    expect(manifests.codex).toBe(LOCAL_HARNESS_MANIFEST.codex);
  });

  it.each(["production", "test", ""])("ignores override in %s builds", (env) => {
    vi.stubEnv("NODE_ENV", env);
    vi.stubEnv("MCPJAM_LOCAL_HARNESS_CONFORMANCE_VERSION", "dev-run-42");
    expect(localHarnessManifestsForDevelopment()).toBe(LOCAL_HARNESS_MANIFEST);
  });

  it("ignores override on hosted deployments even in development", () => {
    config.HOSTED_MODE = true;
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("MCPJAM_LOCAL_HARNESS_CONFORMANCE_VERSION", "dev-run-42");
    expect(localHarnessManifestsForDevelopment()).toBe(LOCAL_HARNESS_MANIFEST);
  });

  it("keeps recorded evidence and ignores empty overrides", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("MCPJAM_LOCAL_HARNESS_CONFORMANCE_VERSION", " ");
    expect(localHarnessManifestsForDevelopment()).toBe(LOCAL_HARNESS_MANIFEST);
    vi.stubEnv("MCPJAM_LOCAL_HARNESS_CONFORMANCE_VERSION", "dev-run-42");
    const recorded = { ...LOCAL_HARNESS_MANIFEST, "claude-code": {
      ...LOCAL_HARNESS_MANIFEST["claude-code"], lifecycleConformanceVersion: "ci-1",
    } };
    expect(localHarnessManifestsForDevelopment(recorded)["claude-code"]).toBe(recorded["claude-code"]);
  });
});

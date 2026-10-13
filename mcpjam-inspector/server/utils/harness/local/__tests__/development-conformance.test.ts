import { afterEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({ HOSTED_MODE: false, LOCAL_HARNESS_ENABLED: true }));
vi.mock("../../../../config.js", () => config);
import { LOCAL_HARNESS_MANIFEST } from "../compatibility.js";
import { localHarnessManifestsForDevelopment } from "../availability.js";

afterEach(() => { vi.unstubAllEnvs(); config.HOSTED_MODE = false; });

describe("development conformance evidence", () => {
  it("overrides every harness's unpublished evidence in local development", () => {
    // An unpublished Codex pack must be exercisable through the same
    // development-only override as Claude Code was, before its conformance is
    // recorded. Nothing else about the manifest changes.
    vi.stubEnv("ENVIRONMENT", "dev");
    vi.stubEnv("MCPJAM_LOCAL_HARNESS_CONFORMANCE_VERSION", "dev-run-42");
    vi.stubEnv("NODE_ENV", "production");
    // Unpublished fixtures, so the rule is tested whatever the shipped table
    // has recorded since.
    const unpublished = Object.fromEntries(
      Object.entries(LOCAL_HARNESS_MANIFEST).map(([id, manifest]) => [
        id,
        { ...manifest, lifecycleConformanceVersion: "" },
      ]),
    ) as typeof LOCAL_HARNESS_MANIFEST;
    const manifests = localHarnessManifestsForDevelopment(unpublished);
    expect(manifests["claude-code"].lifecycleConformanceVersion).toBe("dev-run-42");
    expect(manifests.codex.lifecycleConformanceVersion).toBe("dev-run-42");
    expect(manifests.codex.permissionProfileMapping).toEqual(
      LOCAL_HARNESS_MANIFEST.codex.permissionProfileMapping,
    );
  });

  it("never replaces evidence that was recorded for a published pack", () => {
    vi.stubEnv("ENVIRONMENT", "dev");
    vi.stubEnv("MCPJAM_LOCAL_HARNESS_CONFORMANCE_VERSION", "dev-run-42");
    const mixed = {
      ...LOCAL_HARNESS_MANIFEST,
      "claude-code": {
        ...LOCAL_HARNESS_MANIFEST["claude-code"],
        lifecycleConformanceVersion: "published-1.0.0-abc",
      },
      codex: { ...LOCAL_HARNESS_MANIFEST.codex, lifecycleConformanceVersion: "" },
    } as typeof LOCAL_HARNESS_MANIFEST;
    const manifests = localHarnessManifestsForDevelopment(mixed);
    expect(manifests["claude-code"].lifecycleConformanceVersion).toBe("published-1.0.0-abc");
    expect(manifests.codex.lifecycleConformanceVersion).toBe("dev-run-42");
  });

  it.each(["prod", "test", ""])("ignores override in %s builds", (env) => {
    vi.stubEnv("ENVIRONMENT", env);
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("MCPJAM_LOCAL_HARNESS_CONFORMANCE_VERSION", "dev-run-42");
    expect(localHarnessManifestsForDevelopment()).toBe(LOCAL_HARNESS_MANIFEST);
  });

  it("ignores override on hosted deployments even in development", () => {
    config.HOSTED_MODE = true;
    vi.stubEnv("ENVIRONMENT", "dev");
    vi.stubEnv("MCPJAM_LOCAL_HARNESS_CONFORMANCE_VERSION", "dev-run-42");
    expect(localHarnessManifestsForDevelopment()).toBe(LOCAL_HARNESS_MANIFEST);
  });

  it("keeps recorded evidence and ignores empty overrides", () => {
    vi.stubEnv("ENVIRONMENT", "dev");
    vi.stubEnv("MCPJAM_LOCAL_HARNESS_CONFORMANCE_VERSION", " ");
    expect(localHarnessManifestsForDevelopment()).toBe(LOCAL_HARNESS_MANIFEST);
    vi.stubEnv("MCPJAM_LOCAL_HARNESS_CONFORMANCE_VERSION", "dev-run-42");
    const recorded = { ...LOCAL_HARNESS_MANIFEST, "claude-code": {
      ...LOCAL_HARNESS_MANIFEST["claude-code"], lifecycleConformanceVersion: "ci-1",
    } };
    expect(localHarnessManifestsForDevelopment(recorded)["claude-code"]).toBe(recorded["claude-code"]);
  });
});

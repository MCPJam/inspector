import { describe, expect, it, vi, beforeEach } from "vitest";

// `BAKED_VERSION` is captured at module load (it must stay a literal
// `process.env.X` so esbuild's `define` can substitute it), so every case
// stubs the environment first and then re-imports a fresh module — the same
// pattern server/__tests__/sentry.test.ts uses for the release tag.
async function freshLogEvents() {
  vi.resetModules();
  return import("../log-events.js");
}

describe("resolveRelease", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("RAILWAY_GIT_COMMIT_SHA", "");
    vi.stubEnv("GIT_SHA", "");
    vi.stubEnv("MCPJAM_INSPECTOR_VERSION", "");
    vi.stubEnv("npm_package_version", "");
  });

  it("prefers the git sha when a repo-connected build provides one", async () => {
    vi.stubEnv("RAILWAY_GIT_COMMIT_SHA", "abc123");
    vi.stubEnv("MCPJAM_INSPECTOR_VERSION", "2.36.0");
    const { resolveRelease } = await freshLogEvents();
    expect(resolveRelease()).toBe("abc123");
  });

  it("falls back to the baked app version when no sha is set", async () => {
    // Production deploys via `railway up` (directory upload, no git
    // metadata), so neither sha var exists there. Before this fallback every
    // prod row carried release: null and the deploy-boundary triage step in
    // the alert runbooks was impossible.
    vi.stubEnv("MCPJAM_INSPECTOR_VERSION", "2.36.0");
    const { resolveRelease } = await freshLogEvents();
    expect(resolveRelease()).toBe("2.36.0");
  });

  it("treats a declared-but-empty sha as unset", async () => {
    // Container platforms materialize declared-but-unset vars as "".
    vi.stubEnv("GIT_SHA", "  ");
    vi.stubEnv("MCPJAM_INSPECTOR_VERSION", "2.36.0");
    const { resolveRelease } = await freshLogEvents();
    expect(resolveRelease()).toBe("2.36.0");
  });

  it("resolves npm_package_version under tsx where the define is absent", async () => {
    vi.stubEnv("npm_package_version", "2.36.0-dev");
    const { resolveRelease } = await freshLogEvents();
    expect(resolveRelease()).toBe("2.36.0-dev");
  });

  it("returns null only when nothing identifies the build", async () => {
    const { resolveRelease } = await freshLogEvents();
    expect(resolveRelease()).toBeNull();
  });
});

describe("resolveAppVersion", () => {
  it("matches what /health reports so log rows and the canary correlate", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("MCPJAM_INSPECTOR_VERSION", "2.36.0");
    vi.resetModules();
    const { resolveAppVersion } = await import("../log-events.js");
    const { buildHealthMeta } = await import("../health-payload.js");
    expect(buildHealthMeta().version).toBe(resolveAppVersion());
  });
});

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

describe("resolveEnvironment", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("takes an exact member of the enum", async () => {
    for (const value of ["prod", "staging", "preview", "dev", "local", "test"]) {
      vi.stubEnv("ENVIRONMENT", value);
      const { resolveEnvironment } = await freshLogEvents();
      expect(resolveEnvironment()).toBe(value);
    }
  });

  it("accepts the spelling production actually deploys with", async () => {
    // The Railway production environment sets `ENVIRONMENT=production`, which
    // is not `prod`. Before the alias the allowlist discarded it and the answer
    // came from the `NODE_ENV` fallback — right by accident, and reported as
    // "ENVIRONMENT not set" in the logs, which is why nobody fixed the value.
    // It also left `ENV NODE_ENV=production` in the Dockerfile deciding which
    // platform MCP worker production dials.
    vi.stubEnv("ENVIRONMENT", "production");
    vi.stubEnv("NODE_ENV", "");
    const { resolveEnvironment } = await freshLogEvents();
    expect(resolveEnvironment()).toBe("prod");
  });

  it("resolves prod from the alias without NODE_ENV's help", async () => {
    vi.stubEnv("ENVIRONMENT", "production");
    vi.stubEnv("NODE_ENV", "development");
    const { resolveEnvironment } = await freshLogEvents();
    expect(resolveEnvironment()).toBe("prod");
  });

  it("tolerates whitespace around either spelling", async () => {
    // Found in review: the alias branch trimmed and the allowlist branch did
    // not, so a padded exact value silently became `dev`.
    for (const [value, expected] of [
      [" prod ", "prod"],
      [" production ", "prod"],
      ["  staging  ", "staging"],
    ] as const) {
      vi.stubEnv("ENVIRONMENT", value);
      vi.stubEnv("NODE_ENV", "");
      const { resolveEnvironment } = await freshLogEvents();
      expect(resolveEnvironment()).toBe(expected);
    }
  });

  it("still falls back for a value that is not an environment at all", async () => {
    vi.stubEnv("ENVIRONMENT", "banana");
    vi.stubEnv("NODE_ENV", "production");
    const { resolveEnvironment } = await freshLogEvents();
    expect(resolveEnvironment()).toBe("prod");
  });
});

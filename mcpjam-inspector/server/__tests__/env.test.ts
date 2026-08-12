import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getInspectorClientRuntimeConfig,
  getInspectorClientRuntimeConfigScript,
  getInspectorEnvFileNames,
  loadInspectorEnv,
} from "../env.js";

const ORIGINAL_CONVEX_HTTP_URL = process.env.CONVEX_HTTP_URL;
const ORIGINAL_PRIORITY_TEST = process.env.MCPJAM_ENV_PRIORITY_TEST;

// Every input `getInspectorClientRuntimeConfig` reads, cleared per-test. The
// assertions below pin an exact serialization, so a developer shell (or a
// repo `.env`) that exports VITE_CONVEX_URL or WORKOS_CLIENT_ID would
// otherwise fail the suite on one machine and pass on another.
const RUNTIME_CONFIG_ENV_KEYS = [
  "CONVEX_HTTP_URL",
  "VITE_CONVEX_URL",
  "WORKOS_CLIENT_ID",
  "VITE_WORKOS_CLIENT_ID",
  "WORKOS_API_HOSTNAME",
  "VITE_WORKOS_API_HOSTNAME",
] as const;
const ORIGINAL_RUNTIME_CONFIG_ENV = Object.fromEntries(
  RUNTIME_CONFIG_ENV_KEYS.map((key) => [key, process.env[key]]),
);

beforeEach(() => {
  for (const key of RUNTIME_CONFIG_ENV_KEYS) {
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of RUNTIME_CONFIG_ENV_KEYS) {
    const original = ORIGINAL_RUNTIME_CONFIG_ENV[key];
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }

  if (ORIGINAL_CONVEX_HTTP_URL === undefined) {
    delete process.env.CONVEX_HTTP_URL;
  } else {
    process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX_HTTP_URL;
  }

  if (ORIGINAL_PRIORITY_TEST === undefined) {
    delete process.env.MCPJAM_ENV_PRIORITY_TEST;
  } else {
    process.env.MCPJAM_ENV_PRIORITY_TEST = ORIGINAL_PRIORITY_TEST;
  }
});

describe("env loader", () => {
  it("uses Vite-compatible file precedence in development", () => {
    expect(getInspectorEnvFileNames("development")).toEqual([
      ".env.development.local",
      ".env.development",
      ".env.local",
      ".env",
    ]);
  });

  it("prefers .env.development values ahead of .env.local", () => {
    delete process.env.CONVEX_HTTP_URL;
    delete process.env.MCPJAM_ENV_PRIORITY_TEST;

    const tempRoot = mkdtempSync(join(tmpdir(), "mcpjam-env-"));
    const resolvedTempRoot = realpathSync(tempRoot);
    const originalCwd = process.cwd();
    const serverDir = join(tempRoot, "server", "dist");
    mkdirSync(serverDir, { recursive: true });

    writeFileSync(
      join(tempRoot, ".env.local"),
      [
        "CONVEX_HTTP_URL=https://local-priority.convex.site",
        "MCPJAM_ENV_PRIORITY_TEST=local",
      ].join("\n"),
    );
    writeFileSync(
      join(tempRoot, ".env.development"),
      [
        "CONVEX_HTTP_URL=https://development-fallback.convex.site",
        "MCPJAM_ENV_PRIORITY_TEST=development",
      ].join("\n"),
    );

    try {
      process.chdir(tempRoot);
      const loadedEnv = loadInspectorEnv(serverDir);

      expect(process.env.CONVEX_HTTP_URL).toBe(
        "https://development-fallback.convex.site",
      );
      expect(process.env.MCPJAM_ENV_PRIORITY_TEST).toBe("development");
      expect(loadedEnv.loadedFiles).toEqual([
        join(resolvedTempRoot, ".env.development"),
        join(resolvedTempRoot, ".env.local"),
      ]);
    } finally {
      process.chdir(originalCwd);
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("derives hosted client runtime config from CONVEX_HTTP_URL", () => {
    process.env.CONVEX_HTTP_URL = "https://demo-deployment.convex.site";

    expect(getInspectorClientRuntimeConfig()).toEqual({
      convexUrl: "https://demo-deployment.convex.cloud",
      convexSiteUrl: "https://demo-deployment.convex.site",
    });
  });

  it("serializes hosted client runtime config for html injection", () => {
    process.env.CONVEX_HTTP_URL = "https://demo-deployment.convex.site";

    expect(getInspectorClientRuntimeConfigScript()).toBe(
      '<script>window.__MCP_RUNTIME_CONFIG__={"convexUrl":"https://demo-deployment.convex.cloud","convexSiteUrl":"https://demo-deployment.convex.site"};</script>',
    );
  });

  it("serves WorkOS client config from the environment, unprefixed name winning", () => {
    process.env.WORKOS_CLIENT_ID = "client_runtime";
    process.env.VITE_WORKOS_CLIENT_ID = "client_build";
    process.env.WORKOS_API_HOSTNAME = "auth.example.com";

    const config = getInspectorClientRuntimeConfig();
    expect(config.workosClientId).toBe("client_runtime");
    expect(config.workosApiHostname).toBe("auth.example.com");
  });

  it("falls back to the VITE_-prefixed WorkOS names during migration", () => {
    process.env.VITE_WORKOS_CLIENT_ID = "client_build";
    process.env.VITE_WORKOS_API_HOSTNAME = "auth.build.example.com";

    const config = getInspectorClientRuntimeConfig();
    expect(config.workosClientId).toBe("client_build");
    expect(config.workosApiHostname).toBe("auth.build.example.com");
  });

  // The guard used to key off the two Convex fields only, so an environment
  // that set WorkOS config but no Convex URL would inject no script at all and
  // the client would silently fall back to its build-time values.
  it("injects the script when only WorkOS config is present", () => {
    process.env.WORKOS_CLIENT_ID = "client_runtime";

    expect(getInspectorClientRuntimeConfigScript()).toBe(
      '<script>window.__MCP_RUNTIME_CONFIG__={"workosClientId":"client_runtime"};</script>',
    );
  });

  it("emits no script when nothing is configured", () => {
    expect(getInspectorClientRuntimeConfigScript()).toBeNull();
  });
});

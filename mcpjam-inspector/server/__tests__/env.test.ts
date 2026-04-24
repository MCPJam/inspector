import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getInspectorClientRuntimeConfig,
  getInspectorClientRuntimeConfigScript,
  getInspectorEnvFileNames,
  loadInspectorEnv,
} from "../env.js";

const ORIGINAL_CONVEX_HTTP_URL = process.env.CONVEX_HTTP_URL;
const ORIGINAL_PRIORITY_TEST = process.env.MCPJAM_ENV_PRIORITY_TEST;

afterEach(() => {
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
});

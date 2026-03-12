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
import { getInspectorEnvFileNames, loadInspectorEnv } from "../env.js";

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
      ".env.local",
      ".env.development",
      ".env",
    ]);
  });

  it("keeps .env.local values ahead of .env.development", () => {
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
        "https://local-priority.convex.site",
      );
      expect(process.env.MCPJAM_ENV_PRIORITY_TEST).toBe("local");
      expect(loadedEnv.loadedFiles).toEqual([
        join(resolvedTempRoot, ".env.local"),
        join(resolvedTempRoot, ".env.development"),
      ]);
    } finally {
      process.chdir(originalCwd);
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });
});

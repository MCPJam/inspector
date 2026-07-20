import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("web xaa routes under the Hono Node adapter", () => {
  it("rejects a malformed org segment instead of stringifying a Response", () => {
    const fixturePath = fileURLToPath(
      new URL("./fixtures/xaa-node-adapter.ts", import.meta.url)
    );
    const projectRoot = fileURLToPath(new URL("../../../../", import.meta.url));
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", fixturePath],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: { ...process.env, NODE_ENV: "test" },
      }
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);

    const output = JSON.parse(result.stdout) as {
      status: number;
      body: Record<string, unknown>;
    };
    expect(output).toEqual({
      status: 400,
      body: {
        code: "VALIDATION_ERROR",
        message: "Invalid organization id in issuer path",
        error: "Invalid organization id in issuer path",
      },
    });
    expect(JSON.stringify(output.body)).not.toContain("[object Response]");
  });
});

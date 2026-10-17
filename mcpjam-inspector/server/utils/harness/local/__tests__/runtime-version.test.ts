import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localRuntimeVersion } from "../runtime-version";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
describe("selected local runtime version", () => {
  it.each([
    ["claude-code", "@anthropic-ai/claude-agent-sdk"],
    ["codex", "@openai/codex"],
  ] as const)(
    "reads %s from its actual verified pack",
    async (harnessId, pkg) => {
      const rootPath = await mkdtemp(join(tmpdir(), "runtime-version-"));
      roots.push(rootPath);
      const packageDir = join(rootPath, "node_modules", pkg);
      await mkdir(packageDir, { recursive: true });
      await writeFile(
        join(packageDir, "package.json"),
        JSON.stringify({ version: "1.2.3" }),
      );
      expect(
        await localRuntimeVersion({
          source: "managed-bundle",
          harnessId,
          rootPath,
        }),
      ).toBe("1.2.3");
    },
  );
  it("keeps a missing managed version unknown", async () => {
    expect(
      await localRuntimeVersion({
        source: "managed-bundle",
        harnessId: "codex",
        rootPath: "/missing-runtime",
      }),
    ).toBeNull();
  });
  it("uses the verified system executable's probe", async () => {
    expect(
      await localRuntimeVersion({
        source: "system-install",
        harnessId: "codex",
        rootPath: "/system",
        vendorVersionLine: "codex-cli 1.2.3",
      }),
    ).toBe("codex-cli 1.2.3");
  });
});

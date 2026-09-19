import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { detectEvalGitMetadata } from "../src/eval-git.js";

describe("bounded git provenance", () => {
  it("observes commits and dirty changes afresh, including detached HEAD and non-repositories", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "eval-git-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    try {
      expect(await detectEvalGitMetadata({ cwd })).toEqual({});
      git("init", "-b", "main");
      git("config", "user.email", "tests@example.test");
      git("config", "user.name", "Tests");
      await writeFile(join(cwd, "a"), "one");
      git("add", "a");
      git("commit", "-m", "one");
      const first = await detectEvalGitMetadata({ cwd });
      expect(first).toMatchObject({
        branch: "main",
        dirty: false,
        commitSha: git("rev-parse", "HEAD"),
      });
      await writeFile(join(cwd, "a"), "two");
      expect((await detectEvalGitMetadata({ cwd })).dirty).toBe(true);
      git("add", "a");
      git("commit", "-m", "two");
      expect((await detectEvalGitMetadata({ cwd })).commitSha).not.toBe(
        first.commitSha
      );
      git("checkout", "--detach");
      expect((await detectEvalGitMetadata({ cwd })).branch).toBeUndefined();
      const controller = new AbortController();
      controller.abort();
      expect(
        await detectEvalGitMetadata({ cwd, signal: controller.signal })
      ).toEqual({});
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

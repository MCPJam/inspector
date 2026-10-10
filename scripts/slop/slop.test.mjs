import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { countFile, isMeasuredFile } from "./rules.mjs";

const RATCHET = join(dirname(fileURLToPath(import.meta.url)), "ratchet.mjs");

function count(text, path = "sdk/src/a.ts") {
  return countFile(path, text);
}

describe("isMeasuredFile", () => {
  it("measures hand-written source", () => {
    assert.equal(isMeasuredFile("sdk/src/platform/operations.ts"), true);
    assert.equal(isMeasuredFile("mcpjam-inspector/client/src/App.tsx"), true);
  });

  it("skips tests, generated output and non-source", () => {
    for (const path of [
      "sdk/src/a.test.ts",
      "mcpjam-inspector/server/__tests__/a.ts",
      "sdk/tests/a.ts",
      "sdk/dist/index.js",
      "mcpjam-inspector/server/utils/x.bundled.ts",
      "sdk/src/types.d.ts",
      "README.md",
      "scripts/slop/rules.mjs",
    ]) {
      assert.equal(isMeasuredFile(path), false, path);
    }
  });
});

describe("rules", () => {
  it("counts type escapes", () => {
    const counts = count(
      "const a = b as any;\nfunction f(x: any): any {}\nconst c = d as unknown as E;\n"
    );
    assert.equal(counts["as-any"], 1);
    assert.equal(counts["any-annotation"], 2);
    assert.equal(counts["as-unknown-as"], 1);
  });

  it("does not read words that contain `any` as type escapes", () => {
    const counts = count(
      'const company = "x";\nconst label = { any: 1, many: 2 };\n'
    );
    assert.equal(counts["as-any"], 0);
    assert.equal(counts["any-annotation"], 0);
  });

  it("counts swallowed promise rejections", () => {
    const counts = count(
      "p.catch(() => {});\np.catch((_e) => undefined);\np.catch(() => null);\np.catch(async () => {});\np.catch((e) => log(e));\n"
    );
    assert.equal(counts["swallowed-catch-callback"], 4);
  });

  it("counts empty catch blocks but not ones with a reason comment", () => {
    const counts = count(
      "try { a(); } catch {}\ntry { a(); } catch (e) {\n}\ntry { a(); } catch {\n  // best effort: the file may be gone\n}\n"
    );
    assert.equal(counts["empty-catch-block"], 2);
  });

  it("counts raw console only in the inspector server", () => {
    const text = "console.log('x');\nconsole.error('y');\n";
    assert.equal(
      count(text, "mcpjam-inspector/server/a.ts")["server-console"],
      2
    );
    assert.equal(
      count(text, "mcpjam-inspector/client/a.ts")["server-console"],
      0
    );
  });

  it("counts PR numbers and dates in comments, not in code", () => {
    const counts = count(
      [
        "// Fixed in #5474.",
        " * Landed 2026-09-24 (#6001).",
        "// See PR 4556 for history.",
        'const issue = "#5474";',
        "// HTTP 404 is fine here.",
      ].join("\n")
    );
    assert.equal(counts["history-comment"], 3);
  });

  it("does not count MCP protocol versions as history", () => {
    const counts = count(
      [
        "// 2026-07-28 servers omit X.",
        "// A 2025-11-25 server can land on the legacy wire.",
        "// Spec 2025-06-18, changed on 2026-09-24.",
      ].join("\n")
    );
    assert.equal(counts["history-comment"], 1);
  });

  it("counts suppressions", () => {
    const counts = count(
      "// @ts-nocheck\n// @ts-ignore\n// @ts-expect-error\n/* eslint-disable no-console */\n"
    );
    assert.equal(counts["ts-suppression"], 3);
    assert.equal(counts["eslint-disable"], 1);
  });
});

describe("ratchet", () => {
  const repo = mkdtempSync(join(tmpdir(), "slop-ratchet-"));
  after(() => rmSync(repo, { recursive: true, force: true }));

  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  const write = (path, text) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  const run = (env = {}) => {
    try {
      const stdout = execFileSync("node", [RATCHET, "--base", "base"], {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, GITHUB_STEP_SUMMARY: "", ...env },
      });
      return { code: 0, stdout };
    } catch (error) {
      return { code: error.status, stdout: error.stdout };
    }
  };

  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  write("sdk/src/a.ts", "export const a = b as any;\n");
  write("sdk/src/b.ts", "export const ok = 1;\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("tag", "base");

  it("passes when nothing changed", () => {
    assert.equal(run().code, 0);
  });

  it("fails when a change adds a cast", () => {
    write("sdk/src/b.ts", "export const ok = c as any;\n");
    const result = run();
    assert.equal(result.code, 1);
    assert.match(result.stdout, /sdk\/src\/b\.ts`: as-any \+1/);
  });

  it("passes when the change removes as many as it adds", () => {
    write("sdk/src/a.ts", "export const a = b;\n");
    assert.equal(run().code, 0);
  });

  it("treats a move into a new file as neutral", () => {
    write("sdk/src/a.ts", "export const a = b as any;\n");
    write("sdk/src/b.ts", "export const ok = 1;\n");
    git("mv", "sdk/src/a.ts", "sdk/src/moved.ts");
    assert.equal(run().code, 0);
    git("mv", "sdk/src/moved.ts", "sdk/src/a.ts");
  });

  it("counts untracked new files", () => {
    write("sdk/src/new.ts", "p.catch(() => {});\n");
    assert.equal(run().code, 1);
  });

  it("reports but passes under a waiver", () => {
    const result = run({ SLOP_WAIVER: "true" });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Waived/);
  });
});

describe("deletion bot check", async () => {
  const { checkLane, codeLinesChanged, MAX_LINES } = await import(
    "./deletion-bot-check.mjs"
  );
  const CHECK = join(
    dirname(fileURLToPath(import.meta.url)),
    "deletion-bot-check.mjs"
  );
  const lines = (n) => () => n;

  it("accepts pure deletions in the dead-files lane", () => {
    const { problems } = checkLane(
      "dead-files",
      [{ status: "D", path: "a.ts" }],
      { diffOf: () => "", linesOf: lines(40) }
    );
    assert.deepEqual(problems, []);
  });

  it("rejects additions, edits and oversize changes", () => {
    const { problems } = checkLane(
      "dead-files",
      [
        { status: "D", path: "a.ts" },
        { status: "M", path: "b.ts" },
        { status: "??", path: "c.ts" },
      ],
      { diffOf: () => "", linesOf: lines(MAX_LINES) }
    );
    assert.equal(problems.length, 3);
  });

  it("allows only comment lines to change in the history lane", () => {
    const commentOnly = [
      "--- a/x.ts",
      "+++ b/x.ts",
      "-// Fixed in #5474 on 2026-09-24.",
      "+// Retries once: the first read can race the writer.",
      "- * Landed in PR 4556.",
      "+",
    ].join("\n");
    assert.deepEqual(codeLinesChanged(commentOnly), []);
    assert.equal(
      codeLinesChanged("-const a = 1; // #5474\n+const a = 1;").length,
      2
    );
  });

  it("refuses a real tree that adds a file, and passes a real deletion", () => {
    const repo = mkdtempSync(join(tmpdir(), "slop-bot-"));
    try {
      const git = (...args) =>
        execFileSync("git", args, { cwd: repo, encoding: "utf8" });
      git("init", "-q");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "test");
      mkdirSync(join(repo, "sdk/src"), { recursive: true });
      writeFileSync(join(repo, "sdk/src/dead.ts"), "export const x = 1;\n");
      git("add", ".");
      git("commit", "-qm", "base");
      const run = () => {
        try {
          execFileSync("node", [CHECK, "--lane", "dead-files"], {
            cwd: repo,
            encoding: "utf8",
            stdio: "pipe",
          });
          return 0;
        } catch (error) {
          return error.status;
        }
      };
      git("rm", "-q", "sdk/src/dead.ts");
      assert.equal(run(), 0);
      // `git rm` removed the now-empty directory.
      mkdirSync(join(repo, "sdk/src"), { recursive: true });
      writeFileSync(join(repo, "sdk/src/new.ts"), "export const y = 2;\n");
      assert.equal(run(), 1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

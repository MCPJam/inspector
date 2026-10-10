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
  const { checkLane, codeOnly, MAX_LINES } = await import(
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
      { before: () => "", after: () => "", linesOf: lines(40) }
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
      { before: () => "", after: () => "", linesOf: lines(MAX_LINES) }
    );
    assert.equal(problems.length, 3);
  });

  it("allows only comment changes in the history lane", () => {
    const before = [
      "// Fixed in #5474 on 2026-09-24.",
      "const a = 1; // PR 4556",
      "/** Landed in #6001. */",
      'const url = "http://x//y";',
    ].join("\n");
    const after = [
      "// Retries once: the first read can race the writer.",
      "const a = 1;",
      'const url = "http://x//y";',
    ].join("\n");
    assert.equal(codeOnly(before), codeOnly(after));
    const { problems } = checkLane(
      "history-comments",
      [{ status: "M", path: "sdk/src/a.ts" }],
      { before: () => before, after: () => after, linesOf: lines(5) }
    );
    assert.deepEqual(problems, []);
  });

  it("catches code hidden behind a comment marker", () => {
    assert.notEqual(
      codeOnly("/* fixed in #123 */ doThing();"),
      codeOnly("/* why */ doOther();")
    );
    assert.notEqual(
      codeOnly("class A {\n  *gen() {}\n}"),
      codeOnly("class A {\n  *other() {}\n}")
    );
    assert.notEqual(
      codeOnly("const a = 1; // #5474"),
      codeOnly("const a = 2;")
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

describe("agent hooks", async () => {
  const { checkNewPath, checkEdit, editFragments, FILE_BUDGET } = await import(
    "./hook.mjs"
  );
  const HOOK = join(dirname(fileURLToPath(import.meta.url)), "hook.mjs");

  it("refuses scratch notes, spike folders and new root files", () => {
    assert.match(checkNewPath("NOTES-item-4.md", false), /scratch notes/);
    assert.match(checkNewPath("sdk/NOTES_plan.md", false), /scratch notes/);
    assert.match(checkNewPath(".spike-foo/run.mjs", false), /spike/);
    assert.match(checkNewPath("plan.md", false), /RFC/);
  });

  it("allows package files, existing files and allowlisted root files", () => {
    assert.equal(checkNewPath("sdk/src/new.ts", false), null);
    assert.equal(checkNewPath("plan.md", true), null);
    assert.equal(checkNewPath("CLAUDE.md", false), null);
  });

  it("reports what an edit added, not what the file already had", () => {
    const fragments = editFragments("Edit", {
      old_string: "const a = b;",
      new_string: "const a = b as any;",
    });
    const problem = checkEdit("sdk/src/a.ts", {
      ...fragments,
      fileBefore: "x as any\n",
      fileAfter: "x as any\nconst a = b as any;\n",
    });
    assert.match(problem, /`as any` casts: \+1/);

    const clean = checkEdit("sdk/src/a.ts", {
      ...editFragments("Edit", { old_string: "a", new_string: "b" }),
      fileBefore: "x as any\n",
      fileAfter: "x as any\n",
    });
    assert.equal(clean, null);
  });

  it("flags a file growing past the budget", () => {
    const big = "x\n".repeat(FILE_BUDGET + 10);
    const problem = checkEdit("sdk/src/a.ts", {
      before: "",
      after: "x\n",
      fileBefore: big,
      fileAfter: `${big}x\n`,
    });
    assert.match(problem, /line budget/);
  });

  it("ignores tests", () => {
    const problem = checkEdit("sdk/src/a.test.ts", {
      before: "",
      after: "x as any",
      fileBefore: "",
      fileAfter: "x as any",
    });
    assert.equal(problem, null);
  });

  it("exits 2 with the reason on stdin input, and 0 on garbage", () => {
    const run = (input) => {
      try {
        execFileSync("node", [HOOK], {
          input,
          encoding: "utf8",
          stdio: "pipe",
        });
        return { code: 0 };
      } catch (error) {
        return { code: error.status, stderr: error.stderr };
      }
    };
    const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
    const denied = run(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: join(root, "NOTES-item-9.md") },
      })
    );
    assert.equal(denied.code, 2);
    assert.match(denied.stderr, /scratch notes/);
    assert.equal(run("not json").code, 0);
  });
});

describe("hook paths", async () => {
  const { repoPath } = await import("./hook.mjs");
  const { posix, win32 } = await import("node:path");

  it("normalizes native separators to git-style paths", () => {
    assert.equal(
      repoPath("/repo/sdk/src/a.ts", "/repo", posix),
      "sdk/src/a.ts"
    );
    assert.equal(
      repoPath("C:\\repo\\sdk\\src\\a.ts", "C:\\repo", win32),
      "sdk/src/a.ts"
    );
  });

  it("fails open when git cannot read HEAD", async () => {
    const { isMeasuredFile } = await import("./rules.mjs");
    const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
    // A measured file that already has casts. Read against an empty HEAD, a
    // Write to it would report all of them as new.
    const target = execFileSync(
      "git",
      ["grep", "-l", "as any", "--", "sdk/src"],
      {
        cwd: root,
        encoding: "utf8",
      }
    )
      .split("\n")
      .find((path) => path && isMeasuredFile(path));
    const HOOK = join(dirname(fileURLToPath(import.meta.url)), "hook.mjs");
    const input = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: join(root, target) },
    });
    // No git on PATH: the HEAD read fails for a reason other than a new path.
    execFileSync(process.execPath, [HOOK], {
      input,
      env: { PATH: "/nonexistent" },
      stdio: "pipe",
    });
  });
});

describe("repo hygiene", async () => {
  const { checkChange, parseNameStatus } = await import("./repo-hygiene.mjs");
  const { FILE_BUDGET } = await import("./hook.mjs");
  const sizes = (map) => (path) => map[path] ?? 0;

  it("parses NUL-delimited name-status output", () => {
    assert.deepEqual(parseNameStatus("A\0NOTES-x.md\0M\0sdk/src/a.ts\0"), [
      { status: "A", path: "NOTES-x.md" },
      { status: "M", path: "sdk/src/a.ts" },
    ]);
  });

  it("fails litter and files crossing the budget", () => {
    const { failures } = checkChange(
      [
        { status: "A", path: "NOTES-item-9.md" },
        { status: "A", path: "plan.md" },
        { status: "A", path: "sdk/src/big.ts" },
        { status: "M", path: "sdk/src/grew.ts" },
      ],
      sizes({ "sdk/src/grew.ts": FILE_BUDGET - 10 }),
      sizes({
        "sdk/src/big.ts": FILE_BUDGET + 1,
        "sdk/src/grew.ts": FILE_BUDGET + 5,
      })
    );
    assert.equal(failures.length, 4);
  });

  it("only warns when an already-large file grows", () => {
    const { failures, warnings } = checkChange(
      [{ status: "M", path: "sdk/src/huge.ts" }],
      sizes({ "sdk/src/huge.ts": 2000 }),
      sizes({ "sdk/src/huge.ts": 2050 })
    );
    assert.equal(failures.length, 0);
    assert.equal(warnings.length, 1);
  });

  it("ignores tests, deletions and shrinking files", () => {
    const { failures, warnings } = checkChange(
      [
        { status: "A", path: "sdk/src/big.test.ts" },
        { status: "D", path: "sdk/src/gone.ts" },
        { status: "M", path: "sdk/src/huge.ts" },
      ],
      sizes({ "sdk/src/huge.ts": 2000 }),
      sizes({ "sdk/src/big.test.ts": 5000, "sdk/src/huge.ts": 1900 })
    );
    assert.deepEqual([failures, warnings], [[], []]);
  });
});

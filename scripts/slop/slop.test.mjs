import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { countFile, isMeasuredFile } from "./rules.mjs";
import { addedCopy, extractUiStrings, isUiFile } from "./ui-strings.mjs";
import {
  BATCH,
  MODELS,
  callClaude,
  classify,
  collectAdded,
  commentBody,
  main as reviewCopy,
  marker,
  report,
  suggestion,
} from "./copy-review.mjs";

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
      "const a = b as any;\nfunction f(x: any): any {}\nconst c = d as unknown as E;\n",
    );
    assert.equal(counts["as-any"], 1);
    assert.equal(counts["any-annotation"], 2);
    assert.equal(counts["as-unknown-as"], 1);
  });

  it("does not read words that contain `any` as type escapes", () => {
    const counts = count(
      'const company = "x";\nconst label = { any: 1, many: 2 };\n',
    );
    assert.equal(counts["as-any"], 0);
    assert.equal(counts["any-annotation"], 0);
  });

  it("counts swallowed promise rejections", () => {
    const counts = count(
      "p.catch(() => {});\np.catch((_e) => undefined);\np.catch(() => null);\np.catch(async () => {});\np.catch((e) => log(e));\n",
    );
    assert.equal(counts["swallowed-catch-callback"], 4);
  });

  it("counts empty catch blocks but not ones with a reason comment", () => {
    const counts = count(
      "try { a(); } catch {}\ntry { a(); } catch (e) {\n}\ntry { a(); } catch {\n  // best effort: the file may be gone\n}\n",
    );
    assert.equal(counts["empty-catch-block"], 2);
  });

  it("counts raw console only in the inspector server", () => {
    const text = "console.log('x');\nconsole.error('y');\n";
    assert.equal(
      count(text, "mcpjam-inspector/server/a.ts")["server-console"],
      2,
    );
    assert.equal(
      count(text, "mcpjam-inspector/client/a.ts")["server-console"],
      0,
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
      ].join("\n"),
    );
    assert.equal(counts["history-comment"], 3);
  });

  it("does not count MCP protocol versions as history", () => {
    const counts = count(
      [
        "// 2026-07-28 servers omit X.",
        "// A 2025-11-25 server can land on the legacy wire.",
        "// Spec 2025-06-18, changed on 2026-09-24.",
      ].join("\n"),
    );
    assert.equal(counts["history-comment"], 1);
  });

  it("counts suppressions", () => {
    const counts = count(
      "// @ts-nocheck\n// @ts-ignore\n// @ts-expect-error\n/* eslint-disable no-console */\n",
    );
    assert.equal(counts["ts-suppression"], 3);
    assert.equal(counts["eslint-disable"], 1);
  });
});


describe("ui strings", () => {
  const texts = (source) => extractUiStrings(source).map((item) => item.text);

  it("finds copy in literals, templates, attributes and JSX text", () => {
    const found = extractUiStrings(
      [
        'toast.error("Failed to import servers. Try again.");',
        "toast.error(`Failed to import servers: ${errorMessage}`);",
        'throw new Error("Choose an image that is 5 MB or smaller.");',
        "return (",
        '  <p title="Reload MCPJam to try again">',
        "    Don't worry, your",
        "    work is saved",
        "  </p>",
        ");",
      ].join("\n")
    );
    assert.deepEqual(found, [
      { line: 1, text: "Failed to import servers. Try again." },
      { line: 2, text: "Failed to import servers: ${errorMessage}" },
      { line: 3, text: "Choose an image that is 5 MB or smaller." },
      { line: 5, text: "Reload MCPJam to try again" },
      { line: 5, text: "Don't worry, your work is saved" },
    ]);
  });

  it("skips class names, paths, logs, identifiers and comments", () => {
    assert.deepEqual(
      texts(
        [
          'import { toast } from "@/lib/toast";',
          '// a comment with "quoted words" in it',
          '/* and a block comment "with more" */',
          'const cls = "flex items-center gap-2";',
          '<div className="text-sm text-muted-foreground" data-testid="row one" />',
          'console.log("not user facing text");',
          'logger.warn("not user facing either");',
          'const url = "https://mcpjam.com/docs here";',
          'const style = "0.75rem 1.5rem";',
          'const flag = "SOME_CONSTANT NAME";',
        ].join("\n")
      ),
      []
    );
  });

  it("does not read operators, generics or regexes as JSX text", () => {
    assert.deepEqual(
      texts(
        [
          "if (a > b && c < d) return null;",
          "const re = /\"['\"]/g;",
          'function f(x: Foo<string>) { return g("Keep this label"); }',
          '{count > 0 ? <Empty label="No results yet" /> : "Loading your servers"}',
          '<span>{"—"}</span>',
          '<Button onClick={() => save()}>Save changes</Button>',
          "element: <Boundary />,",
          "children: [",
          "  // a comment — about the route",
          '  { path: "*" },',
        ].join("\n")
      ),
      ["Keep this label", "No results yet", "Loading your servers", "Save changes"]
    );
  });

  it("reports copy a change adds, not copy it moves", () => {
    const before = '<p>\n  Nothing here yet\n</p>\n<p>Try again</p>';
    const after = '<p>Try again</p>\n<p>Nothing here yet</p>\n<p>Saved to your project</p>';
    assert.deepEqual(addedCopy(before, after), [
      { line: 3, text: "Saved to your project" },
    ]);
  });

  it("scopes the copy rules to UI packages", () => {
    assert.equal(isUiFile("mcpjam-inspector/client/src/App.tsx"), true);
    assert.equal(isUiFile("chat-ui/src/parts/text.tsx"), true);
    assert.equal(isUiFile("mcpjam-inspector/server/routes/a.ts"), false);
    assert.equal(isUiFile("sdk/src/index.ts"), false);
  });

  it("counts dashes, filler and vague errors only in copy", () => {
    const source = [
      "// history — not copy",
      '<div className="flex — gap" />',
      'toast.error("Something went wrong");',
      'toast.error("Oops! An error occurred — please try again.");',
      'toast.error("Could not save the server. Check the URL and try again.");',
      '<p>Leverage seamless, robust tooling</p>',
      '<p>Fix prompt copied — paste it into your agent</p>',
      '<p>The local harness is ready</p>',
    ].join("\n");
    const counts = countFile("mcpjam-inspector/client/src/A.tsx", source);
    assert.equal(counts["ui-dash"], 2);
    assert.equal(counts["ui-filler"], 1);
    assert.equal(counts["ui-vague-error"], 2);
    assert.equal(countFile("sdk/src/a.ts", source)["ui-dash"], 0);
  });
});


describe("copy review", () => {
  const repo = mkdtempSync(join(tmpdir(), "slop-copy-"));
  after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  const ui = "mcpjam-inspector/client/src/A.tsx";
  mkdirSync(join(repo, "mcpjam-inspector/client/src"), { recursive: true });
  mkdirSync(join(repo, ".agents/skills/ui-copy"), { recursive: true });
  writeFileSync(
    join(repo, ".agents/skills/ui-copy/SKILL.md"),
    "---\nname: ui-copy\n---\n# Rubric\nvague-error: say what failed.\n"
  );
  writeFileSync(join(repo, ui), '<p>Try again</p>\n');
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("add", ".");
  git("commit", "-qm", "base");
  writeFileSync(
    join(repo, ui),
    '<p>Try again</p>\ntoast.error("Something went wrong");\ntoast.error(`Saved ${name} to your project`);\n'
  );
  const cwd = process.cwd();
  const inRepo = (fn) => {
    process.chdir(repo);
    try {
      return fn();
    } finally {
      process.chdir(cwd);
    }
  };

  it("lists the copy a change added with its source line", () => {
    const items = inRepo(() => collectAdded("HEAD"));
    assert.deepEqual(items, [
      { id: 1, path: ui, line: 2, text: "Something went wrong", source: 'toast.error("Something went wrong");' },
      { id: 2, path: ui, line: 3, text: "Saved ${name} to your project", source: "toast.error(`Saved ${name} to your project`);" },
    ]);
  });

  it("turns a rewrite into a one-line suggestion when the copy sits on one line", () => {
    assert.equal(
      suggestion('toast.error("Something went wrong");', "Something went wrong", "Could not save."),
      'toast.error("Could not save.");'
    );
    assert.equal(suggestion("<p>", "spans two lines", "x"), null);
  });

  it("escapes the rewrite for the literal it sits in, or gives up", () => {
    assert.equal(
      suggestion("toast.error('Failed to save');", "Failed to save", "Couldn't save. Try again."),
      "toast.error('Couldn\\'t save. Try again.');"
    );
    assert.equal(
      suggestion('t("Say \\"hi\\" now");', 'Say \\"hi\\" now', 'Say "hello"'),
      't("Say \\"hello\\"");'
    );
    assert.equal(
      suggestion("toast.error(`Saved ${name}`);", "Saved ${name}", "Saved ${name} to `main`"),
      "toast.error(`Saved ${name} to \\`main\\``);"
    );
    assert.equal(suggestion("<p>Old copy here</p>", "Old copy here", "New copy"), "<p>New copy</p>");
    assert.equal(suggestion("<p>Old copy here</p>", "Old copy here", "Use {count}"), null);
    assert.equal(suggestion("      Old copy here", "Old copy here", "New copy"), "      New copy");
    assert.equal(suggestion("x(y, Old copy here)", "Old copy here", "New"), null);
    assert.equal(suggestion('t("Old copy here")', "Old copy here", "Two\nlines"), null);
    const finding = { path: ui, line: 2, text: "Something went wrong", source: 'toast.error("Something went wrong");', pattern: "vague-error", note: "names no cause", rewrite: "Could not save." };
    const body = commentBody(finding);
    assert.match(body, /```suggestion\ntoast\.error\("Could not save\."\);\n```/);
    assert.ok(body.endsWith(marker(finding)));
  });

  it("classifies every string, in batches, and lists them all in the report", async () => {
    const many = Array.from({ length: BATCH + 1 }, (_, i) => ({ id: i + 1, path: ui, text: `String ${i + 1} here`, source: "" }));
    const batches = [];
    const fake = async (request) => {
      batches.push(JSON.parse(request.user).length);
      return { items: [], usage: { input_tokens: 10, output_tokens: 1 } };
    };
    const result = await classify(many, "rubric", fake);
    assert.deepEqual(batches, [BATCH, 1]);
    assert.equal(result.usage.input_tokens, 20);
    const logged = [];
    const log = console.log;
    console.log = (text) => logged.push(text);
    try {
      report({ items: many.slice(0, 2), findings: [], usd: 0, waived: false, posted: 0 });
    } finally {
      console.log = log;
    }
    assert.match(logged[0], /String 1 here[\s\S]*String 2 here/);
  });

  it("classifies with Haiku, rewrites with Sonnet, and fails without a waiver", async () => {
    const calls = [];
    const fake = async (request) => {
      calls.push(request);
      if (request.model === MODELS.classify) {
        assert.match(request.system, /vague-error/);
        return { items: [{ id: 1, pattern: "vague-error", note: "names no cause" }], usage: { input_tokens: 1000, output_tokens: 50 } };
      }
      assert.deepEqual(JSON.parse(request.user).map((item) => item.id), [1]);
      return { items: [{ id: 1, text: "Could not save." }], usage: { input_tokens: 500, output_tokens: 20 } };
    };
    const code = await inRepo(() => reviewCopy(["--base", "HEAD", "--dry-run"], fake));
    assert.equal(code, 1);
    assert.deepEqual(calls.map((request) => request.model.id), ["claude-haiku-5-5", "claude-sonnet-5-5"]);
    process.env.SLOP_WAIVER = "true";
    try {
      assert.equal(await inRepo(() => reviewCopy(["--base", "HEAD", "--dry-run"], fake)), 0);
    } finally {
      delete process.env.SLOP_WAIVER;
    }
  });

  it("sends a structured-output request and surfaces a refusal", async () => {
    let body;
    const ok = async (_url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: '{"items":[{"id":1}]}' }], usage: {} }) };
    };
    const result = await callClaude({ model: MODELS.classify, system: "s", user: "u", format: { type: "object" }, effort: "low" }, ok);
    assert.deepEqual(result.items, [{ id: 1 }]);
    assert.equal(body.model, "claude-haiku-5-5");
    assert.equal(body.output_config.format.type, "json_schema");
    assert.equal(body.output_config.effort, "low");
    const refused = async () => ({ ok: true, json: async () => ({ stop_reason: "refusal", stop_details: { category: "general_harms" }, content: [] }) });
    await assert.rejects(callClaude({ model: MODELS.classify, system: "s", user: "u", format: {} }, refused), /declined/);
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

  it("exits 2, not 1, when the base cannot be resolved", () => {
    const result = spawnSync("node", [RATCHET, "--base", "no-such-ref"], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /no-such-ref/);
  });

  it("reports but passes under a waiver", () => {
    const result = run({ SLOP_WAIVER: "true" });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Waived/);
  });
});

describe("deletion bot check", async () => {
  const { checkLane, codeOnly, MAX_LINES } =
    await import("./deletion-bot-check.mjs");
  const CHECK = join(
    dirname(fileURLToPath(import.meta.url)),
    "deletion-bot-check.mjs",
  );
  const lines = (n) => () => n;

  it("accepts pure deletions in the dead-files lane", () => {
    const { problems } = checkLane(
      "dead-files",
      [{ status: "D", path: "a.ts" }],
      { before: () => "", after: () => "", linesOf: lines(40) },
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
      { before: () => "", after: () => "", linesOf: lines(MAX_LINES) },
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
      { before: () => before, after: () => after, linesOf: lines(5) },
    );
    assert.deepEqual(problems, []);
  });

  it("catches code hidden behind a comment marker", () => {
    assert.notEqual(
      codeOnly("/* fixed in #123 */ doThing();"),
      codeOnly("/* why */ doOther();"),
    );
    assert.notEqual(
      codeOnly("class A {\n  *gen() {}\n}"),
      codeOnly("class A {\n  *other() {}\n}"),
    );
    assert.notEqual(
      codeOnly("const a = 1; // #5474"),
      codeOnly("const a = 2;"),
    );
    assert.notEqual(
      codeOnly('const s = "a  b"; // #5474'),
      codeOnly('const s = "a b";'),
    );
    assert.notEqual(
      codeOnly("const t = `x\n  y`;"),
      codeOnly("const t = `x\ny`;"),
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
  const { checkNewPath, checkEdit, editFragments, FILE_BUDGET } =
    await import("./hook.mjs");
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
      }),
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
      "sdk/src/a.ts",
    );
    assert.equal(
      repoPath("C:\\repo\\sdk\\src\\a.ts", "C:\\repo", win32),
      "sdk/src/a.ts",
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
      },
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
      }),
    );
    assert.equal(failures.length, 4);
  });

  it("only warns when an already-large file grows", () => {
    const { failures, warnings } = checkChange(
      [{ status: "M", path: "sdk/src/huge.ts" }],
      sizes({ "sdk/src/huge.ts": 2000 }),
      sizes({ "sdk/src/huge.ts": 2050 }),
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
      sizes({ "sdk/src/big.test.ts": 5000, "sdk/src/huge.ts": 1900 }),
    );
    assert.deepEqual([failures, warnings], [[], []]);
  });
});

describe("pr-size verdict", async () => {
  const { verdict, parseNumstat, countPatchLines, parseLabels, LARGE, LIMIT } =
    await import("./pr-size.mjs");

  it("counts NUL-delimited paths, including non-ASCII and tab ones", () => {
    const output = [
      "10\t2\tsdk/src/caf\u00e9.ts",
      "5\t0\tsdk/src/a.test.ts",
      "-\t-\tdocs/logo.png",
      "3\t3\tmcpjam-inspector/client/src/App.tsx",
      "4\t0\tsdk/src/weird\tname.ts",
      "-\t-\tsdk/src/opaque.ts",
      "",
    ].join("\0");
    const { files, uncounted } = parseNumstat(output);
    assert.deepEqual(
      files.map((file) => [file.path, file.lines]),
      [
        ["sdk/src/caf\u00e9.ts", 12],
        ["mcpjam-inspector/client/src/App.tsx", 6],
        ["sdk/src/weird\tname.ts", 4],
      ],
    );
    assert.deepEqual(uncounted, ["sdk/src/opaque.ts"]);
  });

  it("counts patch lines inside hunks only", () => {
    const patch = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1 +1,2 @@",
      "-old",
      "+--flag",
      "+++counter",
    ].join("\n");
    assert.equal(countPatchLines(patch), 3);
  });

  it("counts source files a -diff attribute marks as binary", () => {
    const repo = mkdtempSync(join(tmpdir(), "slop-size-"));
    try {
      const git = (...args) =>
        execFileSync("git", args, { cwd: repo, encoding: "utf8" });
      git("init", "-q");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "test");
      writeFileSync(join(repo, ".gitattributes"), "*.ts -diff\n");
      git("add", ".");
      git("commit", "-qm", "base");
      mkdirSync(join(repo, "sdk/src"), { recursive: true });
      writeFileSync(
        join(repo, "sdk/src/a.ts"),
        "export const a = 1;\n".repeat(5),
      );
      git("add", ".");
      git("commit", "-qm", "add");
      const out = execFileSync(
        "node",
        [
          join(dirname(fileURLToPath(import.meta.url)), "pr-size.mjs"),
          "--base",
          "HEAD^1",
        ],
        {
          cwd: repo,
          encoding: "utf8",
          env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
        },
      );
      assert.match(out, /\*\*5\*\* changed lines/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("keeps a label with a comma in its name whole", () => {
    assert.deepEqual(parseLabels('["review,mechanical"]'), [
      "review,mechanical",
    ]);
    assert.equal(
      verdict(LIMIT + 1, parseLabels('["review,mechanical"]')),
      "fail",
    );
    assert.deepEqual(parseLabels(undefined), []);
    assert.throws(() => parseLabels('"mechanical"'), /JSON array/);
  });

  it("is ok within budget", () => {
    assert.equal(verdict(LARGE, []), "ok");
  });

  it("flags a large PR and accepts either label", () => {
    assert.equal(verdict(LARGE + 1, []), "large");
    assert.equal(verdict(LARGE + 1, ["large-pr"]), "large-labelled");
    assert.equal(verdict(LARGE + 1, ["mechanical"]), "large-labelled");
  });

  it("fails over the hard limit unless mechanical", () => {
    assert.equal(verdict(LIMIT + 1, ["large-pr"]), "fail");
    assert.equal(verdict(LIMIT + 1, ["mechanical"]), "large-labelled");
  });
});

describe("hooks in a worktree", async () => {
  const { snapshotFile } = await import("./hook.mjs");
  const SLOP = dirname(fileURLToPath(import.meta.url));
  // Resolved: node runs a symlinked script under its real path, and the hook
  // runs only when it is the main module (macOS /var is /private/var).
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "slop-hook-")));
  after(() => rmSync(temp, { recursive: true, force: true }));
  const git = (cwd, ...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8" });
  /** A repository with these scripts committed, so it can run its own hook. */
  const makeRepo = (name) => {
    const dir = join(temp, name);
    mkdirSync(join(dir, "sdk/src"), { recursive: true });
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "test@example.com");
    git(dir, "config", "user.name", "test");
    cpSync(SLOP, join(dir, "scripts/slop"), { recursive: true });
    writeFileSync(join(dir, "sdk/src/a.ts"), "export const a = 1;\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "base");
    return dir;
  };
  const run = (event, hook) =>
    spawnSync("node", [hook], {
      input: JSON.stringify(event),
      encoding: "utf8",
    });

  // The hook loads from the main checkout, as `$CLAUDE_PROJECT_DIR` does in
  // a worktree session, and the session works in the worktree.
  const repo = makeRepo("repo");
  // The ratchet compares with origin/main, which a fresh repo lacks.
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  const wt = join(temp, "wt");
  git(repo, "worktree", "add", "-q", "--detach", wt);
  const HOOK = join(repo, "scripts/slop/hook.mjs");
  const hook = (event) => run(event, HOOK).status;

  it("checks an edit in the session's worktree, not the hook's checkout", () => {
    writeFileSync(join(wt, "sdk/src/a.ts"), "export const a = b as any;\n");
    const code = hook({
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: {
        file_path: join(wt, "sdk/src/a.ts"),
        old_string: "1",
        new_string: "b as any",
      },
    });
    assert.equal(code, 2);
    git(wt, "checkout", "--", "sdk/src/a.ts");
  });

  it("leaves another repository alone", () => {
    const other = makeRepo("other");
    git(other, "update-ref", "refs/remotes/origin/main", "HEAD");
    const newRootFile = (dir) => ({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: join(dir, "PLAN.md"), content: "plan" },
    });
    assert.equal(hook(newRootFile(wt)), 2);
    assert.equal(hook(newRootFile(other)), 0);
    writeFileSync(join(other, "sdk/src/a.ts"), "export const a = b as any;\n");
    assert.equal(
      hook({
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: {
          file_path: join(other, "sdk/src/a.ts"),
          old_string: "1",
          new_string: "b as any",
        },
      }),
      0,
    );
    assert.equal(hook({ hook_event_name: "Stop", cwd: other }), 0);
  });

  it("counts files created during the turn, not files that were already there", () => {
    const session = `test-${process.pid}-${Date.now()}`;
    writeFileSync(join(wt, "sdk/src/before.ts"), "p.catch(() => {});\n");
    assert.equal(
      hook({
        hook_event_name: "UserPromptSubmit",
        cwd: wt,
        session_id: session,
      }),
      0,
    );
    assert.equal(
      hook({ hook_event_name: "Stop", cwd: wt, session_id: session }),
      0,
    );
    // What a Bash command might create: no Edit or Write hook saw it.
    writeFileSync(
      join(wt, "sdk/src/during.ts"),
      "export const d = x as any;\n",
    );
    assert.equal(
      hook({ hook_event_name: "Stop", cwd: wt, session_id: session }),
      2,
    );
    rmSync(join(wt, "sdk/src/before.ts"));
    rmSync(join(wt, "sdk/src/during.ts"));
    rmSync(snapshotFile(session, realpathSync(wt)), { force: true });
  });

  it("lets the turn end when the ratchet itself fails", () => {
    // No origin/main: the ratchet cannot find a base.
    const bare = makeRepo("no-origin");
    const result = run(
      { hook_event_name: "Stop", cwd: bare },
      join(bare, "scripts/slop/hook.mjs"),
    );
    assert.equal(result.status, 0);
    assert.match(result.stderr, /slop Stop check skipped/);
  });

  it("ignores an unwritable GITHUB_STEP_SUMMARY", () => {
    const result = spawnSync("node", [HOOK], {
      input: JSON.stringify({ hook_event_name: "Stop", cwd: wt }),
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: "/nonexistent/dir/summary.md",
      },
    });
    assert.equal(result.status, 0);
  });

  it("stops on tracked changes but not on someone's untracked files", () => {
    writeFileSync(join(wt, "sdk/src/scratch.ts"), "p.catch(() => {});\n");
    assert.equal(hook({ hook_event_name: "Stop", cwd: wt }), 0);
    writeFileSync(join(wt, "sdk/src/a.ts"), "export const a = b as any;\n");
    assert.equal(hook({ hook_event_name: "Stop", cwd: wt }), 2);
  });
});

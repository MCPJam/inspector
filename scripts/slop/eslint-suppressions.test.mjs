import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { compare } from "./eslint-suppressions.mjs";

const CHECK = join(
  dirname(fileURLToPath(import.meta.url)),
  "eslint-suppressions.mjs",
);
const FILE = "sdk/eslint-suppressions.json";

const BASE = {
  "src/a.ts": {
    "prettier/prettier": { count: 3 },
    "@typescript-eslint/no-unused-vars": { count: 1 },
  },
  "src/b.ts": { "prettier/prettier": { count: 2 } },
};

describe("compare", () => {
  it("passes a decrease and a removed entry", () => {
    assert.deepEqual(
      compare(BASE, { "src/a.ts": { "prettier/prettier": { count: 1 } } }),
      [],
    );
  });

  it("reports a raised count, a new rule and a new path", () => {
    assert.deepEqual(
      compare(BASE, {
        ...BASE,
        "src/a.ts": {
          ...BASE["src/a.ts"],
          "prettier/prettier": { count: 4 },
          "no-empty": { count: 1 },
        },
        "src/new.ts": { "prettier/prettier": { count: 1 } },
      }),
      [
        { path: "src/a.ts", rule: "prettier/prettier", before: 3, after: 4 },
        { path: "src/a.ts", rule: "no-empty", before: 0, after: 1 },
        { path: "src/new.ts", rule: "prettier/prettier", before: 0, after: 1 },
      ],
    );
  });
});

describe("eslint suppressions ratchet", () => {
  const repo = mkdtempSync(join(tmpdir(), "eslint-suppressions-"));
  after(() => rmSync(repo, { recursive: true, force: true }));

  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  const write = (suppressions) => {
    mkdirSync(dirname(join(repo, FILE)), { recursive: true });
    writeFileSync(join(repo, FILE), JSON.stringify(suppressions, null, 2));
  };
  const run = (base = "base", env = {}) => {
    const result = spawnSync("node", [CHECK, FILE, "--base", base], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, SLOP_WAIVER: "", ...env },
    });
    return {
      code: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };

  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("commit", "-q", "--allow-empty", "-m", "before the baseline");
  git("tag", "empty");
  write(BASE);
  git("add", ".");
  git("commit", "-qm", "base");
  git("tag", "base");

  it("passes the change that adds the baseline", () => {
    const result = run("empty");
    assert.equal(result.code, 0);
    assert.match(result.stdout, /adds the baseline/);
  });

  it("fails when a count goes up", () => {
    write({
      ...BASE,
      "src/b.ts": { "prettier/prettier": { count: 3 } },
    });
    const result = run();
    assert.equal(result.code, 1);
    assert.match(result.stdout, /src\/b\.ts: prettier\/prettier 2 -> 3/);
  });

  it("fails when the baseline gains a path", () => {
    write({ ...BASE, "src/new.ts": { "no-empty": { count: 1 } } });
    const result = run();
    assert.equal(result.code, 1);
    assert.match(result.stdout, /src\/new\.ts: no-empty 0 -> 1/);
  });

  it("passes when a count goes down", () => {
    write({ ...BASE, "src/b.ts": { "prettier/prettier": { count: 1 } } });
    assert.equal(run().code, 0);
  });

  it("reports but passes under a waiver", () => {
    write({ ...BASE, "src/new.ts": { "no-empty": { count: 1 } } });
    const result = run("base", { SLOP_WAIVER: "true" });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Waived/);
  });

  it("exits 2, not 1, when the base cannot be resolved", () => {
    const result = run("no-such-ref");
    assert.equal(result.code, 2);
    assert.match(result.stderr, /no-such-ref/);
  });
});

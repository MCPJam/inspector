/**
 * The codemod's own guard rail.
 *
 * The scanner's whole value is that it refuses to propose a rename it cannot
 * justify. That refusal is the thing most likely to rot: a mapping widens, a
 * protected path is dropped to make a run go green, and the next person reads a
 * report that quietly proposes renaming a GitHub check run. So the refusal gets
 * its own test, driven over a throwaway tree rather than the repository — a
 * test that scanned the real repo would go red the day somebody legitimately
 * moved a file.
 */

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const SCANNER = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "codemod",
  "evals-vocabulary",
  "index.mjs"
);

const trees: string[] = [];
afterEach(() => {
  for (const tree of trees.splice(0))
    rmSync(tree, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "codemod-"));
  trees.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

function scan(root: string, mappingOverride?: unknown) {
  const extra: string[] = [];
  if (mappingOverride !== undefined) {
    const path = join(root, "__mapping.json");
    writeFileSync(path, JSON.stringify(mappingOverride));
    extra.push("--mapping", path);
  }
  const result = spawnSync(
    process.execPath,
    [SCANNER, "--root", root, "--json", ...extra],
    { encoding: "utf8" }
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json: result.stdout.trim() ? JSON.parse(result.stdout) : null,
  };
}

describe("the evaluator-vocabulary scanner", () => {
  it("proposes the renames the contract names, and says where", () => {
    const root = tree({
      "sdk/src/scorers/run.ts":
        `import type { Scorer } from "./types.js";\n` +
        `export async function runScorers(list: Scorer[]) { return list; }\n`,
    });
    const { status, json } = scan(root);

    expect(status).toBe(0);
    expect(json.status).toBe("ok");
    const proposed = json.findings.map((f: { from: string }) => f.from);
    expect(proposed).toContain("Scorer");
    expect(proposed).toContain("runScorers");
    expect(json.findings[0].file).toBe("sdk/src/scorers/run.ts");
  });

  it("fails rather than proposing a rename inside a protected path", () => {
    const root = tree({
      "mcpjam-inspector/server/routes/v1/eval-checks.ts":
        `import type { Scorer } from "@mcpjam/sdk";\n` +
        `export const repo: { scorer?: Scorer } = {};\n`,
    });
    const { status, json } = scan(root);

    expect(status).toBe(2);
    expect(json.status).toBe("protected");
    expect(json.violations[0].reason).toBe("protected path");
    expect(json.violations[0].file).toBe(
      "mcpjam-inspector/server/routes/v1/eval-checks.ts"
    );
  });

  it("fails rather than proposing a rename OF a protected term", () => {
    const root = tree({
      "sdk/src/platform/types.ts": `export type Row = { checkRunId: number };\n`,
    });
    // The committed mapping proposes no protected word, so the refusal is
    // exercised against one that does — which is the failure mode this guard
    // exists for: a mapping widened later until it swallows a GitHub check run.
    const { status, json } = scan(root, {
      renames: [
        { from: "checkRunId", to: "iterationRunId", scope: "wire-field" },
      ],
    });

    expect(status).toBe(2);
    expect(json.status).toBe("protected");
    expect(json.violations[0].matched).toBe("checkRunId");
    expect(json.violations[0].reason).toBe("protected term");
  });

  it("treats a grading check beside a GitHub check-run id as review, not refusal", () => {
    const root = tree({
      // Both words on one line in an adapter the mapping covers. The first is
      // in scope, the second is not, and they are told apart by the token
      // rather than by the line — so this reports rather than refusing.
      "sdk/src/platform/types.ts": `export type Row = { checks: string[]; checkRunId: number };\n`,
    });
    const { status, json } = scan(root);

    expect(status).toBe(0);
    expect(json.findings.map((f: { matched: string }) => f.matched)).toEqual([
      "checks",
    ]);
    expect(json.reviewByHand[0].nearby).toContain("checkRunId");
  });

  it("reports a rename that merely sits beside a protected term, without failing", () => {
    const root = tree({
      // `evaluatorErrorRate` is the EXISTING evaluator-error vocabulary and
      // already means the right thing. It lives beside real evaluator code all
      // over the verdict policy, so proximity is a review note, not a refusal.
      "sdk/src/contract/verdict-policy.ts":
        `import type { ScoreResult } from "./types.js";\n` +
        `export const rate = (rows: ScoreResult[], evaluatorErrorRate: number) => rows.length + evaluatorErrorRate;\n`,
    });
    const { status, json } = scan(root);

    expect(status).toBe(0);
    expect(json.reviewByHand.length).toBeGreaterThan(0);
    expect(json.reviewByHand[0].nearby).toContain("evaluatorErrorRate");
  });

  it("leaves the word alone when it is prose, not an identifier", () => {
    const root = tree({
      "sdk/src/notes.ts":
        `// A Scorer is mentioned here in a comment, and "Scorer" in a string.\n` +
        `export const label = "Scorer";\n`,
    });
    const { status, json } = scan(root);

    expect(status).toBe(0);
    expect(json.findings).toHaveLength(0);
  });

  it("leaves prose alone when it follows an interpolation", () => {
    const root = tree({
      // The regression that sent the first report wrong. A raw token scanner
      // has no parser context, so everything after `${...}` in a template came
      // back as ordinary identifiers — and the committed report proposed
      // renaming `Scorer` out of two error messages.
      "sdk/src/scorers/collide.ts":
        "export const message = (id: string) =>\n" +
        '  `Scorer id "${id}" is already used. Scorer ids must be unique.`;\n',
    });
    const { status, json } = scan(root);

    expect(status).toBe(0);
    expect(json.findings).toHaveLength(0);
  });

  it("leaves JSX text alone", () => {
    const root = tree({
      "mcpjam-inspector/client/src/components/evals/Row.tsx":
        "export const Row = () => <div>No Scorer configured</div>;\n",
    });
    const { status, json } = scan(root);

    expect(status).toBe(0);
    expect(json.findings).toHaveLength(0);
  });

  it("finds a wire field however it is declared or read", () => {
    const root = tree({
      "sdk/src/platform/types.ts":
        "export type A = { repetitions?: number };\n" +
        "export type B = { repetitions: number };\n" +
        "export const readOptional = (row: A) => row?.repetitions;\n" +
        "export const readPlain = (row: B) => row.repetitions;\n" +
        "export const shorthand = (repetitions: number) => ({ repetitions });\n",
    });
    const { status, json } = scan(root);

    expect(status).toBe(0);
    // Five shapes, five findings. The token lookahead this replaced saw only
    // the required declaration, which is why `repetitions?: number` in the
    // platform types was missing from the inventory it exists to produce.
    expect(
      json.findings.filter((f: { from: string }) => f.from === "repetitions")
    ).toHaveLength(5);
  });

  it("matches a whole flag, not a prefix of one", () => {
    const root = tree({
      "cli/src/commands/eval.ts":
        `const a = "--repetitions";\n` +
        `const b = "--repetitions=3";\n` +
        `const c = "--repetitions-old";\n`,
    });
    const { status, json } = scan(root);

    expect(status).toBe(0);
    // `--repetitions-old` is a DIFFERENT flag. Proposing to rename it would be
    // proposing to break it.
    const lines = json.findings
      .filter((f: { from: string }) => f.from === "--repetitions")
      .map((f: { line: number }) => f.line);
    expect(lines).toEqual([1, 2]);
  });

  it("keeps a subpath rename inside its own allowlist", () => {
    const root = tree({
      "cli/src/a.ts": `import "@mcpjam/sdk/predicates";\n`,
      "sdk/src/b.ts": `import "@mcpjam/sdk/predicates";\n`,
    });
    const { status, json } = scan(root, {
      renames: [
        {
          from: "@mcpjam/sdk/predicates",
          to: "@mcpjam/sdk/assertions",
          scope: "subpath",
          paths: ["sdk/"],
        },
      ],
    });

    expect(status).toBe(0);
    expect(json.findings.map((f: { file: string }) => f.file)).toEqual([
      "sdk/src/b.ts",
    ]);
  });

  it("fails closed when a path cannot be inspected", () => {
    const root = tree({ "sdk/src/a.ts": "export const a = 1;\n" });
    // A dangling symlink: an entry the walk can list and cannot stat. Chmod
    // would not do — the suite may run as a user for whom no file is
    // unreadable, and a guard that only fires for some users is not a guard.
    symlinkSync(join(root, "sdk/src/gone.ts"), join(root, "sdk/src/b.ts"));
    const { status, stderr } = scan(root);

    // An inventory with a hole in it reads as complete, and the next person
    // renames from it.
    expect(status).toBe(1);
    expect(stderr).toMatch(/could not be inspected/);
  });

  it("fails closed when it read nothing, even from a non-empty root", () => {
    const root = tree({ "assets/logo.png": "not really a png" });
    const { status, stderr } = scan(root);

    // The walk found a file. It read no SOURCE, so a clean empty report here
    // would be indistinguishable from a clean real one.
    expect(status).toBe(1);
    expect(stderr).toMatch(/No supported files were read/);
  });

  it("does not propose a wire-field rename outside the adapters that own it", () => {
    const root = tree({
      // `checks` as an object key, but in a file the mapping does not list —
      // GitHub check settings, conformance results, a UI reducer. Out of scope
      // is out of scope; it is not a finding and not a failure.
      "mcpjam-inspector/client/src/state/app-reducer.ts": `export const state = { checks: [] as string[] };\n`,
    });
    const { status, json } = scan(root);

    expect(status).toBe(0);
    expect(json.findings).toHaveLength(0);
  });

  it("fails closed when it scanned nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "codemod-empty-"));
    trees.push(root);
    const { status, stderr } = scan(root);

    // A scanner that reports "no occurrences" after reading zero files has said
    // nothing, and it looks exactly like a clean run.
    expect(status).toBe(1);
    expect(stderr).toMatch(/refusing to report a clean run/);
  });

  it("has no --write, and says why rather than ignoring the flag", () => {
    const root = tree({ "sdk/src/a.ts": "export const a = 1;\n" });
    const result = spawnSync(
      process.execPath,
      [SCANNER, "--root", root, "--write"],
      {
        encoding: "utf8",
      }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/no --write/);
  });
});

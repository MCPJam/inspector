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
  readFileSync,
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

/**
 * A throwaway tree that is also a git repository, with everything added.
 *
 * The scanner enumerates through `git ls-files` whenever its root is a work
 * tree, so ignore rules and tracked-but-absent paths can only be exercised in
 * one. Nothing is committed: `git add` is enough to make a path "cached".
 */
function gitTree(files: Record<string, string>): string {
  const root = tree(files);
  const run = (...gitArgs: string[]) => {
    const result = spawnSync("git", ["-C", root, ...gitArgs], {
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  run("init", "-q");
  run("add", "-A");
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

/** The markdown report, which is what a reviewer actually reads. */
function render(root: string, mappingOverride?: unknown) {
  const extra: string[] = [];
  if (mappingOverride !== undefined) {
    const path = join(root, "__mapping.json");
    writeFileSync(path, JSON.stringify(mappingOverride));
    extra.push("--mapping", path);
  }
  const result = spawnSync(
    process.execPath,
    [SCANNER, "--root", root, ...extra],
    {
      encoding: "utf8",
    }
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
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
        "export type A = { predicates?: string[] };\n" +
        "export type B = { predicates: string[] };\n" +
        "export const readOptional = (row: A) => row?.predicates;\n" +
        "export const readPlain = (row: B) => row.predicates;\n" +
        "export const shorthand = (predicates: string[]) => ({ predicates });\n",
    });
    const { status, json } = scan(root);

    expect(status).toBe(0);
    // Five shapes, five findings. The token lookahead this replaced saw only
    // the required declaration, which is why an optional field in the
    // platform types was missing from the inventory it exists to produce.
    expect(
      json.findings.filter((f: { from: string }) => f.from === "predicates")
    ).toHaveLength(5);
  });

  it("matches a whole flag, not a prefix of one", () => {
    const root = tree({
      "cli/src/commands/eval.ts":
        `const a = "--scorer-timeout";\n` +
        `const b = "--scorer-timeout=3";\n` +
        `const c = "--scorer-timeout-old";\n`,
    });
    // An override: the committed mapping renames no flag. The count flag it
    // once proposed (`--repetitions` to `--iterations`) is canonical, and the
    // flag matcher is tested here on a flag nobody is keeping.
    const { status, json } = scan(root, {
      renames: [
        {
          from: "--scorer-timeout",
          to: "--evaluator-timeout",
          scope: "flag",
          paths: ["cli/"],
        },
      ],
    });

    expect(status).toBe(0);
    // `--scorer-timeout-old` is a DIFFERENT flag. Proposing to rename it would
    // be proposing to break it.
    const lines = json.findings
      .filter((f: { from: string }) => f.from === "--scorer-timeout")
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
    const root = gitTree({
      "sdk/src/a.ts": "export const a = 1;\n",
      "sdk/src/b.ts": "export const b = 1;\n",
    });
    // A path git says is a source file and the disk says is a directory. Chmod
    // would not do — the suite may run as a user for whom no file is
    // unreadable, and a guard that only fires for some users is not a guard.
    rmSync(join(root, "sdk/src/b.ts"));
    mkdirSync(join(root, "sdk/src/b.ts"));
    const { status, stderr } = scan(root);

    // An inventory with a hole in it reads as complete, and the next person
    // renames from it.
    expect(status).toBe(1);
    expect(stderr).toMatch(/could not be inspected/);
    expect(stderr).toMatch(/sdk\/src\/b\.ts/);
  });

  it("skips a dangling symlink instead of refusing the whole run", () => {
    const root = tree({
      "sdk/src/a.ts": "export type A = Scorer;\n",
    });
    // The shape that sank a real run: an untracked skill symlink whose target
    // was never checked out. It names no source, so there is nothing in it to
    // rename — and failing on it made the tool unrunnable on a normal laptop.
    symlinkSync(join(root, "gone"), join(root, "sdk/src/b.ts"));
    const { status, json } = scan(root);

    expect(status).toBe(0);
    expect(json.findings.map((f: { file: string }) => f.file)).toEqual([
      "sdk/src/a.ts",
    ]);
    expect(json.skipped.map((s: { file: string }) => s.file)).toEqual([
      "sdk/src/b.ts",
    ]);
  });

  it("enumerates what git sees, so ignored directories are never walked", () => {
    const root = gitTree({
      ".gitignore": "worktrees/\nbuild-output/\n",
      "sdk/src/a.ts": "export type A = Scorer;\n",
      // A whole second checkout under an ignored directory: the reason a real
      // run took four and a half minutes and reported someone else's branch.
      "worktrees/other/sdk/src/a.ts": "export type A = Scorer;\n",
      "build-output/sdk/src/a.ts": "export type A = Scorer;\n",
    });
    // Untracked but not ignored is still the developer's source.
    writeFileSync(join(root, "sdk/src/new.ts"), "export type B = Scorer;\n");
    const { status, json } = scan(root);

    expect(status).toBe(0);
    expect(
      [...new Set(json.findings.map((f: { file: string }) => f.file))].sort()
    ).toEqual(["sdk/src/a.ts", "sdk/src/new.ts"]);
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

  it("fails closed when the parser reports a diagnostic", () => {
    const root = tree({
      "sdk/src/a.ts": "export const a = 1;\n",
      // `createSourceFile` does NOT throw on this. It recovers, and the
      // recovery swallows everything after the unterminated template — so
      // `Scorer` is simply absent from the tree, and a scanner that trusted
      // the absence of a throw would report this file as clean.
      "sdk/src/broken.ts": "const a = `unterminated\ntype Y = Scorer;\n",
    });
    const { status, stderr } = scan(root);

    expect(status).toBe(1);
    expect(stderr).toMatch(/could not be inspected/);
    expect(stderr).toMatch(/parse diagnostic/);
    expect(stderr).toMatch(/Unterminated template literal/);
  });

  it("reports a subpath named somewhere other than an import", () => {
    const root = tree({
      // The three shapes that broke the builds rather than the imports: an
      // alias key, an alias `find` value, and an `external` list entry.
      "mcpjam-inspector/server/tsup.config.ts":
        `export default { external: ["@mcpjam/sdk/predicates"],\n` +
        `  alias: { "@mcpjam/sdk/predicates": "../../sdk/src/predicates/index.ts" } };\n`,
      "mcpjam-inspector/server/vitest.config.ts": `export default { alias: [{ find: "@mcpjam/sdk/predicates", replacement: x }] };\n`,
      "sdk/src/a.ts": `import "@mcpjam/sdk/predicates";\n`,
    });
    const { status, json } = scan(root);

    expect(status).toBe(0);
    const subpath = json.findings
      .filter((f: { scope: string }) => f.scope === "subpath")
      // Sorted: the walk's order is the filesystem's, and this test is about
      // what gets reported, not about which directory was listed first.
      .map(
        (f: { file: string; line: number; shape: string }) =>
          `${f.file}:${f.line} ${f.shape}`
      )
      .sort();
    // The shape is told apart, so a reviewer knows which one is an import.
    expect(subpath).toEqual([
      "mcpjam-inspector/server/tsup.config.ts:1 module reference",
      "mcpjam-inspector/server/tsup.config.ts:2 module reference",
      "mcpjam-inspector/server/vitest.config.ts:1 module reference",
      "sdk/src/a.ts:1 import specifier",
    ]);
  });

  it("reports a wire field named in a string, still bounded by its paths", () => {
    const root = tree({
      // A Zod issue path and a settings-key array: both name the field, and
      // neither is a property declaration.
      "sdk/src/platform/operations.ts": `const issue = { path: ["predicates"], message: "x" };\n`,
      "mcpjam-inspector/client/src/components/evals/rows.ts": `const keys = { checks: ["defaultPredicates"] };\n`,
      // Same string, outside every allowlist. Path scope still governs.
      "mcpjam-inspector/client/src/state/app-reducer.ts": `const k = ["predicates"];\n`,
    });
    const { status, json } = scan(root);

    expect(status).toBe(0);
    expect(
      json.findings
        .map(
          (f: { file: string; matched: string; shape: string }) =>
            `${f.file} ${f.matched} ${f.shape}`
        )
        .sort()
    ).toEqual([
      "mcpjam-inspector/client/src/components/evals/rows.ts defaultPredicates field named in a string",
      "sdk/src/platform/operations.ts predicates field named in a string",
    ]);
  });

  it("reads a destructured field as the property, not the local it binds", () => {
    const root = tree({
      "sdk/src/platform/types.ts":
        // The field is `checks`; `localChecks` is a local that happens to
        // hold it. Blaming the local both misses the rename and proposes one
        // nobody asked for.
        `const { checks: localChecks } = row;\n` +
        // Shorthand: one identifier, both the field and the local.
        `const { predicates } = row;\n` +
        // An ARRAY binding reads a position. Its local is spelled like the
        // field and names no field at all.
        `const [defaultPredicates] = values;\n`,
    });
    const { status, json } = scan(root);

    expect(status).toBe(0);
    expect(
      json.findings
        .filter((f: { scope: string }) => f.scope === "wire-field")
        .map((f: { line: number; matched: string }) => `${f.line} ${f.matched}`)
        .sort()
    ).toEqual(["1 checks", "2 predicates"]);
  });

  it("sees an identifier rename destructured out of an import", () => {
    const root = tree({
      // The import site is the one line that MUST change when the export is
      // renamed, and a shorthand binding was being counted as a field only —
      // so identifier renames pulled in this way were absent from the report
      // while their call sites in the same file were listed.
      "sdk/src/a.ts":
        `const { runScorers } = await import("./scorers/run.js");\n` +
        `const rows = await runScorers([], ctx);\n`,
    });
    const { status, json } = scan(root);

    expect(status).toBe(0);
    expect(
      json.findings.map(
        (f: { line: number; shape: string }) => `${f.line} ${f.shape}`
      )
    ).toEqual(["1 identifier", "2 identifier"]);
  });

  it("reports a subpath named in a manifest or in prose", () => {
    const root = tree({
      // No AST for these, so the subpath scope could not see them at all: a
      // packaging assertion that imports the subpath from inside a shell
      // string, and a docs example a reader copies.
      "sdk/package.json": `{ "scripts": { "a": "node -e \\"await import('@mcpjam/sdk/predicates')\\"" } }\n`,
      "docs/guide.mdx": `Predicates live in \`@mcpjam/sdk/predicates\` today.\n`,
      // A DIFFERENT module that merely starts with the same text. Renaming it
      // would be proposing to break it.
      "docs/other.mdx": `See \`@mcpjam/sdk/predicates-legacy\` for the old shape.\n`,
      // `checks` in an English sentence is English. Wire fields stay out of
      // text files, which is the noise this design exists to avoid.
      "docs/prose.mdx": `The suite runs its checks and reports repetitions.\n`,
    });
    const { status, json } = scan(root);

    expect(status).toBe(0);
    expect(
      json.findings
        .map(
          (f: { file: string; line: number; shape: string }) =>
            `${f.file}:${f.line} ${f.shape}`
        )
        .sort()
    ).toEqual([
      "docs/guide.mdx:1 text reference",
      "sdk/package.json:1 text reference",
    ]);
  });

  it("lists every occurrence rather than the first sixty", () => {
    // The defect this pins is specific: the committed report stated 74
    // occurrences of one rename and listed 60, so the 14 a reader most needed
    // the tool for were the 14 it withheld.
    const lines = Array.from(
      { length: 70 },
      (_, i) => `export const s${i}: Scorer = x;`
    ).join("\n");
    const root = tree({ "sdk/src/many.ts": `${lines}\n` });
    const { status, stdout } = render(root);

    expect(status).toBe(0);
    const rows = stdout
      .split("\n")
      .filter((line) => line.startsWith("| `sdk/src/many.ts:"));
    expect(rows).toHaveLength(70);
    expect(stdout).toMatch(/70 occurrence\(s\)/);
    expect(stdout).not.toMatch(/more occurrence/);
  });

  it.each([
    "githubCheckRunId",
    "githubCheckTriggerId",
    "GithubCheckRepoConfigRow",
    "GITHUB_CHECKS_ENABLED",
    "connectEvalCheckRepoOperation",
  ])("refuses %s because its whole family is protected", (member) => {
    const root = tree({
      "sdk/src/platform/types.ts": `export const ${member} = 1;\n`,
    });
    // An exact-string denylist protected `githubCheck` and nothing spelled
    // after it, so a mapping proposing `githubCheckRunId` exited 0.
    const { status, json } = scan(root, {
      renames: [{ from: member, to: "iterationRunId", scope: "identifier" }],
    });

    expect(status).toBe(2);
    expect(json.status).toBe("protected");
    expect(
      json.violations.every(
        (v: { reason: string }) => v.reason === "protected term"
      )
    ).toBe(true);
    expect(json.violations.map((v: { from: string }) => v.from)).toContain(
      member
    );
  });

  it("refuses a protected family in the mapping even where no file uses it", () => {
    const root = tree({ "sdk/src/a.ts": "export const a = 1;\n" });
    // A mapping is a proposal whether or not today's tree happens to contain
    // the word. The next checkout that does must not be the first to find out.
    const { status, json } = scan(root, {
      renames: [{ from: "githubCheckRunId", to: "runId", scope: "identifier" }],
    });

    expect(status).toBe(2);
    expect(json.violations[0].from).toBe("githubCheckRunId");
    expect(json.violations[0].shape).toBe("mapping");
  });

  it("refuses to rename a billing trial, however it is spelled", () => {
    const root = tree({
      "sdk/src/a.ts":
        "export const trialPlan = 'pro';\nexport const isTrial = true;\n",
    });
    for (const from of ["trialPlan", "isTrial", "starterTrialsEnabled"]) {
      const { status, json } = scan(root, {
        renames: [{ from, to: "iterationPlan", scope: "identifier" }],
      });
      // A bad sweep here changes who gets charged.
      expect(status, from).toBe(2);
      expect(json.violations[0].reason, from).toBe("protected term");
    }
  });

  it.each([
    "mcpjam-inspector/client/src/components/sidebar/sidebar-trial-countdown.tsx",
    "mcpjam-inspector/client/src/hooks/useOrganizationBilling.ts",
    "mcpjam-inspector/client/src/components/organization/OrganizationCurrentPlanPanel.tsx",
    "convex/migrations/resetTrialsForBillingLaunch.ts",
    "convex/lib/entitlements.ts",
    "convex/billing.ts",
    "convex/billingNode.ts",
    "convex/billing/teamAllowance.ts",
    "convex/lib/pricing/resolve.ts",
  ])("refuses any rename inside billing file %s", (file) => {
    const root = tree({ [file]: "export type T = Scorer;\n" });
    const { status, json } = scan(root);

    expect(status).toBe(2);
    expect(json.violations[0].reason).toBe("protected path");
  });

  it("leaves eval verdict counters out of billing protection", () => {
    const root = tree({
      "sdk/src/contract/verdict-policy.ts":
        "export const c = { configuredTrials: 1, attemptedTrials: 1, minGradeableTrials: 1 };\n",
    });
    // Path-based billing protection is what lets a later eval-trial rename
    // proceed without touching billing. A pattern that swallowed these would
    // turn that rename into a fight with the guard.
    const { status, json } = scan(root, {
      renames: [
        "configuredTrials",
        "attemptedTrials",
        "minGradeableTrials",
      ].map((from) => ({
        from,
        to: from.replace("Trials", "Iterations"),
        scope: "wire-field",
        paths: ["sdk/src/contract/"],
      })),
    });

    expect(status).toBe(0);
    expect(json.findings).toHaveLength(3);
  });

  it.each([
    "mcpjam-inspector/server/routes/mcp/xaa.ts",
    "mcpjam-inspector/server/routes/web/xaa.ts",
    "mcpjam-inspector/server/routes/xaa-confidential-cimd.ts",
    "mcpjam-inspector/server/routes/xaa-client-metadata.ts",
    "mcpjam-inspector/server/services/xaa-mint.ts",
    "mcpjam-inspector/shared/xaa.ts",
    "mcpjam-inspector/client/src/lib/xaa/identity.ts",
    "sdk/src/oauth/client-identity.ts",
  ])(
    "refuses an assertion rename inside identity-assertion file %s",
    (file) => {
      const root = tree({ [file]: "export const assertion = sign(jwt);\n" });
      // These are identity assertions from a standards protocol (ID-JAG, SAML,
      // RFC 7523 client assertions), not eval assertions.
      const { status, json } = scan(root, {
        renames: [{ from: "assertion", to: "check", scope: "identifier" }],
      });

      expect(status).toBe(2);
      expect(json.violations[0].reason).toBe("protected path");
    }
  );

  it("scans GitHub Checks code for eval renames, since it may import the eval SDK", () => {
    const root = tree({
      "mcpjam-inspector/server/services/github-checks/check-plan.ts":
        `import type { Scorer } from "@mcpjam/sdk";\n` +
        `export const githubCheckRunId = 1;\n`,
    });
    const { status, json } = scan(root);

    // The directory is not categorically denied; its GitHub-owned identifiers
    // are. An eval import in it is an eval import.
    expect(status).toBe(0);
    expect(json.findings.map((f: { matched: string }) => f.matched)).toEqual([
      "Scorer",
    ]);
  });

  it("refuses to rename the customer-authored `checks:` key of mcpjam.yml", () => {
    const root = tree({
      "mcpjam-inspector/server/services/github-checks/resolver/mcpjamYaml.ts":
        "export const read = (root: { checks: unknown }) => root.checks;\n",
    });
    // Customers wrote that key into their own repositories. Renaming the
    // reader breaks every one of them on the next pull request.
    const scoped = scan(root, {
      renames: [
        {
          from: "checks",
          to: "assertions",
          scope: "wire-field",
          paths: ["mcpjam-inspector/server/services/github-checks/"],
        },
      ],
    });
    expect(scoped.status).toBe(2);
    expect(scoped.json.violations[0].reason).toBe("protected field");

    // Repository-wide is the same proposal with less honesty about it.
    const unscoped = scan(root, {
      renames: [{ from: "checks", to: "assertions", scope: "wire-field" }],
    });
    expect(unscoped.status).toBe(2);
    expect(unscoped.json.violations[0].reason).toBe("protected field");
  });

  it("keeps the configured count canonical in the committed mapping", () => {
    // Settled 2026-09-08 (#4774): `repetitions` is the configured count and
    // `--repetitions` its flag, with `--iterations` a deprecated alias.
    // `iteration` names one execution. Mapping the count onto `iterations`
    // would restore the retired word as canonical.
    const mapping = JSON.parse(
      readFileSync(join(dirname(SCANNER), "mapping.json"), "utf8")
    ) as { renames: Array<{ from: string; to: string }> };
    const counts = ["repetitions", "--repetitions", "--max-trials"];
    expect(mapping.renames.filter((r) => counts.includes(r.from))).toEqual([]);
    expect(
      mapping.renames.filter((r) => /^(--)?iterations$/.test(r.to))
    ).toEqual([]);
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

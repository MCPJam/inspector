/**
 * Keep user-facing CLI docs and adjacent notes on the 4.0 command paths.
 *
 * `docs/cli/migration.mdx` is the only page allowed to mention 3.x paths.
 */
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverCliTestFiles } from "../scripts/run-tests.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const CLI_ROOT = path.join(REPO_ROOT, "cli");
const CLI_DOCS_DIR = path.join(REPO_ROOT, "docs/cli");
const DOCS_JSON_PATH = path.join(REPO_ROOT, "docs/docs.json");

const MOVED_CLOUD_GROUPS = [
  "login",
  "logout",
  "whoami",
  "organizations",
  "projects",
  "eval",
  "chat-sessions",
  "sessions",
  "hosts",
  "environments",
  "capabilities",
  "personas",
  "journeys",
  "scenarios",
  "swarms",
  "user-testing",
  "images",
  "tunnel",
] as const;

const movedCloudGroupPattern = MOVED_CLOUD_GROUPS.join("|");

const EXTRA_DOC_PATHS = [
  "cli/README.md",
  "docs/reference/openapi.json",
  "docs/inspector/evals.mdx",
  "docs/inspector/computer.mdx",
  "docs/inspector/projects.mdx",
  "docs/getting-started.mdx",
  "docs/contributing/evals-architecture.mdx",
  "docs/hosted/overview.mdx",
  "docs/sandbox-images-ui-cli.md",
  "docs/code-first-evals-environments-design.md",
  "vitest/README.md",
] as const;

const EXTRA_SOURCE_ROOTS = [
  path.join(CLI_ROOT, "src"),
  path.join(REPO_ROOT, "sdk/src"),
] as const;

const STALE_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  {
    name: "root Cloud command path",
    re: new RegExp(
      "mcpjam (?:" + movedCloudGroupPattern + ")(?:\\s|…|\\x60|$)",
      "g"
    ),
  },
  {
    name: "npx @mcpjam/cli without cloud for moved groups",
    re: new RegExp(
      "@mcpjam/cli(?:@\\S+)?\\s+(?:" + movedCloudGroupPattern + ")\\b",
      "g"
    ),
  },
  {
    name: "old local MCP stderr listening line",
    re: /MCPJam MCP server listening on stdio/g,
  },
  {
    name: "stale /cli/reference#eval- anchor",
    re: /\/cli\/reference#eval-/g,
  },
];

function listFilesRecursive(
  directory: string,
  suffixes: readonly string[]
): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(child, suffixes));
      continue;
    }
    if (entry.isFile() && suffixes.some((suffix) => entry.name.endsWith(suffix))) {
      files.push(child);
    }
  }
  return files;
}

function listCliGuideDocs(): string[] {
  return readdirSync(CLI_DOCS_DIR)
    .filter((name) => name.endsWith(".mdx") && name !== "migration.mdx")
    .map((name) => path.join(CLI_DOCS_DIR, name));
}

function findingsIn(filePath: string, source: string): string[] {
  const findings: string[] = [];
  for (const { name, re } of STALE_PATTERNS) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      const line = source.slice(0, match.index).split("\n").length;
      findings.push(`${path.relative(REPO_ROOT, filePath)}:${line}: ${name}`);
    }
  }
  return findings;
}

test("CLI 4.0 docs do not advertise 3.x Cloud command paths", () => {
  const files = [
    ...listCliGuideDocs(),
    ...EXTRA_DOC_PATHS.map((relative) => path.join(REPO_ROOT, relative)),
    ...EXTRA_SOURCE_ROOTS.flatMap((directory) =>
      listFilesRecursive(directory, [".ts", ".md"])
    ),
  ];
  const findings = files.flatMap((filePath) =>
    findingsIn(filePath, readFileSync(filePath, "utf8"))
  );
  assert.deepEqual(findings, [], findings.join("\n"));
});

test("CLI reference has one canonical cloud eval section", () => {
  const reference = readFileSync(
    path.join(CLI_DOCS_DIR, "reference.mdx"),
    "utf8"
  );
  const headings = reference.match(/^## `cloud eval` commands$/gm) ?? [];
  assert.equal(headings.length, 1);
});

test("CLI reference documents removing a Cloud project link", () => {
  const reference = readFileSync(
    path.join(CLI_DOCS_DIR, "reference.mdx"),
    "utf8"
  );
  assert.match(reference, /\| `--remove` \| Remove the nearest project link/);
});

test("CLI reference marks eval inspection --project as optional", () => {
  const reference = readFileSync(
    path.join(CLI_DOCS_DIR, "reference.mdx"),
    "utf8"
  );
  for (const heading of ["### `cloud eval iterations`", "### `cloud eval trace`"]) {
    const start = reference.indexOf(heading);
    assert.ok(start >= 0, `missing ${heading}`);
    const next = reference.indexOf("\n### ", start + heading.length);
    const section = reference.slice(start, next === -1 ? undefined : next);
    assert.match(
      section,
      /\| `--project <id-or-name>` \| No \|/,
      `${heading} must mark --project optional`
    );
    assert.match(
      section,
      /`--project` is optional\. Selection follows `--project`/,
      `${heading} must document selector precedence`
    );
    assert.doesNotMatch(
      section,
      /\| `--project <id-or-name>` \| Yes \|/,
      `${heading} must not mark --project required`
    );
  }
});

test("CLI overview documents Local vs Cloud and status validity", () => {
  const overview = readFileSync(path.join(CLI_DOCS_DIR, "overview.mdx"), "utf8");
  assert.match(overview, /The `mcpjam` CLI is two invocations/);
  assert.match(overview, /Local MCP testing stays at the top level/);
  assert.match(overview, /Account-bound commands live under `mcpjam cloud`/);
  assert.match(overview, /Credential precedence for Cloud commands/);
  assert.match(overview, /API URL precedence/);
  assert.match(overview, /mcpjam cloud link/);
  assert.match(overview, /mcpjam cloud status/);
  assert.match(overview, /credential\.valid/);
  assert.match(overview, /What `--host` means/);
  assert.doesNotMatch(overview, /The `mcpjam` CLI is a stateless/);
});

test("docs nav includes the CLI 4.0 migration page after overview", () => {
  const docsJson = JSON.parse(readFileSync(DOCS_JSON_PATH, "utf8")) as {
    navigation?: {
      tabs?: Array<{
        tab?: string;
        groups?: Array<{ pages?: unknown }>;
      }>;
    };
  };
  const cliTab = docsJson.navigation?.tabs?.find((tab) => tab.tab === "CLI");
  assert.ok(cliTab, "docs.json is missing the CLI tab");
  const guides = cliTab?.groups?.find((group) =>
    Array.isArray(group.pages) &&
    (group.pages as unknown[]).includes("cli/overview")
  );
  const pages = (guides?.pages ?? []) as string[];
  const overviewIndex = pages.indexOf("cli/overview");
  const migrationIndex = pages.indexOf("cli/migration");
  assert.ok(overviewIndex >= 0, "CLI Guides must list cli/overview");
  assert.equal(
    migrationIndex,
    overviewIndex + 1,
    "cli/migration must follow cli/overview in CLI Guides"
  );
});

test("CLI test runner discovers every tests/**/*.test.ts file", () => {
  const expected = listFilesRecursive(path.join(CLI_ROOT, "tests"), [
    ".test.ts",
  ]).sort();
  assert.ok(expected.length > 0, "expected at least one CLI test file");
  assert.deepEqual(discoverCliTestFiles(), expected);

  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "cli-discover-"));
  try {
    mkdirSync(path.join(fixtureRoot, "nested", "deeper"), { recursive: true });
    writeFileSync(path.join(fixtureRoot, "top.test.ts"), "");
    writeFileSync(path.join(fixtureRoot, "nested", "mid.test.ts"), "");
    writeFileSync(path.join(fixtureRoot, "nested", "deeper", "leaf.test.ts"), "");
    writeFileSync(path.join(fixtureRoot, "nested", "skip.ts"), "");
    writeFileSync(path.join(fixtureRoot, "nested", "notes.md"), "");
    const found = discoverCliTestFiles(fixtureRoot).map((filePath) =>
      path.relative(fixtureRoot, filePath)
    );
    assert.deepEqual(found, [
      path.join("nested", "deeper", "leaf.test.ts"),
      path.join("nested", "mid.test.ts"),
      "top.test.ts",
    ]);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }

  const pkg = JSON.parse(
    readFileSync(path.join(CLI_ROOT, "package.json"), "utf8")
  ) as { scripts?: { test?: string } };
  assert.equal(pkg.scripts?.test, "node scripts/run-tests.mjs");
  assert.doesNotMatch(pkg.scripts?.test ?? "", /\*\*/);
});

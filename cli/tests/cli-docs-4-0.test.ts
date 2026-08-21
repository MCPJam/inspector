/**
 * Keep user-facing CLI docs on the 4.0 command paths.
 *
 * `docs/cli/migration.mdx` is the only page allowed to mention 3.x paths.
 * Design notes and the HTTP public API are out of scope.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const CLI_DOCS_DIR = path.join(REPO_ROOT, "docs/cli");
const DOCS_JSON_PATH = path.join(REPO_ROOT, "docs/docs.json");

const EXTRA_DOC_PATHS = [
  "cli/README.md",
  "docs/inspector/evals.mdx",
  "docs/inspector/computer.mdx",
  "docs/getting-started.mdx",
  "docs/contributing/evals-architecture.mdx",
  "docs/sandbox-images-ui-cli.md",
  "vitest/README.md",
] as const;

const STALE_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "mcpjam eval (not under cloud)", re: /mcpjam eval(?:\s|…|`|$)/g },
  { name: "mcpjam tunnel (not under cloud)", re: /mcpjam tunnel(?:\s|`|$)/g },
  { name: "mcpjam images (not under cloud)", re: /mcpjam images(?:\s|`|$)/g },
  { name: "mcpjam hosts (not under cloud)", re: /mcpjam hosts(?:\s|`|$)/g },
  {
    name: "mcpjam environments (not under cloud)",
    re: /mcpjam environments(?:\s|`|$)/g,
  },
  { name: "mcpjam login (not oauth/cloud)", re: /mcpjam login\b/g },
  { name: "mcpjam chat-sessions", re: /mcpjam(?: cloud)? chat-sessions\b/g },
  { name: "--organization-id", re: /--organization-id\b/g },
  {
    name: "npx @mcpjam/cli without cloud for moved groups",
    re: /@mcpjam\/cli(?:@\S+)?\s+(eval|tunnel|images|hosts|environments|login)\b/g,
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
  ];
  const findings = files.flatMap((filePath) =>
    findingsIn(filePath, readFileSync(filePath, "utf8"))
  );
  assert.deepEqual(findings, [], findings.join("\n"));
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

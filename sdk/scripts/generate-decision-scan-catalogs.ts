/**
 * Writes MCPJam's own operation catalog, as MCP lists its tools, at the two
 * commits on either side of the change that took cross-tool directions out of
 * the hosted descriptions, to `tests/fixtures/decision-scan/`. The decision
 * scan's tests read it as a labelled real catalog: what the fix changed, and
 * what it left.
 *
 *   npm run generate:decision-scan-catalogs -w @mcpjam/sdk
 *   npm run generate:decision-scan-catalogs -w @mcpjam/sdk -- --check
 *
 * Each commit's `sdk/src` is extracted to a temporary folder and imported
 * against this checkout's `node_modules`; a missing commit is fetched from
 * `origin`. Every exported operation is kept, `listed` when it is in
 * `ALL_OPERATIONS`, the catalog MCP, the CLI and the agent registry list from;
 * the rest are operations under deprecated names, which no surface lists. A
 * tool keeps its name, its description and, from its input schema as MCP
 * serializes it, every description and the properties around it. The later
 * catalog is stored as the tools that changed.
 */

import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const SOURCE = {
  repository: "https://github.com/MCPJam/inspector",
  change: "https://github.com/MCPJam/inspector/pull/6951",
  before: "9943ecab8336e83cbc9c341e39ff9d9142c43a7c",
  after: "0eafeedada13af1ac4d7654e402032f30903254f",
};

const FIXTURE = fileURLToPath(
  new URL(
    "../tests/fixtures/decision-scan/mcpjam-catalogs.json",
    import.meta.url
  )
);

export interface CatalogTool {
  name: string;
  listed: boolean;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface CatalogFixture {
  source: typeof SOURCE;
  tools: CatalogTool[];
  /** The later commit's version of each tool it changed. */
  changed: CatalogTool[];
}

/** Both catalogs, the later one rebuilt from the tools that changed. */
export function loadMcpjamCatalogs() {
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as CatalogFixture;
  const changed = new Map(fixture.changed.map((tool) => [tool.name, tool]));
  const after = fixture.tools.map((tool) => changed.get(tool.name) ?? tool);
  return { source: fixture.source, before: fixture.tools, after };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A schema's descriptions, wherever they sit, and the structure that reaches
 * them. Property names stay too: a model reads them.
 */
function schemaText(schema: unknown): object | undefined {
  if (Array.isArray(schema)) {
    const list = schema.map((child) => schemaText(child) ?? {});
    const text = list.some((child) => Object.keys(child).length > 0);
    return text ? list : undefined;
  }
  if (!isRecord(schema)) return undefined;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "description" && typeof value === "string") {
      kept[key] = value;
    } else if (key === "properties" && isRecord(value)) {
      const properties = Object.entries(value);
      kept[key] = Object.fromEntries(
        properties.map(([name, child]) => [name, schemaText(child) ?? {}])
      );
    } else {
      const child = schemaText(value);
      if (child !== undefined) kept[key] = child;
    }
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

interface Operation {
  name: string;
  description: string;
  inputSchema: {
    "~standard": {
      jsonSchema: { input(options: { target: string }): unknown };
    };
  };
}

function isOperation(value: unknown): value is Operation {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    isRecord(value.inputSchema) &&
    "~standard" in value.inputSchema
  );
}

/** The catalog at one commit, imported from a copy of its `sdk/src`. */
async function catalogAt(commit: string, root: string): Promise<CatalogTool[]> {
  const folder = mkdtempSync(path.join(tmpdir(), "mcpjam-catalog-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args]);
  try {
    const archive = path.join(folder, "src.tar");
    // `package.json` too: its `"type": "module"` makes the copy load as ESM.
    git(
      "archive",
      `--output=${archive}`,
      commit,
      "sdk/src",
      "sdk/package.json"
    );
    execFileSync("tar", ["-xf", archive, "-C", folder]);
    // The copy resolves its packages from this checkout, as a workspace would.
    for (const modules of ["node_modules", "sdk/node_modules"]) {
      symlinkSync(path.join(root, modules), path.join(folder, modules), "dir");
    }
    const entry = pathToFileURL(path.join(folder, "sdk/src/platform/index.ts"));
    const platform = (await import(entry.href)) as Record<string, unknown>;
    const catalog = (platform.ALL_OPERATIONS as unknown[]).filter(isOperation);
    const listed = new Set(catalog.map(({ name }) => name));
    const operations = new Map<string, Operation>();
    for (const value of [...catalog, ...Object.values(platform)]) {
      if (isOperation(value) && !operations.has(value.name)) {
        operations.set(value.name, value);
      }
    }
    return [...operations.values()].map(
      ({ name, description, inputSchema }) => {
        // The conversion MCP's server applies to a tool's input schema.
        const json = inputSchema["~standard"].jsonSchema.input({
          target: "draft-2020-12",
        });
        const text = schemaText(json);
        const schema = isRecord(text) ? text : {};
        return {
          name,
          listed: listed.has(name),
          description,
          inputSchema: schema,
        };
      }
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

function hasCommit(root: string, commit: string): boolean {
  try {
    const args = ["-C", root, "cat-file", "-e", `${commit}^{commit}`];
    execFileSync("git", args, { stdio: "ignore" });
    return true;
  } catch {
    // Not in this clone yet (a shallow one, often): fetched below.
    return false;
  }
}

async function main(): Promise<void> {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  if (!hasCommit(root, SOURCE.before) || !hasCommit(root, SOURCE.after)) {
    // The later commit's parent is the earlier one, so one fetch brings both.
    const args = ["-C", root, "fetch", "--depth=2", "origin", SOURCE.after];
    execFileSync("git", args, { stdio: "inherit" });
  }
  const before = await catalogAt(SOURCE.before, root);
  const after = await catalogAt(SOURCE.after, root);
  const names = (tools: CatalogTool[]) => tools.map(({ name }) => name);
  if (!isDeepStrictEqual(names(before), names(after))) {
    throw new Error(
      "The commits list different operations: store both catalogs whole."
    );
  }
  const changed = after.filter(
    (tool, at) => !isDeepStrictEqual(tool, before[at])
  );
  // One tool per line: compact, and a diff still shows which tools moved.
  const rows = (tools: CatalogTool[]) =>
    tools.map((tool) => `    ${JSON.stringify(tool)}`).join(",\n");
  const text = `{\n  "source": ${JSON.stringify(SOURCE)},\n  "tools": [\n${rows(before)}\n  ],\n  "changed": [\n${rows(changed)}\n  ]\n}\n`;
  if (process.argv.includes("--check")) {
    if (readFileSync(FIXTURE, "utf8") !== text) {
      throw new Error(
        "The decision-scan catalogs are stale. Run `npm run generate:decision-scan-catalogs -w @mcpjam/sdk`."
      );
    }
    return;
  }
  writeFileSync(FIXTURE, text);
  const listed = before.filter((tool) => tool.listed).length;
  process.stdout.write(
    `${before.length} operations, ${listed} listed; the later commit changed ${changed.length}\n`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}

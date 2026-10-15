import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (file) => readFileSync(path.join(root, file), "utf8");
const manifest = (dir) => JSON.parse(read(`${dir}/package.json`));

// The MCP worker bundles its @mcpjam workspace dependencies, so a change to any
// of them changes what staging and production run.
function mcpWorkspaceDirs() {
  const dirByName = new Map(
    JSON.parse(read("package.json")).workspaces.map((dir) => [
      manifest(dir).name,
      dir,
    ])
  );
  const dirs = new Set(["mcp"]);
  for (const dir of dirs) {
    for (const name of Object.keys(manifest(dir).dependencies ?? {})) {
      if (dirByName.has(name)) dirs.add(dirByName.get(name));
    }
  }
  return [...dirs];
}

function stagingPaths() {
  const block = /^\s+paths:\n((?:\s+(?:-|#).*\n)+)/m.exec(
    read(".github/workflows/deploy-mcp-staging.yml")
  );
  assert.ok(block, "deploy-mcp-staging.yml must filter pushes by paths");
  return [...block[1].matchAll(/^\s+- "([^"]+)"$/gm)].map((m) => m[1]);
}

// One file under each staging trigger path. The workflow file itself is not a
// build input.
const stagingInputFiles = () =>
  stagingPaths()
    .filter((p) => p !== ".github/workflows/deploy-mcp-staging.yml")
    .map((p) => p.replace(/\*\*$/, "src/index.ts"));

function prodGate() {
  const source = /const isMcpRelevant = (\(filename\) =>[^;]+);/.exec(
    read(".github/workflows/deploy-mcp-prod.yml")
  );
  assert.ok(source, "deploy-mcp-prod.yml must define isMcpRelevant");
  return new Function(`return ${source[1]}`)();
}

function prodGateTouched() {
  const source = /const touched = (\(diff\.files \?\? \[\]\)[^;]+);/.exec(
    read(".github/workflows/deploy-mcp-prod.yml")
  );
  assert.ok(source, "deploy-mcp-prod.yml must compute touched from diff.files");
  return new Function("diff", "isMcpRelevant", `return ${source[1]}`);
}

test("staging redeploys when any workspace the MCP worker bundles changes", () => {
  const paths = stagingPaths();
  assert.deepEqual(
    mcpWorkspaceDirs().filter((dir) => !paths.includes(`${dir}/**`)),
    []
  );
});

// The prod gate promotes only when nothing it counts as MCP-relevant changed
// since the last green staging deploy, so it must count everything that
// triggers one.
test("the prod gate treats every staging trigger path as MCP-relevant", () => {
  const isMcpRelevant = prodGate();
  assert.deepEqual(
    stagingInputFiles().filter((file) => !isMcpRelevant(file)),
    []
  );
});

// The compare API reports a renamed file's old path only as previous_filename,
// and moving a file out of a build input changes the build too.
test("the prod gate counts files renamed out of an MCP-relevant path", () => {
  const touched = prodGateTouched();
  const isMcpRelevant = prodGate();
  for (const file of stagingInputFiles()) {
    const diff = {
      files: [{ filename: "moved/index.ts", previous_filename: file }],
    };
    assert.deepEqual(touched(diff, isMcpRelevant), [file]);
  }
});

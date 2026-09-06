#!/usr/bin/env node
/**
 * Exhaustive CLI test runner.
 *
 * Recursively discovers every tests/ file ending in .test.ts and invokes
 * the local tsx binary. Does not rely on shell glob expansion, which is
 * not performed by every shell (notably default zsh and Windows cmd).
 *
 * `npm test -w @mcpjam/cli` is the authoritative full-suite entrypoint. It
 * builds the SDK first, because the suite imports `@mcpjam/sdk` bare and tsx
 * resolves that to `sdk/dist`.
 *
 * `test:fast` skips the SDK build and is what the root `test:parallel:rest`
 * lane runs. The SDK build must not happen there: `sdk/tsup.config.ts` sets
 * `clean: true`, so rebuilding the SDK from one lane empties `sdk/dist` under
 * the sibling lanes, and whichever one happens to be resolving an
 * `@mcpjam/sdk/*` subpath at that moment fails with `Failed to resolve
 * import`. The root chain already builds the SDK once, in `test:checks`,
 * before any lane starts. Same split as `@mcpjam/mcp`.
 *
 * It does NOT skip the CLI's own build. The subprocess tests spawn
 * `cli/dist/index.js` rather than running `src/index.ts` under tsx, so
 * `pretest:fast` builds the CLI first. Unlike the SDK's, that build is safe to
 * run from this lane: `cli/dist` is read only by these tests, so `clean: true`
 * in cli/tsup.config.ts cannot empty it under a sibling.
 *
 * Invoke this script through `npm run test:fast`, not directly — running
 * `node scripts/run-tests.mjs` bypasses `pretest:fast` and would test whatever
 * `cli/dist` happens to hold. The guard below turns the absent case into a
 * named error; a STALE dist it cannot detect, which is the reason for this
 * paragraph.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = path.join(root, "tests");

export function discoverCliTestFiles(directory = testsDir) {
  const files = [];
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...discoverCliTestFiles(full));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function resolveTsxBinary() {
  const require = createRequire(import.meta.url);
  try {
    return require.resolve("tsx/cli");
  } catch {
    // Workspace-hoisted or file-layout fallback.
  }
  for (const candidate of [
    path.join(root, "node_modules", ".bin", "tsx"),
    path.join(root, "..", "node_modules", ".bin", "tsx"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "Could not resolve the local tsx binary. Install @mcpjam/cli devDependencies."
  );
}

function main() {
  const files = discoverCliTestFiles();
  if (files.length === 0) {
    process.stderr.write("No CLI test files found under tests/.\n");
    process.exit(1);
  }
  // The subprocess tests spawn the built CLI. Without this, a missing dist
  // surfaces as ~114 identical MODULE_NOT_FOUND failures with no hint of why.
  if (!existsSync(path.join(root, "dist", "index.js"))) {
    process.stderr.write(
      "cli/dist/index.js is missing — the subprocess tests spawn the built CLI.\n" +
        "Run `npm run test:fast -w @mcpjam/cli`, which builds it via pretest:fast,\n" +
        "or `npm run build -w @mcpjam/cli` before invoking this script directly.\n"
    );
    process.exit(1);
  }
  const tsx = resolveTsxBinary();
  const result = spawnSync(process.execPath, [tsx, "--test", ...files], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  process.exit(result.status ?? 1);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main();
}

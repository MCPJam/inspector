/**
 * The command surface, and the one rule it exists to enforce.
 *
 * `--submission-mode` is required for OpenAI and its inputs are checked
 * against the mode rather than the other way round. That asymmetry is the
 * whole point: inferring a mode from whichever inputs happen to be present
 * reads a forgotten `--package` as `mcp-only`, which reports the package lane
 * `not-applicable` and hands a submitter a clean bill of health for an
 * artifact nobody looked at. A usage error is the correct answer, and it has
 * to arrive BEFORE anything dials.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";
import { registerReadinessCommands } from "../src/commands/readiness.js";

/** The real Commander tree, built the way `src/index.ts` builds it. */
function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerReadinessCommands(program);
  return program;
}

/** Run the parser and return whatever it threw, or null when it did not. */
async function runExpectingError(argv: string[]): Promise<Error | null> {
  const program = buildProgram();
  try {
    await program.parseAsync(["node", "mcpjam", ...argv]);
    return null;
  } catch (error) {
    return error as Error;
  }
}

/** Walk the tree the way a user types, so the test proves the real path. */
function resolve(program: Command, path: string[]): Command | undefined {
  let current: Command | undefined = program;
  for (const name of path) {
    current = current?.commands.find(
      (candidate) =>
        candidate.name() === name || candidate.aliases().includes(name),
    );
    if (!current) return undefined;
  }
  return current;
}

test("the readiness group advertises both publishers under check", () => {
  const program = buildProgram();
  assert.ok(resolve(program, ["readiness", "check", "claude"]));
  assert.ok(resolve(program, ["readiness", "check", "openai"]));
});

test("openai refuses to run without a declared submission mode", async () => {
  // Commander enforces the requiredOption, which is what makes "never
  // inferred" true at the surface rather than only in the docblock.
  const error = await runExpectingError([
    "readiness",
    "check",
    "openai",
    "https://mcp.example.com/mcp",
  ]);
  assert.ok(error, "expected a usage error");
  assert.match(String(error), /submission-mode/i);
});

test("openai refuses an unknown submission mode", async () => {
  const error = await runExpectingError([
    "readiness",
    "check",
    "openai",
    "https://mcp.example.com/mcp",
    "--submission-mode",
    "not-a-mode",
  ]);
  assert.ok(error, "expected a usage error");
  assert.match(String(error), /submission mode/i);
});

test("a wire mode refuses a package it cannot upload", async () => {
  const error = await runExpectingError([
    "readiness",
    "check",
    "openai",
    "https://mcp.example.com/mcp",
    "--submission-mode",
    "mcp-only",
    "--package",
    "/tmp/does-not-matter",
  ]);
  assert.ok(error, "expected a usage error");
  assert.match(String(error), /does not upload a package/i);
});

test("a package mode refuses a URL it does not grade", async () => {
  const error = await runExpectingError([
    "readiness",
    "check",
    "openai",
    "https://mcp.example.com/mcp",
    "--submission-mode",
    "skills-only",
    "--package",
    "/tmp/does-not-matter",
  ]);
  assert.ok(error, "expected a usage error");
  assert.match(String(error), /package only/i);
});

test("a package mode refuses to run with no package", async () => {
  // The failure this whole guard exists for: without it the run grades an
  // empty submission and reports the package lane as inapplicable.
  const error = await runExpectingError([
    "readiness",
    "check",
    "openai",
    "--submission-mode",
    "skills-only",
  ]);
  assert.ok(error, "expected a usage error");
  assert.match(String(error), /uploaded package/i);
});

test("a wire mode refuses to run with no URL", async () => {
  const error = await runExpectingError([
    "readiness",
    "check",
    "openai",
    "--submission-mode",
    "mcp-only",
  ]);
  assert.ok(error, "expected a usage error");
  assert.match(String(error), /pass its URL/i);
});

test("a missing package path is a usage error, not a crash", async () => {
  const error = await runExpectingError([
    "readiness",
    "check",
    "openai",
    "--submission-mode",
    "skills-only",
    "--package",
    "/tmp/definitely-not-a-real-package-path-9f3a",
  ]);
  assert.ok(error, "expected a usage error");
  assert.match(String(error), /does not exist/i);
});

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { ALL_OPERATIONS } from "@mcpjam/sdk/platform";
import { CLI_BINDINGS } from "../src/lib/op-bindings.js";
import { registerCloudCommands } from "../src/commands/cloud.js";
import { registerReadinessCommands } from "../src/commands/readiness.js";
import { registerRegistryCommands } from "../src/commands/registry.js";

/**
 * The CLI's half of the operation-exposure ratchet.
 *
 * Two failure modes, both silent before this existed: an SDK operation ships
 * with no CLI command and nobody notices (that is how `list_eval_suite_runs`
 * became unreachable from a script), or a binding claims a command that was
 * renamed or never written, so the map asserts coverage that does not exist.
 */

/** A program carrying every command group that binds platform operations. */
function buildPlatformProgram(): Command {
  const program = new Command().name("mcpjam").exitOverride();
  registerCloudCommands(program);
  registerReadinessCommands(program);
  registerRegistryCommands(program);
  return program;
}

/**
 * Split a binding into the Commander path and any flag qualifiers.
 *
 * `registry install` is one visible command bound to TWO ops: directory by
 * default, card when `--card` is set. The flag stays on the binding string
 * so the test can prove both shelves exist without weakening the tree check
 * to "the parent command is registered".
 */
function parseBindingCommand(command: string): {
  path: string;
  flags: string[];
} {
  const tokens = command.split(" ").filter(Boolean);
  const path: string[] = [];
  const flags: string[] = [];
  for (const token of tokens) {
    if (token.startsWith("-")) flags.push(token);
    else path.push(token);
  }
  return { path: path.join(" "), flags };
}

/** Walk a command path like "eval cases run" through the Commander tree. */
function resolveCommandPath(
  program: Command,
  path: string,
): Command | undefined {
  let node: Command = program;
  for (const segment of path.split(" ")) {
    const next: Command | undefined = node.commands.find(
      (candidate) =>
        candidate.name() === segment || candidate.aliases().includes(segment),
    );
    if (!next) return undefined;
    node = next;
  }
  return node;
}

function commandDeclaresFlag(command: Command, flag: string): boolean {
  return command.options.some(
    (option) => option.long === flag || option.short === flag,
  );
}

describe("CLI operation bindings", () => {
  const names = ALL_OPERATIONS.map((operation) => operation.name);

  test("covers every SDK operation exactly once", () => {
    const uncovered = names.filter((name) => !(name in CLI_BINDINGS)).sort();
    assert.deepEqual(
      uncovered,
      [],
      `SDK operations with no CLI_BINDINGS entry — add a command, or an { excluded } reason:\n  ${uncovered.join(
        "\n  "
      )}`
    );
  });

  test("has no stale bindings", () => {
    const known = new Set(names);
    const stale = Object.keys(CLI_BINDINGS)
      .filter((name) => !known.has(name))
      .sort();
    assert.deepEqual(
      stale,
      [],
      `CLI_BINDINGS entries for operations that no longer exist — remove them:\n  ${stale.join(
        "\n  "
      )}`
    );
  });

  test("registry install flag-qualifies the two shelves on one Commander path", () => {
    // Isolated from `registerCloudCommands` so this assertion does not depend
    // on Commander.commandsGroup (Cloud help grouping). The dual-op binding
    // is the I3-specific contract this file was extended to prove.
    const program = new Command().name("mcpjam").exitOverride();
    registerRegistryCommands(program);
    const { path, flags } = parseBindingCommand("registry install --card");
    const node = resolveCommandPath(program, path);
    assert.ok(node, "registry install must exist");
    assert.ok(
      flags.every((flag) => commandDeclaresFlag(node!, flag)),
      "registry install --card must declare --card",
    );
    assert.ok(resolveCommandPath(program, "registry uninstall"));
    assert.ok(resolveCommandPath(program, "registry search"));
    assert.ok(resolveCommandPath(program, "registry show"));
    assert.ok(resolveCommandPath(program, "registry sources"));
    assert.ok(resolveCommandPath(program, "registry servers"));
    assert.ok(resolveCommandPath(program, "registry connections"));
  });

  test("every advertised command actually resolves in the CLI", () => {
    // The point of the whole file. A map entry is a claim; this is the proof.
    const program = buildPlatformProgram();
    const missing: string[] = [];
    for (const [name, binding] of Object.entries(CLI_BINDINGS)) {
      if (!("command" in binding)) continue;
      const { path, flags } = parseBindingCommand(binding.command);
      const node = resolveCommandPath(program, path);
      if (!node) {
        missing.push(`${name} -> "${binding.command}"`);
        continue;
      }
      const undeclared = flags.filter((flag) => !commandDeclaresFlag(node, flag));
      if (undeclared.length > 0) {
        missing.push(
          `${name} -> "${binding.command}" (missing flags: ${undeclared.join(", ")})`,
        );
      }
    }
    assert.deepEqual(
      missing,
      [],
      `CLI_BINDINGS name commands that do not exist (renamed? never registered?):\n  ${missing.join(
        "\n  "
      )}`
    );
  });

  test("every exclusion carries a substantive reason", () => {
    for (const [name, binding] of Object.entries(CLI_BINDINGS)) {
      if (!("excluded" in binding)) continue;
      assert.ok(
        binding.excluded.length > 20,
        `${name} needs a real reason, not a placeholder`
      );
    }
    // One sentence copy-pasted across every entry is a derived map wearing a
    // literal's clothes — the same failure the other surfaces' maps had.
    const reasons = Object.values(CLI_BINDINGS)
      .filter(
        (binding): binding is { excluded: string } => "excluded" in binding
      )
      .map((binding) => binding.excluded);
    assert.ok(
      new Set(reasons).size > reasons.length / 3,
      "exclusion reasons are too repetitive to be a real review"
    );
  });
});

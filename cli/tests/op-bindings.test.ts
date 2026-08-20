import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { ALL_OPERATIONS } from "@mcpjam/sdk/platform";
import { CLI_BINDINGS } from "../src/lib/op-bindings.js";
import { registerChatCommands } from "../src/commands/chat.js";
import { registerClaudeReadinessCommands } from "../src/commands/claude-readiness.js";
import { registerEnvironmentsCommands } from "../src/commands/environments.js";
import { registerEvalCommands } from "../src/commands/eval.js";
import { registerHostsCommands } from "../src/commands/hosts.js";
import { registerJourneysCommands } from "../src/commands/journeys.js";
import { registerScenariosCommands } from "../src/commands/scenarios.js";
import { registerSessionsCommands } from "../src/commands/sessions.js";
import { registerImagesCommands } from "../src/commands/images.js";
import { registerOrganizationsCommands } from "../src/commands/organizations.js";
import { registerProjectsCommands } from "../src/commands/projects.js";
import { registerTunnelCommands } from "../src/commands/tunnel.js";
import { registerSwarmAuthoringCommands } from "../src/commands/swarms.js";
import { registerUserTestingCommands } from "../src/commands/user-testing.js";

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
  registerOrganizationsCommands(program);
  registerProjectsCommands(program);
  registerEvalCommands(program);
  registerChatCommands(program);
  registerSessionsCommands(program);
  registerHostsCommands(program);
  registerEnvironmentsCommands(program);
  const journeys = registerJourneysCommands(program);
  registerScenariosCommands(program);
  // Swarms authoring hangs its journey subcommands off the SAME group, so the
  // group has to be threaded through here exactly as `src/index.ts` does it —
  // building a second `journeys` command would resolve paths that the real CLI
  // does not have.
  registerSwarmAuthoringCommands(program, journeys);
  registerUserTestingCommands(program);
  registerClaudeReadinessCommands(program);
  registerImagesCommands(program);
  registerTunnelCommands(program);
  return program;
}

/** Walk a command path like "eval cases run" through the Commander tree. */
function resolveCommandPath(program: Command, path: string): boolean {
  let node: Command = program;
  for (const segment of path.split(" ")) {
    const next: Command | undefined = node.commands.find(
      (candidate) =>
        candidate.name() === segment || candidate.aliases().includes(segment)
    );
    if (!next) return false;
    node = next;
  }
  return true;
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

  test("every advertised command actually resolves in the CLI", () => {
    // The point of the whole file. A map entry is a claim; this is the proof.
    const program = buildPlatformProgram();
    const missing: string[] = [];
    for (const [name, binding] of Object.entries(CLI_BINDINGS)) {
      if (!("command" in binding)) continue;
      if (!resolveCommandPath(program, binding.command)) {
        missing.push(`${name} -> "${binding.command}"`);
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

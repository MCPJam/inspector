import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { registerServerSkillsCommands } from "../src/commands/server-skills.js";
import { applySkillsExtensionCapability } from "../src/lib/ephemeral.js";

/**
 * `mcpjam skills` — the command surface and its one refusal-by-construction.
 *
 * The end-to-end behaviour (list/get/read against a live server, refusals
 * rendered by kind) is exercised by driving the CLI against `mcpjam mcp`, which
 * serves its own skills. What is unit-testable, and what would silently rot, is
 * the capability seam: skills is mutually declared, so a command that forgets
 * to advertise it gets a correct-but-useless refusal from every server.
 */

function buildProgram(): Command {
  const program = new Command().name("mcpjam").exitOverride();
  registerServerSkillsCommands(program);
  return program;
}

function find(program: Command, name: string): Command | undefined {
  return program.commands
    .find((c) => c.name() === "skills")
    ?.commands.find((c) => c.name() === name);
}

describe("mcpjam skills command surface", () => {
  test("registers list, get and read under one group", () => {
    const program = buildProgram();
    for (const name of ["list", "get", "read"]) {
      assert.ok(find(program, name), `missing subcommand: ${name}`);
    }
  });

  test("distinguishes itself from `cloud skills` in its description", () => {
    // Two commands, the same word, opposite directions: this one inspects
    // somebody else's server, `cloud skills` reads your own project. A user who
    // picks the wrong one gets an empty answer and no hint why.
    const skills = buildProgram().commands.find((c) => c.name() === "skills");
    assert.match(skills!.description(), /cloud skills/);
  });

  test("read requires both uris, since one alone cannot authorize a read", () => {
    const read = find(buildProgram(), "read")!;
    const flags = read.options.map((o) => o.long);
    assert.ok(flags.includes("--skill-uri"));
    assert.ok(flags.includes("--resource-uri"));
  });
});

describe("declaring the skills extension", () => {
  test("merges the extension into an unpinned capability bag", () => {
    const config = applySkillsExtensionCapability({
      command: "node",
      args: [],
    } as never) as { capabilities?: Record<string, unknown> };
    const extensions = config.capabilities?.extensions as Record<
      string,
      unknown
    >;
    assert.ok(extensions["io.modelcontextprotocol/skills"]);
  });

  test("keeps capabilities the caller already set", () => {
    const config = applySkillsExtensionCapability({
      command: "node",
      args: [],
      capabilities: { sampling: {} },
    } as never) as { capabilities?: Record<string, unknown> };
    assert.ok(config.capabilities?.sampling);
    assert.ok(
      (config.capabilities?.extensions as Record<string, unknown>)[
        "io.modelcontextprotocol/skills"
      ],
    );
  });

  test("refuses an exact pinned set that omits skills, rather than adding it", () => {
    // The whole point of --host / --client-capabilities is advertising exactly
    // what that host advertises. Injecting skills into a Cursor persona would
    // answer "what can MCPJam see" while the user asked "what would Cursor
    // see" — so the refusal IS the honest answer.
    assert.throws(
      () =>
        applySkillsExtensionCapability({
          command: "node",
          args: [],
          clientCapabilities: { roots: {} },
        } as never),
      (error: Error) => {
        assert.match(error.message, /io\.modelcontextprotocol\/skills/);
        assert.match(error.message, /would not see/);
        return true;
      },
    );
  });

  test("honors an exact pinned set that already declares skills", () => {
    const pinned = {
      command: "node",
      args: [],
      clientCapabilities: {
        extensions: { "io.modelcontextprotocol/skills": {} },
      },
    };
    assert.deepEqual(
      applySkillsExtensionCapability(pinned as never),
      pinned as never,
    );
  });
});

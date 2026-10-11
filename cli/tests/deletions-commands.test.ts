import { test } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { registerDeletionCommands } from "../src/commands/deletions.js";

test("deletion commands expose exact-ID retry and isolated receipt controls", () => {
  const program = new Command();
  registerDeletionCommands(program);
  const group = program.commands.find(
    (command) => command.name() === "deletions",
  );
  assert.ok(group);
  assert.deepEqual(
    group.commands.map((command) => command.name()),
    ["request", "status", "cancel"],
  );
  const request = group.commands[0];
  assert.deepEqual(
    request.options
      .filter((option) => option.mandatory)
      .map((option) => option.long),
    ["--scope", "--id", "--idempotency-key"],
  );
  assert.equal(group.commands[1].options[0].long, "--request");
  assert.equal(group.commands[2].options[0].long, "--request");
});

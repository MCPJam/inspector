import assert from "node:assert/strict";
import { Command } from "commander";
import test from "node:test";
import { addRequiredOptionWithHiddenAlias } from "../src/lib/commander-options.js";

test("hidden alias sets the canonical option and stays out of help", () => {
  const command = new Command("tunnel").exitOverride();
  addRequiredOptionWithHiddenAlias(
    command,
    "--server <name>",
    "--id",
    "Server name"
  );

  command.parse(["--id", "alpha"], { from: "user" });
  assert.equal(command.opts().server, "alpha");

  const help = command.helpInformation();
  assert.match(help, /--server <name>/);
  assert.doesNotMatch(help, /--id/);
});

test("canonical flag is mandatory when neither spelling is given", () => {
  const command = new Command("tunnel").exitOverride();
  addRequiredOptionWithHiddenAlias(
    command,
    "--server <name>",
    "--id",
    "Server name"
  );

  assert.throws(
    () => command.parse([], { from: "user" }),
    (error: unknown) => {
      assert.match(String(error), /required option '--server <name>'/);
      return true;
    }
  );
});

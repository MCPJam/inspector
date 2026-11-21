/**
 * The `cli-change` skill's command map is generated from `--help`; this fails
 * when a command was added, removed, renamed or re-described without
 * regenerating it with `npm run map:commands -w @mcpjam/cli`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { COMMAND_MAP_PATH, renderCommandMap } from "../scripts/command-map.mjs";

test("the cli-change skill's command map matches the CLI's --help", async () => {
  assert.equal(
    readFileSync(COMMAND_MAP_PATH, "utf8"),
    await renderCommandMap(),
    "The command map is stale. Run `npm run map:commands -w @mcpjam/cli` and commit .agents/skills/cli-change/commands.md.",
  );
});

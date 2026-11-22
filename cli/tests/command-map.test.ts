/**
 * The `cli-change` skill's command map is generated from `--help`; this fails
 * when a command was added, removed, renamed or re-described without
 * regenerating it with `npm run map:commands -w @mcpjam/cli`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command } from "commander";
import { COMMAND_MAP_PATH, renderCommandMap } from "../scripts/command-map.mjs";

const cliEntry = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist/index.js",
);

test("the cli-change skill's command map matches the CLI's --help", async () => {
  assert.equal(
    readFileSync(COMMAND_MAP_PATH, "utf8"),
    await renderCommandMap(),
    "The command map is stale. Run `npm run map:commands -w @mcpjam/cli` and commit .agents/skills/cli-change/commands.md.",
  );
});

/** Every visible command path commander holds, read off the built program. */
async function registeredCommandPaths(): Promise<string[]> {
  const { main } = await import(pathToFileURL(cliEntry).href);
  let program: Command | undefined;
  const parseAsync = Command.prototype.parseAsync;
  Command.prototype.parseAsync = function (
    this: Command,
    ...args: Parameters<Command["parseAsync"]>
  ) {
    program ??= this;
    return parseAsync.apply(this, args);
  };
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try {
    await main(["node", "mcpjam", "--help"], {
      telemetry: { env: { ...process.env, MCPJAM_TELEMETRY_DISABLED: "1" } },
    });
  } finally {
    Command.prototype.parseAsync = parseAsync;
    process.stdout.write = write;
  }
  assert.ok(program, "the built CLI did not parse with this commander module");

  const paths: string[] = [];
  const walk = (command: Command, parent: string[]) => {
    for (const child of command.createHelp().visibleCommands(command)) {
      if (child.name() === "help") continue;
      const childPath = [...parent, child.name()];
      paths.push(childPath.join(" "));
      walk(child, childPath);
    }
  };
  walk(program, []);
  return paths.sort();
}

// The generator parses rendered help text, so a help row it cannot read drops
// out of the map and of the regenerated map alike. Count the map against the
// commands commander holds.
test("the command map lists every visible command the CLI registers", async () => {
  const mapped = [
    ...(await renderCommandMap()).matchAll(/^ *- `mcpjam ([^`]*)`/gm),
  ]
    .map(([, signature]) =>
      signature
        .split(" ")
        .filter((token) => /^[\w-]+$/.test(token))
        .join(" "),
    )
    .sort();
  assert.deepEqual(mapped, await registeredCommandPaths());
});

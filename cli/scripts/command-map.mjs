#!/usr/bin/env node
/**
 * Write the command map of the `cli-change` skill from the CLI's own `--help`.
 *
 * It walks every command by running `mcpjam <path> --help` in-process against
 * the built CLI (`cli/dist`), so run `npm run build -w @mcpjam/cli` first;
 * `npm run map:commands -w @mcpjam/cli` does both. `tests/command-map.test.ts`
 * fails when the committed map differs from what this renders.
 *
 * Commander wraps descriptions to the terminal width, so continuation lines
 * are joined back into one line: the map is the same in a TTY, a pipe and CI.
 * Hidden commands are not in `--help` and are not in the map.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const cliRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const COMMAND_MAP_PATH = path.resolve(
  cliRoot,
  "../.agents/skills/cli-change/commands.md",
);

async function helpText(main, commandPath) {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let stdout = "";
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk === "string") {
      stdout += chunk;
      return true;
    }
    return originalWrite(chunk, ...rest);
  };
  let result;
  try {
    result = await main(["node", "mcpjam", ...commandPath, "--help"], {
      telemetry: { env: { ...process.env, MCPJAM_TELEMETRY_DISABLED: "1" } },
    });
  } finally {
    process.stdout.write = originalWrite;
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `mcpjam ${commandPath.join(" ")} --help exited ${result.exitCode}`,
    );
  }
  return stdout;
}

/**
 * One help page: its long option flags, and its command rows grouped under
 * the heading they sit in.
 */
function parseHelp(help) {
  const options = new Set();
  const commands = [];
  let section;
  for (const line of help.split(/\r?\n/)) {
    if (/^\S.*:$/.test(line)) {
      section = line.slice(0, -1);
      continue;
    }
    if (section === "Options") {
      const flag = line.match(/^ {2}(?:-\w, )?(--[\w-]+)/);
      if (flag) options.add(flag[1]);
      continue;
    }
    if (!section || section === "Arguments") continue;
    const row = line.match(/^ {2}(\S.*?)(?:\s{2,}(.*))?$/);
    if (row) {
      const [name, ...rest] = row[1].split(" ");
      const [primary, ...aliases] = name.split("|");
      if (primary === "help") continue;
      commands.push({
        group: section,
        name: primary,
        aliases,
        args: rest.filter((token) => token !== "[options]").join(" "),
        description: row[2] ?? "",
      });
      continue;
    }
    const continuation = line.match(/^ {3,}(\S.*)$/);
    const previous = commands.at(-1);
    if (continuation && previous) {
      previous.description =
        `${previous.description} ${continuation[1]}`.trim();
    }
  }
  return { options, commands };
}

/**
 * A command contacts MCPJam when it or a parent accepts `--api-url`, or when
 * it is asked to `--upload` (`cli/src/lib/deployment-preflight.ts`). The mark
 * goes on the highest command it applies to.
 */
async function collectTree(main, commandPath, underApiUrl) {
  const { options, commands } = parseHelp(await helpText(main, commandPath));
  const apiUrl = options.has("--api-url") && !underApiUrl;
  for (const child of commands) {
    Object.assign(
      child,
      await collectTree(
        main,
        [...commandPath, child.name],
        underApiUrl || options.has("--api-url"),
      ),
    );
  }
  return {
    mark: apiUrl
      ? "contacts MCPJam"
      : options.has("--upload")
        ? "contacts MCPJam with --upload"
        : undefined,
    children: commands,
  };
}

function renderEntry(entry, parentPath, depth) {
  const fullPath = [...parentPath, entry.name];
  const signature = ["mcpjam", ...fullPath, entry.args]
    .filter(Boolean)
    .join(" ");
  const alias =
    entry.aliases.length > 0 ? ` (alias: ${entry.aliases.join(", ")})` : "";
  const mark = entry.mark ? ` [${entry.mark}]` : "";
  const description = entry.description ? `: ${entry.description}` : "";
  const lines = [
    `${"  ".repeat(depth)}- \`${signature}\`${alias}${mark}${description}`,
  ];
  for (const child of entry.children) {
    lines.push(...renderEntry(child, fullPath, depth + 1));
  }
  return lines;
}

export async function renderCommandMap() {
  const { main } = await import(
    pathToFileURL(path.join(cliRoot, "dist/index.js")).href
  );
  const { children: topLevel } = await collectTree(main, [], false);
  const out = [
    "# mcpjam command map",
    "",
    "Generated from `mcpjam --help` by `npm run map:commands -w @mcpjam/cli`. Do not edit it by hand: `cli/tests/command-map.test.ts` fails when it is stale.",
    "",
    "`[contacts MCPJam]` marks a command that accepts `--api-url`; every command under it contacts MCPJam too. `[contacts MCPJam with --upload]` marks a command that uploads only when asked. `--help` cannot show the commands that declare MCPJam use in code (`declareMcpjamUse` in `cli/src/commands/`), so an unmarked command can still contact MCPJam.",
  ];
  let group;
  for (const entry of topLevel) {
    if (entry.group !== group) {
      group = entry.group;
      out.push("", `## ${group}`, "");
    }
    out.push(...renderEntry(entry, [], 0));
  }
  return `${out.join("\n")}\n`;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  writeFileSync(COMMAND_MAP_PATH, await renderCommandMap());
  process.stdout.write(
    `Wrote ${path.relative(process.cwd(), COMMAND_MAP_PATH)}\n`,
  );
}

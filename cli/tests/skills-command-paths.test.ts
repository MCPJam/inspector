/**
 * Every `mcpjam …` command path the skills and the README name must exist.
 *
 * The check walks the real Commander tree instead of shelling out to
 * `--help`, because `mcpjam <group> <unknown> --help` prints the parent's help
 * and exits 0: a help-based check would pass on a command that was removed.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { registerCliCommands } from "../src/index.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const GLOBAL_FLAGS = new Set(["--quiet", "--rpc", "--no-telemetry"]);
const GLOBAL_FLAGS_WITH_VALUE = new Set(["--format", "--timeout"]);
const COMMAND_WORD = /^[a-z][a-z0-9-]*$/;

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.name.endsWith(".md") ? [full] : [];
  });
}

/** Command lines from fenced blocks and inline code spans that start with `mcpjam `. */
function mentionedCommands(markdown: string): string[] {
  const candidates: string[] = [];
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      candidates.push(line.trim().replace(/^\$\s+/, ""));
      continue;
    }
    for (const span of line.matchAll(/`([^`]+)`/g)) {
      candidates.push(span[1]);
    }
  }
  return candidates
    .flatMap((text) => text.split(/\s+(?:&&|\|\||\||;)\s+/))
    .map((text) => text.trim())
    .filter((text) => text.startsWith("mcpjam "));
}

/**
 * Walks `words` down the command tree and reports the first word that names no
 * subcommand. Words after a command that takes positional arguments, or that
 * has no subcommands, are arguments and end the path.
 */
function resolvePath(
  program: Command,
  words: string[],
): { ok: true } | { ok: false; at: string; parent: string } {
  let current = program;
  const walked = ["mcpjam"];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (GLOBAL_FLAGS.has(word)) continue;
    if (GLOBAL_FLAGS_WITH_VALUE.has(word)) {
      index += 1;
      continue;
    }
    if (!COMMAND_WORD.test(word)) return { ok: true };
    const next = current.commands.find(
      (command) => command.name() === word || command.aliases().includes(word),
    );
    if (next) {
      current = next;
      walked.push(word);
      continue;
    }
    if (
      current.commands.length === 0 ||
      current.registeredArguments.length > 0
    ) {
      return { ok: true };
    }
    return { ok: false, at: word, parent: walked.join(" ") };
  }
  return { ok: true };
}

test("every mcpjam command named in the skills and the CLI README exists", () => {
  const program = new Command("mcpjam");
  registerCliCommands(program);

  const sources = [
    ...markdownFiles(path.join(repoRoot, "skills")),
    ...markdownFiles(path.join(repoRoot, "sdk/skills")),
    path.join(repoRoot, "cli/README.md"),
  ];

  const missing: string[] = [];
  let checked = 0;
  for (const file of sources) {
    for (const command of mentionedCommands(readFileSync(file, "utf8"))) {
      checked += 1;
      const result = resolvePath(program, command.split(/\s+/).slice(1));
      if (!result.ok) {
        missing.push(
          `${path.relative(repoRoot, file)}: \`${command}\` (no \`${result.at}\` under \`${result.parent}\`)`,
        );
      }
    }
  }

  assert.ok(checked > 50, `expected many command mentions, found ${checked}`);
  assert.deepEqual(missing, []);
});

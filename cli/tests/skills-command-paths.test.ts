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
import { Command, type Option } from "commander";
import { registerCliCommands } from "../src/index.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const GLOBAL_FLAGS = new Set(["--quiet", "--rpc", "--no-telemetry"]);
const GLOBAL_FLAGS_WITH_VALUE = new Set(["--format", "--timeout"]);
const COMMAND_WORD = /^[a-z][a-z0-9-]*$/;
const ALTERNATIVES = /^[a-z][a-z0-9-]*(?:\|[a-z][a-z0-9-]*)+$/;

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.name.endsWith(".md") ? [full] : [];
  });
}

/**
 * A file that says this sentence lists bare commands in its tables (`server
 * diff --baseline <file>`); those spans are checked with the prefix added.
 */
const BARE_TABLE_MARKER = "Prefix each with `mcpjam`";

/** Command lines from fenced blocks and inline code spans that start with `mcpjam `. */
function mentionedCommands(markdown: string): string[] {
  const bareTables = markdown.includes(BARE_TABLE_MARKER);
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
    const tableRow = bareTables && line.trimStart().startsWith("|");
    for (const span of line.matchAll(/`([^`]+)`/g)) {
      const text = span[1];
      const bare = tableRow && COMMAND_WORD.test(text.split(/\s+/)[0]);
      candidates.push(
        bare && !text.startsWith("mcpjam ") ? `mcpjam ${text}` : text,
      );
    }
  }
  return candidates
    .flatMap((text) => text.split(/\s+(?:&&|\|\||\||;)\s+/))
    .map((text) => text.trim())
    .filter((text) => text.startsWith("mcpjam "));
}

/** Splits on whitespace, keeping a quoted value such as `--header "X: a b"` whole. */
function tokenize(command: string): string[] {
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
}

/** `readiness start|status|list` names three commands; expand each one. */
function expandAlternatives(words: string[]): string[][] {
  const index = words.findIndex((word) => ALTERNATIVES.test(word));
  if (index === -1) return [words];
  return words[index]
    .split("|")
    .flatMap((choice) =>
      expandAlternatives([
        ...words.slice(0, index),
        choice,
        ...words.slice(index + 1),
      ]),
    );
}

/** The option `flag` names on `command` or any command above it. */
function findOption(command: Command, flag: string): Option | undefined {
  for (let at: Command | null = command; at; at = at.parent) {
    const option = at.options.find(
      (candidate) => candidate.long === flag || candidate.short === flag,
    );
    if (option) return option;
  }
  return undefined;
}

/**
 * Walks `words` down the command tree and reports the first word that names no
 * subcommand. Recognized options and their values are skipped. A word the
 * command cannot take as a positional argument fails; a placeholder or other
 * non-command word ends the path.
 */
function resolvePath(
  program: Command,
  words: string[],
): { ok: true } | { ok: false; at: string; parent: string } {
  let current = program;
  const walked = ["mcpjam"];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word.startsWith("-")) {
      const [flag, inlineValue] = word.split("=", 2);
      if (GLOBAL_FLAGS.has(flag)) continue;
      if (GLOBAL_FLAGS_WITH_VALUE.has(flag)) {
        if (inlineValue === undefined) index += 1;
        continue;
      }
      const option = findOption(current, flag);
      if (!option) return { ok: true };
      if (option.variadic) {
        while (index + 1 < words.length && !words[index + 1].startsWith("-")) {
          index += 1;
        }
        continue;
      }
      const takesValue = option.required || option.optional;
      if (takesValue && inlineValue === undefined) index += 1;
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
    if (current.registeredArguments.length > 0) return { ok: true };
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
      for (const words of expandAlternatives(tokenize(command).slice(1))) {
        checked += 1;
        const result = resolvePath(program, words);
        if (!result.ok) {
          missing.push(
            `${path.relative(repoRoot, file)}: \`${command}\` (no \`${
              result.at
            }\` under \`${result.parent}\`)`,
          );
        }
      }
    }
  }

  assert.ok(checked > 50, `expected many command mentions, found ${checked}`);
  assert.deepEqual(missing, []);
});

test("quoted option values and variadic options do not read as subcommands", () => {
  const program = new Command("mcpjam");
  registerCliCommands(program);

  for (const command of [
    'mcpjam tools list --url https://example.com/mcp --header "X-Note: hello world"',
    "mcpjam tools list --command npm --args run start",
  ]) {
    assert.deepEqual(resolvePath(program, tokenize(command).slice(1)), {
      ok: true,
    });
  }
  assert.equal(
    resolvePath(program, tokenize("mcpjam tools list --url u removed").slice(1))
      .ok,
    false,
  );
});

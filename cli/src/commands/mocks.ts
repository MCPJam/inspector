/**
 * `mcpjam cloud mocks`: create, update and read a mock server.
 *
 * A mock sits in front of a saved server with a definition that states only
 * what it changes. The definition (or merge patch) is JSON given inline or in
 * a file, `-` for stdin. The API checks it and refuses a change that leaves a
 * real tool uncallable.
 *
 *   mcpjam cloud mocks create --name "docs (mock)" --server docs \
 *     --definition-file definition.json
 *   mcpjam cloud mocks get --mock "docs (mock)"
 *   mcpjam cloud mocks update --mock "docs (mock)" --expected-version 1 \
 *     --patch '{"tools":{"search":{"description":"Search the docs."}}}' --dry-run
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { createMockServerOperation, getMockServerOperation, updateMockServerOperation } from "@mcpjam/sdk/platform";
import { usageError } from "../lib/output.js";
import {
  addProjectOption,
  bindOperation,
  parseIntegerOption,
  parseRequiredIntegerOption,
  requireExactlyOne,
  type PlatformOptions,
} from "../lib/platform-command.js";

type MockOptions = PlatformOptions & { project?: string; mock: string };
type JsonOptions = {
  definition?: string;
  definitionFile?: string;
  patch?: string;
  patchFile?: string;
};

/** A JSON object from inline text or a file (`-` is stdin), or a usage error naming the flag. */
function readObject(flag: string, inline?: string, file?: string): Record<string, unknown> {
  if (inline !== undefined && file !== undefined) {
    throw usageError(`Pass only one of ${flag} and ${flag}-file.`);
  }
  let text = inline;
  if (text === undefined && file !== undefined) {
    try {
      text = readFileSync(file === "-" ? 0 : file, "utf8");
    } catch (error) {
      throw usageError(`Could not read ${file} for ${flag}-file. Check the path and that you can read the file.`, {
        source: error instanceof Error ? error.message : String(error),
      });
    }
  }
  let value: unknown;
  try {
    value = JSON.parse(text ?? "");
  } catch {
    throw usageError(`${flag} is not JSON. Pass a JSON object.`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw usageError(`${flag} must be a JSON object.`);
  }
  return Object.fromEntries(Object.entries(value));
}

const given = (inline?: string, file?: string) => inline !== undefined || file !== undefined;

export function registerMocksCommands(cloud: Command): void {
  const mocks = cloud
    .command("mocks")
    .description("Create, update and read mock servers: a saved server with a definition laid over it.");

  bindOperation(
    addProjectOption(
      mocks
        .command("create")
        .description(
          "Create a mock of a saved server, or of nothing. Prints its address, version 1 and what the definition changes",
        )
        .requiredOption("--name <name>", "The mock's name, unique among the workspace's servers")
        .option("--server <id-or-name>", "The saved server to sit in front of (omit for a mock from nothing)")
        .option("--definition <json>", "The definition, as JSON")
        .option("--definition-file <path>", "The definition, read from a file (- for stdin)"),
    ),
    createMockServerOperation,
    (options: PlatformOptions & JsonOptions & { project?: string; name: string; server?: string }) => {
      requireExactlyOne({ "--definition": options.definition, "--definition-file": options.definitionFile });
      return {
        project: options.project,
        server: options.server,
        name: options.name,
        definition: readObject("--definition", options.definition, options.definitionFile),
      };
    },
  );

  bindOperation(
    addProjectOption(
      mocks
        .command("update")
        .description(
          "Save a new version of a mock from a whole definition or a JSON merge patch. Refused if another version landed since the one you read",
        )
        .requiredOption("--mock <id-or-name>", "Mock server ID or name")
        .requiredOption("--expected-version <n>", "The head version you read (see `mocks get`)")
        .option("--definition <json>", "The whole next definition, as JSON")
        .option("--definition-file <path>", "The whole next definition, from a file (- for stdin)")
        .option("--patch <json>", "A JSON merge patch over the head, as JSON")
        .option("--patch-file <path>", "A JSON merge patch over the head, from a file (- for stdin)")
        .option("--dry-run", "Print the change list without saving"),
    ),
    updateMockServerOperation,
    (options: MockOptions & JsonOptions & { expectedVersion: string; dryRun?: boolean }) => {
      requireExactlyOne({
        "--definition or --definition-file": options.definition ?? options.definitionFile,
        "--patch or --patch-file": options.patch ?? options.patchFile,
      });
      return {
        project: options.project,
        mock: options.mock,
        definition: given(options.definition, options.definitionFile)
          ? readObject("--definition", options.definition, options.definitionFile)
          : undefined,
        patch: given(options.patch, options.patchFile)
          ? readObject("--patch", options.patch, options.patchFile)
          : undefined,
        expectedVersion: parseRequiredIntegerOption(options.expectedVersion, "--expected-version", { min: 1 }),
        dryRun: options.dryRun,
      };
    },
  );

  bindOperation(
    addProjectOption(
      mocks
        .command("get")
        .description(
          "Read a mock: its address, definition and the real server's current values for what the definition edits",
        )
        .requiredOption("--mock <id-or-name>", "Mock server ID or name")
        .option("--version <n>", "The version to read (default: the head)")
        .option("--since <n>", "Also list what changed from this version"),
    ),
    getMockServerOperation,
    (options: MockOptions & { version?: string; since?: string }) => ({
      project: options.project,
      mock: options.mock,
      version: parseIntegerOption(options.version, "--version", { min: 1 }),
      sinceVersion: parseIntegerOption(options.since, "--since", { min: 1 }),
    }),
  );
}

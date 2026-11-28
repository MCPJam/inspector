/**
 * `mcpjam cloud mocks`: create, read, patch and refresh a mock server, and
 * read or set the forwarding policy. Every command runs the operation of the
 * same name, so the CLI, the SDK, REST and MCP return the same results.
 *
 * A mock sits in front of a saved server with a definition that states only
 * what it changes. `get` reads it in bounded pages and `patch` changes one
 * path, so a mock with hundreds of tools is read and edited without ever
 * holding the whole definition:
 *
 *   mcpjam cloud mocks get --mock "docs (mock)"
 *   mcpjam cloud mocks get --mock "docs (mock)" --family tools --search search
 *   mcpjam cloud mocks get --mock "docs (mock)" --family tools --name search --path description
 *   mcpjam cloud mocks patch --mock "docs (mock)" --expected-version 1 \
 *     --family tools --name search --path description --value-text "Search the docs."
 *   mcpjam cloud mocks refresh --mock "docs (mock)" --expected-version 2 --apply
 *
 * A test run gives a client its own copy of a version's records at a URL of
 * its own:
 *
 *   mcpjam cloud mocks run open --mock "docs (mock)"
 *   mcpjam cloud mocks run reset --mock "docs (mock)" --run-id <id> --expected-epoch 1
 *   mcpjam cloud mocks run close --mock "docs (mock)" --run-id <id>
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
  closeMockRunOperation,
  createMockServerOperation,
  getMockForwardingPolicyOperation,
  getMockServerOperation,
  openMockRunOperation,
  patchMockServerOperation,
  refreshMockServerOperation,
  resetMockRunOperation,
  setMockForwardingPolicyOperation,
  updateMockServerOperation,
} from "@mcpjam/sdk/platform";
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
const FAMILIES = ["tools", "prompts", "resources", "resourceTemplates"] as const;
type Family = (typeof FAMILIES)[number];

/** Inline text, or a file (`-` is stdin), or a usage error naming the flag. */
function readText(flag: string, inline?: string, file?: string): string {
  if (inline !== undefined && file !== undefined) {
    throw usageError(`Pass only one of ${flag} and ${flag}-file.`);
  }
  if (inline !== undefined) return inline;
  try {
    return readFileSync(file === "-" ? 0 : (file as string), "utf8");
  } catch (error) {
    throw usageError(`Could not read ${file} for ${flag}-file. Check the path and that you can read the file.`, {
      source: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseJson(flag: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw usageError(`${flag} is not JSON. Pass JSON, or use --value-text for a plain string.`);
  }
}

/** A JSON object from inline text or a file, or a usage error naming the flag. */
function readObject(flag: string, inline?: string, file?: string): Record<string, unknown> {
  const value = parseJson(flag, readText(flag, inline, file));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw usageError(`${flag} must be a JSON object.`);
  }
  return Object.fromEntries(Object.entries(value));
}

const given = (inline?: string, file?: string) => inline !== undefined || file !== undefined;

function familyOf(value: string | undefined): Family | undefined {
  if (value === undefined) return undefined;
  const family = FAMILIES.find((candidate) => candidate === value);
  if (!family) throw usageError(`--family must be one of ${FAMILIES.join(", ")}.`);
  return family;
}

/** Dotted keys, or a JSON list of keys when a key has a dot in it. */
function pathOf(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (!value.startsWith("[")) return value.split(".");
  const parsed = parseJson("--path", value);
  if (!Array.isArray(parsed) || !parsed.every((key) => typeof key === "string" && key !== "")) {
    throw usageError('--path starting with "[" must be a JSON list of keys, like ["inputSchema","properties"].');
  }
  return parsed;
}

export function registerMocksCommands(cloud: Command): void {
  const mocks = cloud
    .command("mocks")
    .description("Create, read, patch and refresh mock servers: a saved server with a definition laid over it.");

  bindOperation(
    addProjectOption(
      mocks
        .command("create")
        .description("Create a mock of a saved server, or of nothing. Prints its address and version 1")
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
        .option("--patch-file <path>", "A JSON merge patch over the head, from a file (- for stdin)"),
    ),
    updateMockServerOperation,
    (options: MockOptions & JsonOptions & { expectedVersion: string }) => {
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
      };
    },
  );

  bindOperation(
    addProjectOption(
      mocks
        .command("get")
        .description(
          "Read a mock in bounded pages: with no selector its summary and a page of changes; --family lists names (--search narrows); --name reads one entry; --path reads one field, a long string in chunks. Continue with --cursor",
        )
        .requiredOption("--mock <id-or-name>", "Mock server ID or name")
        .option("--version <n>", "The version to read (default: the head)")
        .option("--family <family>", `The kind of entry: ${FAMILIES.join(", ")}`)
        .option("--name <name>", "Read exactly this entry (with --family)")
        .option("--path <path>", 'A path inside the entry, dotted ("inputSchema.properties") or a JSON list of keys')
        .option("--search <text>", "List only names containing this text (with --family)")
        .option("--limit <n>", "Most names per page")
        .option("--cursor <cursor>", "`page.nextCursor` from the previous page of the same read"),
    ),
    getMockServerOperation,
    (
      options: MockOptions & {
        version?: string;
        family?: string;
        name?: string;
        path?: string;
        search?: string;
        limit?: string;
        cursor?: string;
      },
    ) => ({
      project: options.project,
      mock: options.mock,
      version: parseIntegerOption(options.version, "--version", { min: 1 }),
      family: familyOf(options.family),
      name: options.name,
      path: pathOf(options.path),
      search: options.search,
      limit: parseIntegerOption(options.limit, "--limit", { min: 1 }),
      cursor: options.cursor,
    }),
  );

  bindOperation(
    addProjectOption(
      mocks
        .command("patch")
        .description(
          "Set or remove exactly one path of a mock against the head version you read, without sending the entry",
        )
        .requiredOption("--mock <id-or-name>", "Mock server ID or name")
        .requiredOption("--expected-version <n>", "The head version you read (see `mocks get`)")
        .option("--family <family>", `With --name, the entry's kind: ${FAMILIES.join(", ")}. Leave both out for a server-wide setting`)
        .option("--name <name>", "The entry to change, exactly as a client sees it")
        .option("--path <path>", 'The path inside the entry, dotted ("description") or a JSON list of keys')
        .option("--value <json>", "The new value, as JSON")
        .option("--value-text <text>", "The new value as a plain string")
        .option("--value-file <path>", "The new value as JSON, read from a file (- for stdin)")
        .option("--remove", "Remove the path so the real server's own value shows again"),
    ),
    patchMockServerOperation,
    (
      options: MockOptions & {
        expectedVersion: string;
        family?: string;
        name?: string;
        path?: string;
        value?: string;
        valueText?: string;
        valueFile?: string;
        remove?: boolean;
      },
    ) => {
      requireExactlyOne({
        "--value": options.value,
        "--value-text": options.valueText,
        "--value-file": options.valueFile,
        "--remove": options.remove ? true : undefined,
      });
      const value =
        options.valueText !== undefined
          ? options.valueText
          : given(options.value, options.valueFile)
            ? parseJson("--value", readText("--value", options.value, options.valueFile))
            : undefined;
      return {
        project: options.project,
        mock: options.mock,
        expectedVersion: parseRequiredIntegerOption(options.expectedVersion, "--expected-version", { min: 1 }),
        family: familyOf(options.family),
        name: options.name,
        path: pathOf(options.path),
        ...(options.remove ? { remove: true } : { value }),
      };
    },
  );

  bindOperation(
    addProjectOption(
      mocks
        .command("refresh")
        .description(
          "Read the real server again as you and preview what changed since the mock's saved listing, and which overrides no longer fit. Saves nothing without --apply",
        )
        .requiredOption("--mock <id-or-name>", "Mock server ID or name")
        .requiredOption("--expected-version <n>", "The head version you read (see `mocks get`)")
        .option("--apply", "Save the refreshed listing as the next version"),
    ),
    refreshMockServerOperation,
    (options: MockOptions & { expectedVersion: string; apply?: boolean }) => ({
      project: options.project,
      mock: options.mock,
      expectedVersion: parseRequiredIntegerOption(options.expectedVersion, "--expected-version", { min: 1 }),
      apply: options.apply,
    }),
  );

  const run = mocks
    .command("run")
    .description("Open, reset or close a test run: a version pinned, with its own copy of its records, at a URL of its own.");

  bindOperation(
    addProjectOption(
      run
        .command("open")
        .description("Open a test run of a mock and print its URL, epoch and expiry. A run lasts 24 hours")
        .requiredOption("--mock <id-or-name>", "Mock server ID or name")
        .option("--version <n>", "The version to pin (default: the head)")
        .option("--platform-run-id <id>", "The test or evaluation run this belongs to"),
    ),
    openMockRunOperation,
    (options: MockOptions & { version?: string; platformRunId?: string }) => ({
      project: options.project,
      mock: options.mock,
      version: parseIntegerOption(options.version, "--version", { min: 1 }),
      platformRunId: options.platformRunId,
    }),
  );

  bindOperation(
    addProjectOption(
      run
        .command("reset")
        .description("Restore a run's records to the version's seed. The old URL is refused; the new one is printed")
        .requiredOption("--mock <id-or-name>", "Mock server ID or name")
        .requiredOption("--run-id <id>", "The run's ID")
        .requiredOption("--expected-epoch <n>", "The epoch of the URL you hold"),
    ),
    resetMockRunOperation,
    (options: MockOptions & { runId: string; expectedEpoch: string }) => ({
      project: options.project,
      mock: options.mock,
      runId: options.runId,
      expectedEpoch: parseRequiredIntegerOption(options.expectedEpoch, "--expected-epoch", { min: 1 }),
    }),
  );

  bindOperation(
    addProjectOption(
      run
        .command("close")
        .description("End a run at once: its URL is refused. Safe to repeat")
        .requiredOption("--mock <id-or-name>", "Mock server ID or name")
        .requiredOption("--run-id <id>", "The run's ID"),
    ),
    closeMockRunOperation,
    (options: MockOptions & { runId: string }) => ({
      project: options.project,
      mock: options.mock,
      runId: options.runId,
    }),
  );

  const policy = mocks
    .command("policy")
    .description("Read or set whether mock servers may call their real servers.");

  bindOperation(
    addProjectOption(
      policy
        .command("get")
        .description("Read the forwarding policy in force for a mock, or for the project's workspace without --mock")
        .option("--mock <id-or-name>", "Read the policy in force for this mock"),
    ),
    getMockForwardingPolicyOperation,
    (options: PlatformOptions & { project?: string; mock?: string }) => ({
      project: options.project,
      mock: options.mock,
    }),
  );

  bindOperation(
    addProjectOption(
      policy
        .command("set")
        .description("Allow or block every mock in the project's workspace calling its real server. Workspace admins only")
        .requiredOption("--forwarding <allow|block>", "allow, or block (saved answers still serve)"),
    ),
    setMockForwardingPolicyOperation,
    (options: PlatformOptions & { project?: string; forwarding: string }) => {
      const forwarding: "allow" | "block" | undefined =
        options.forwarding === "allow" ? "allow" : options.forwarding === "block" ? "block" : undefined;
      if (!forwarding) throw usageError("--forwarding must be allow or block.");
      return { project: options.project, forwarding };
    },
  );
}

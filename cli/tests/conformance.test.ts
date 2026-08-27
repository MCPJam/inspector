import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Command } from "commander";
import {
  buildConfig,
  registerProtocolCommands,
} from "../src/commands/conformance.js";
import { CliError } from "../src/lib/output.js";

function buildConformanceCommand(
  onOptions: (options: unknown) => void,
): Command {
  const program = new Command();
  program.exitOverride();
  registerProtocolCommands(program);
  const protocol = program.commands.find((c) => c.name() === "protocol");
  assert.ok(protocol, "protocol command should be registered");
  const conformance = protocol.commands.find(
    (c) => c.name() === "conformance",
  );
  assert.ok(conformance, "conformance command should be registered");
  // Replace the network-running action so we exercise only option
  // registration and threading into buildConfig, not the live suite.
  conformance.action((options) => {
    onOptions(options);
  });
  return program;
}

async function writeCredentialsJson(contents: object): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-conformance-"));
  const filePath = path.join(directory, "credentials.json");
  await writeFile(filePath, `${JSON.stringify(contents)}\n`, "utf8");
  return filePath;
}

test("buildConfig rejects non-http URLs", () => {
  assert.throws(
    () =>
      buildConfig({
        url: "file:///tmp/mcp.sock",
      }),
    (error) =>
      error instanceof CliError &&
      error.message.includes("Invalid URL scheme"),
  );
});

test("buildConfig rejects unknown categories and check ids", () => {
  assert.throws(
    () =>
      buildConfig({
        url: "https://example.com/mcp",
        category: ["core", "bogus"],
      }),
    (error) =>
      error instanceof CliError &&
      error.message.includes("Unknown category"),
  );

  assert.throws(
    () =>
      buildConfig({
        url: "https://example.com/mcp",
        checkId: ["ping", "bogus"],
      }),
    (error) =>
      error instanceof CliError &&
      error.message.includes("Unknown check id"),
  );
});

test("buildConfig preserves validated conformance filters", () => {
  const config = buildConfig({
    url: "https://example.com/mcp",
    category: ["core"],
    checkId: ["ping"],
  });

  assert.deepEqual(config.categories, ["core"]);
  assert.deepEqual(config.checkIds, ["ping"]);
});

test("buildConfig loads access-token auth from a credentials file", async () => {
  const credentialsFile = await writeCredentialsJson({
    version: 1,
    serverUrl: "https://example.com/mcp",
    accessToken: "file-access-token",
    expiresAt: "2999-01-01T00:00:00.000Z",
  });

  const config = buildConfig({
    url: "https://example.com/mcp",
    credentialsFile,
  });

  assert.equal(config.accessToken, "file-access-token");
});

test("buildConfig threads a known protocol version into the config", () => {
  const config = buildConfig({
    url: "https://example.com/mcp",
    protocolVersion: "2026-07-28",
  });

  assert.equal(config.protocolVersion, "2026-07-28");
});

test("buildConfig rejects an unknown protocol version", () => {
  assert.throws(
    () =>
      buildConfig({
        url: "https://example.com/mcp",
        protocolVersion: "bogus-version",
      }),
    (error) =>
      error instanceof CliError &&
      error.message.includes("Unknown protocol version: bogus-version"),
  );
});

test("buildConfig rejects a whitespace-only protocol version", () => {
  assert.throws(
    () =>
      buildConfig({
        url: "https://example.com/mcp",
        protocolVersion: "   ",
      }),
    (error) =>
      error instanceof CliError &&
      error.message.includes("Unknown protocol version"),
  );
});

test("protocol conformance threads --protocol-version into the config", async () => {
  let captured: ReturnType<typeof buildConfig> | undefined;
  const program = buildConformanceCommand((options) => {
    captured = buildConfig(options as Parameters<typeof buildConfig>[0]);
  });

  await program.parseAsync(
    [
      "protocol",
      "conformance",
      "--url",
      "https://example.com/mcp",
      "--protocol-version",
      "2026-07-28",
    ],
    { from: "user" },
  );

  assert.equal(captured?.protocolVersion, "2026-07-28");
});

test("protocol conformance rejects an unknown --protocol-version", async () => {
  const program = buildConformanceCommand((options) => {
    buildConfig(options as Parameters<typeof buildConfig>[0]);
  });

  await assert.rejects(
    program.parseAsync(
      [
        "protocol",
        "conformance",
        "--url",
        "https://example.com/mcp",
        "--protocol-version",
        "bogus-version",
      ],
      { from: "user" },
    ),
    (error) =>
      error instanceof CliError &&
      error.message.includes("Unknown protocol version: bogus-version"),
  );
});

test("buildConfig omits protocolVersion when absent", () => {
  const config = buildConfig({
    url: "https://example.com/mcp",
  });

  assert.equal("protocolVersion" in config, false);
});

test("buildConfig rejects credentials-file auth conflicts", async () => {
  const credentialsFile = await writeCredentialsJson({
    version: 1,
    serverUrl: "https://example.com/mcp",
    accessToken: "file-access-token",
  });

  assert.throws(
    () =>
      buildConfig({
        url: "https://example.com/mcp",
        credentialsFile,
        accessToken: "explicit-token",
      }),
    (error) =>
      error instanceof CliError &&
      error.message.includes("--credentials-file cannot be used together"),
  );
});

test("fixtures: no flags means the SDK sees no fixtures key at all", () => {
  // The load-bearing default. An empty `fixtures: {}` would be harmless today,
  // but "absent" is the shape that says explicitly that nothing on the server
  // under test may be executed.
  const config = buildConfig({ url: "https://example.com/mcp" });
  assert.equal("fixtures" in config, false);
});

test("fixtures: --fixture-tool and --fixture-prompt name no-argument primitives", () => {
  const config = buildConfig({
    url: "https://example.com/mcp",
    fixtureTool: ["echo", "ping"],
    fixturePrompt: ["welcome"],
  });
  assert.deepEqual(config.fixtures?.toolCalls, [
    { toolName: "echo" },
    { toolName: "ping" },
  ]);
  assert.deepEqual(config.fixtures?.promptGets, [{ promptName: "welcome" }]);
});

test("fixtures: --fixtures-file carries arguments the flags cannot", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcpjam-fixtures-"));
  const file = path.join(dir, "fixtures.json");
  await writeFile(
    file,
    JSON.stringify({
      toolCalls: [{ toolName: "weather", arguments: { city: "Lisbon" } }],
      promptGets: [{ promptName: "greet", arguments: { name: "Ada" } }],
    }),
  );

  const config = buildConfig({
    url: "https://example.com/mcp",
    fixturesFile: file,
  });
  assert.deepEqual(config.fixtures?.toolCalls, [
    { toolName: "weather", arguments: { city: "Lisbon" } },
  ]);
  assert.deepEqual(config.fixtures?.promptGets, [
    { promptName: "greet", arguments: { name: "Ada" } },
  ]);
});

test("fixtures: file entries and flag entries merge", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcpjam-fixtures-"));
  const file = path.join(dir, "fixtures.json");
  await writeFile(
    file,
    JSON.stringify({
      toolCalls: [{ toolName: "weather", arguments: {} }],
      promptGets: [{ promptName: "summarize", arguments: { topic: "mcp" } }],
    }),
  );

  const config = buildConfig({
    url: "https://example.com/mcp",
    fixturesFile: file,
    fixtureTool: ["echo"],
    fixturePrompt: ["welcome"],
  });
  // Order is part of the contract, not an accident: file entries first, then
  // flags. The file is the only place arguments can be supplied, so a merge
  // that put flags first would make an arguments-bearing entry look like a
  // duplicate of a bare one.
  assert.deepEqual(
    config.fixtures?.toolCalls?.map((entry) => entry.toolName),
    ["weather", "echo"],
  );
  assert.deepEqual(config.fixtures?.promptGets, [
    { promptName: "summarize", arguments: { topic: "mcp" } },
    { promptName: "welcome" },
  ]);
});

test("fixtures: a malformed file is a usage error, never a silent empty set", async () => {
  // A fixture set that silently vanished would turn the fixture-gated checks
  // into skips, and the operator would read that as "my server does not support
  // this" rather than "my config is wrong".
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcpjam-fixtures-"));

  const notJson = path.join(dir, "bad.json");
  await writeFile(notJson, "{ not json");
  assert.throws(
    () => buildConfig({ url: "https://example.com/mcp", fixturesFile: notJson }),
    (error: unknown) =>
      error instanceof CliError && /not valid JSON/.test(error.message),
  );

  const notObject = path.join(dir, "array.json");
  await writeFile(notObject, "[]");
  assert.throws(
    () =>
      buildConfig({ url: "https://example.com/mcp", fixturesFile: notObject }),
    (error: unknown) =>
      error instanceof CliError && /must contain a JSON object/.test(error.message),
  );

  const wrongShape = path.join(dir, "shape.json");
  await writeFile(wrongShape, JSON.stringify({ toolCalls: "echo" }));
  assert.throws(
    () =>
      buildConfig({ url: "https://example.com/mcp", fixturesFile: wrongShape }),
    (error: unknown) =>
      error instanceof CliError && /must be an array/.test(error.message),
  );

  // The case the whole "never a silent empty set" rule exists for: a
  // misspelled key would otherwise be ignored, leaving no fixtures at all —
  // and the fixture-gated checks would then SKIP, which an operator reads as
  // "my server does not support this" rather than "my config has a typo".
  const typo = path.join(dir, "typo.json");
  await writeFile(typo, JSON.stringify({ toolCall: [{ toolName: "echo" }] }));
  assert.throws(
    () => buildConfig({ url: "https://example.com/mcp", fixturesFile: typo }),
    (error: unknown) =>
      error instanceof CliError &&
      /unknown key "toolCall"/.test(error.message),
  );

  // Entry shapes fail here as a usage error rather than blowing up later
  // inside SDK normalization.
  const badEntry = path.join(dir, "entry.json");
  await writeFile(badEntry, JSON.stringify({ toolCalls: ["echo"] }));
  assert.throws(
    () =>
      buildConfig({ url: "https://example.com/mcp", fixturesFile: badEntry }),
    (error: unknown) =>
      error instanceof CliError && /toolCalls\[0\]/.test(error.message),
  );

  const missingName = path.join(dir, "name.json");
  await writeFile(
    missingName,
    JSON.stringify({ promptGets: [{ promptNam: "welcome" }] }),
  );
  assert.throws(
    () =>
      buildConfig({
        url: "https://example.com/mcp",
        fixturesFile: missingName,
      }),
    (error: unknown) =>
      error instanceof CliError &&
      /promptGets\[0\]\.promptName must be a non-empty string/.test(
        error.message,
      ),
  );

  assert.throws(
    () =>
      buildConfig({
        url: "https://example.com/mcp",
        fixturesFile: path.join(dir, "missing.json"),
      }),
    (error: unknown) =>
      error instanceof CliError && /Could not read fixtures file/.test(error.message),
  );
});

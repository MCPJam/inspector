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

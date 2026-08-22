/**
 * Freeze the local CLI contract.
 *
 * Account-bound commands are moving under `mcpjam cloud`. Local command
 * paths, accepted/rejected flags, stdout, stderr, exit codes, MCP protocol
 * identity, and the tool contract are CI-load-bearing and must not change.
 *
 * This file owns the manifest at `fixtures/local-contract-manifest.json`.
 * Re-generate it with `UPDATE_LOCAL_CONTRACT=1 npx tsx --test
 * tests/local-contract.test.ts` from `cli/` after an intentional local-surface
 * change. Cloud command churn must not require updating this fixture.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { createMcpJamMcpServer } from "../src/lib/mcp-server.js";
import { runCli } from "./support/cli-run.js";
import { parseHelpCommandNames } from "./support/help.js";

const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/local-contract-manifest.json", import.meta.url)
);

export const FROZEN_LOCAL_COMMANDS = [
  "apps",
  "compat",
  "inspector",
  "mcp",
  "oauth",
  "prompts",
  "protocol",
  "readiness",
  "resources",
  "server",
  "subscriptions",
  "tasks",
  "telemetry",
  "tools",
  "xaa",
] as const;

type FrozenLocalCommand = (typeof FROZEN_LOCAL_COMMANDS)[number];

type HelpContract = {
  usage: string;
  subcommands: string[];
};

type LocalContractManifest = {
  frozenTopLevelCommands: FrozenLocalCommand[];
  help: Record<FrozenLocalCommand, HelpContract>;
};

type LinkedTransport = {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: unknown) => void;
  start(): Promise<void>;
  close(): Promise<void>;
  send(message: unknown): Promise<void>;
};

function createLinkedTransportPair(): [LinkedTransport, LinkedTransport] {
  const make = (): LinkedTransport => ({
    async start() {},
    async close() {
      this.onclose?.();
    },
    async send() {},
  });

  const left = make();
  const right = make();
  left.send = async (message) => {
    queueMicrotask(() => right.onmessage?.(message));
  };
  right.send = async (message) => {
    queueMicrotask(() => left.onmessage?.(message));
  };
  return [left, right];
}

function parseUsage(help: string): string {
  const line = help.split("\n").find((entry) => entry.startsWith("Usage: "));
  assert.ok(line, `help text has no Usage line:\n${help}`);
  return line;
}

function parseUsageError(stderr: string): { code: string; message: string } {
  const payload = JSON.parse(stderr) as {
    error?: { code?: string; message?: string };
  };
  const code = payload.error?.code;
  const message = payload.error?.message;
  if (typeof code !== "string" || typeof message !== "string") {
    throw new Error(`stderr is not a USAGE_ERROR payload:\n${stderr}`);
  }
  return { code, message };
}

async function collectManifest(): Promise<LocalContractManifest> {
  const root = await runCli(["--help"]);
  assert.equal(root.exitCode, 0, root.stderr);
  const rootCommands = new Set(parseHelpCommandNames(root.stdout));
  for (const name of FROZEN_LOCAL_COMMANDS) {
    assert.ok(
      rootCommands.has(name),
      `frozen local command "${name}" missing from root help`
    );
  }

  const help = {} as Record<FrozenLocalCommand, HelpContract>;
  for (const name of FROZEN_LOCAL_COMMANDS) {
    const run = await runCli([name, "--help"]);
    assert.equal(run.exitCode, 0, `${name} --help failed:\n${run.stderr}`);
    help[name] = {
      usage: parseUsage(run.stdout),
      subcommands: parseHelpCommandNames(run.stdout),
    };
  }

  return {
    frozenTopLevelCommands: [...FROZEN_LOCAL_COMMANDS],
    help,
  };
}

function loadManifest(): LocalContractManifest {
  return JSON.parse(
    readFileSync(FIXTURE_PATH, "utf8")
  ) as LocalContractManifest;
}

test("frozen local command help matches the test-owned manifest", async () => {
  const actual = await collectManifest();
  if (process.env.UPDATE_LOCAL_CONTRACT === "1") {
    writeFileSync(FIXTURE_PATH, `${JSON.stringify(actual, null, 2)}\n`);
  }
  assert.deepEqual(actual, loadManifest());
});

test("local commands reject Cloud credential and project flags", async () => {
  const cases: Array<{ argv: string[]; unknownOption: string }> = [
    {
      argv: [
        "server",
        "probe",
        "--url",
        "https://example.com/mcp",
        "--api-key",
        "sk_test",
      ],
      unknownOption: "--api-key",
    },
    {
      argv: [
        "server",
        "doctor",
        "--url",
        "https://example.com/mcp",
        "--api-url",
        "https://app.mcpjam.com/api/v1",
      ],
      unknownOption: "--api-url",
    },
    {
      argv: [
        "server",
        "probe",
        "--url",
        "https://example.com/mcp",
        "--project",
        "acme",
      ],
      unknownOption: "--project",
    },
    {
      argv: [
        "tools",
        "list",
        "--url",
        "https://example.com/mcp",
        "--api-url",
        "https://app.mcpjam.com/api/v1",
      ],
      unknownOption: "--api-url",
    },
    {
      argv: [
        "tools",
        "call",
        "--url",
        "https://example.com/mcp",
        "--tool-name",
        "ping",
        "--api-key",
        "sk_test",
      ],
      unknownOption: "--api-key",
    },
    {
      argv: [
        "resources",
        "list",
        "--url",
        "https://example.com/mcp",
        "--api-key",
        "sk_test",
      ],
      unknownOption: "--api-key",
    },
    {
      argv: [
        "prompts",
        "list",
        "--url",
        "https://example.com/mcp",
        "--project",
        "acme",
      ],
      unknownOption: "--project",
    },
    {
      argv: [
        "oauth",
        "login",
        "--url",
        "https://example.com/mcp",
        "--api-key",
        "sk_test",
      ],
      unknownOption: "--api-key",
    },
    {
      argv: [
        "protocol",
        "conformance",
        "--url",
        "https://example.com/mcp",
        "--api-url",
        "https://app.mcpjam.com/api/v1",
      ],
      unknownOption: "--api-url",
    },
    {
      argv: [
        "compat",
        "--url",
        "https://example.com/mcp",
        "--api-key",
        "sk_test",
      ],
      unknownOption: "--api-key",
    },
    {
      argv: [
        "xaa",
        "run",
        "--url",
        "https://example.com/mcp",
        "--issuer-base-url",
        "https://issuer.example.com",
        "--sub",
        "user-1",
        "--project",
        "acme",
      ],
      unknownOption: "--project",
    },
    {
      argv: [
        "readiness",
        "check",
        "claude",
        "https://example.com/mcp",
        "--api-key",
        "sk_test",
      ],
      unknownOption: "--api-key",
    },
    {
      argv: ["telemetry", "status", "--api-key", "sk_test"],
      unknownOption: "--api-key",
    },
    {
      argv: ["mcp", "--api-url", "https://app.mcpjam.com/api/v1"],
      unknownOption: "--api-url",
    },
    {
      argv: [
        "--api-key",
        "sk_test",
        "server",
        "probe",
        "--url",
        "https://example.com/mcp",
      ],
      unknownOption: "--api-key",
    },
  ];

  for (const { argv, unknownOption } of cases) {
    const run = await runCli(["--format", "json", ...argv]);
    assert.equal(run.exitCode, 2, `${argv.join(" ")}\n${run.stderr}`);
    assert.equal(run.stdout, "", `${argv.join(" ")} wrote stdout`);
    const error = parseUsageError(run.stderr);
    assert.equal(error.code, "USAGE_ERROR", argv.join(" "));
    assert.match(
      error.message,
      new RegExp(`unknown option '${unknownOption}'`),
      `${argv.join(" ")}\n${run.stderr}`
    );
  }
});

test("representative local JSON stdout, stderr, and exit codes stay stable", async () => {
  const missingUrl = await runCli(["--format", "json", "server", "probe"]);
  assert.equal(missingUrl.exitCode, 2);
  assert.equal(missingUrl.stdout, "");
  assert.deepEqual(parseUsageError(missingUrl.stderr), {
    code: "USAGE_ERROR",
    message: "error: required option '--url <url>' not specified",
  });

  const missingTarget = await runCli(["--format", "json", "tools", "list"]);
  assert.equal(missingTarget.exitCode, 2);
  assert.equal(missingTarget.stdout, "");
  const missingTargetError = parseUsageError(missingTarget.stderr);
  assert.equal(missingTargetError.code, "USAGE_ERROR");
  assert.match(missingTargetError.message, /exactly one target/);

  const status = await runCli(["--format", "json", "telemetry", "status"]);
  assert.equal(status.exitCode, 0, status.stderr);
  assert.equal(status.stderr, "");
  const payload = JSON.parse(status.stdout) as {
    success?: boolean;
    telemetry?: { enabled?: boolean; disableReason?: string | null };
  };
  assert.equal(payload.success, true);
  assert.equal(payload.telemetry?.enabled, false);
  assert.equal(payload.telemetry?.disableReason, "MCPJAM_TELEMETRY_DISABLED");
});

test("local MCP serverInfo.name remains mcpjam", async () => {
  const handle = createMcpJamMcpServer({
    version: "0.0.0-test",
    defaultTimeoutMs: 15_000,
  });
  const [clientTransport, serverTransport] = createLinkedTransportPair();
  const client = new Client({ name: "mcpjam-cli-tests", version: "0.0.0" });

  try {
    await handle.server.connect(serverTransport as never);
    await client.connect(clientTransport as never);
    const serverInfo = client.getServerVersion();
    assert.equal(serverInfo?.name, "mcpjam");
    assert.equal(serverInfo?.title, "MCPJam CLI");
    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /MCPJam CLI running locally/);
    assert.match(instructions, /not the hosted MCPJam Cloud MCP/);
  } finally {
    await client.close().catch(() => undefined);
    await handle.close();
  }
});

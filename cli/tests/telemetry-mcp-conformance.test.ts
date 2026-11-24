import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { main } from "../src/index.js";
import { createMcpJamMcpServer } from "../src/lib/mcp-server.js";
import {
  MCPJAM_MCP_TOOLS,
  type McpJamToolCall,
} from "../src/lib/mcp-tool-runner.js";
import { captureMcpToolEvent, initTelemetry } from "../src/lib/telemetry.js";
import {
  captureProcessOutput,
  cleanTelemetryEnv,
  createRecordingClient,
  createStatePath,
} from "./support/telemetry-harness.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";
// Nothing listens on port 1, so every call fails fast and stays on the machine.
const DEAD_URL = "http://127.0.0.1:1/mcp";

/** The smallest arguments that pass a tool's input schema. */
function minimalArguments(schema: {
  properties?: Record<string, unknown>;
  required?: string[];
}): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const name of schema.required ?? []) {
    const property = schema.properties?.[name];
    const type =
      property && typeof property === "object" && "type" in property
        ? property.type
        : undefined;
    args[name] =
      type === "object"
        ? {}
        : type === "array"
          ? []
          : type === "number" || type === "integer"
            ? 1
            : type === "boolean"
              ? false
              : /url/i.test(name)
                ? DEAD_URL
                : "not-connected";
  }
  return args;
}

test("every mcpjam mcp tool reports one call under its own name, with no error text", async () => {
  const calls: McpJamToolCall[] = [];
  const handle = createMcpJamMcpServer({
    version: "0.0.0-test",
    defaultTimeoutMs: 2_000,
    onToolCalled: (call) => calls.push(call),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcpjam-cli-tests", version: "0.0.0" });
  await handle.server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [...MCPJAM_MCP_TOOLS].sort(),
      "MCPJAM_MCP_TOOLS must list exactly the tools the server registers",
    );

    for (const tool of tools) {
      const before = calls.length;
      const result = await client.callTool({
        name: tool.name,
        arguments: minimalArguments(tool.inputSchema),
      });

      assert.equal(calls.length, before + 1, tool.name);
      const call = calls[before];
      assert.equal(call.tool, tool.name);
      assert.equal(call.success, result.isError !== true, tool.name);
      assert.ok(call.durationMs >= 0, tool.name);
      if (call.success) {
        assert.equal(call.errorCode, undefined, tool.name);
      } else {
        assert.match(call.errorCode ?? "", /^[A-Z_]+$/, tool.name);
      }
      assert.deepEqual(
        Object.keys(call).sort(),
        call.success
          ? ["durationMs", "success", "tool"]
          : ["durationMs", "errorCode", "success", "tool"],
        tool.name,
      );
    }
  } finally {
    await client.close();
    await handle.close();
  }
});

async function runMcpCommand(argv: string[]) {
  const statePath = await createStatePath();
  const recorder = createRecordingClient();
  const program = new Command()
    .name("mcpjam")
    .option("--no-telemetry")
    .exitOverride();
  initTelemetry(program, "0.0.0-test", {
    statePath,
    env: cleanTelemetryEnv(),
    createId: () => UUID_A,
    createClient: recorder.createClient,
  });
  program.command("mcp").action(() => {
    captureMcpToolEvent({ tool: "list_servers", success: true, durationMs: 4.6 });
    captureMcpToolEvent({
      tool: "call_tool",
      success: false,
      durationMs: 12,
      errorCode: "SERVER_UNREACHABLE",
    });
  });
  await program.parseAsync(["node", "mcpjam", ...argv]);
  return recorder.events;
}

test("tool calls send cli_mcp_tool_called with enum fields only", async () => {
  const events = await runMcpCommand(["mcp"]);

  assert.equal(events.length, 2);
  assert.ok(events.every((event) => event.event === "cli_mcp_tool_called"));
  assert.ok(events.every((event) => event.distinctId === UUID_A));
  assert.deepEqual(events[0].properties, {
    tool: "list_servers",
    success: true,
    duration_ms: 5,
    cli_version: "0.0.0-test",
  });
  assert.deepEqual(events[1].properties, {
    tool: "call_tool",
    success: false,
    duration_ms: 12,
    cli_version: "0.0.0-test",
    error_code: "NETWORK_ERROR",
  });
});

test("tool calls send nothing with --no-telemetry", async () => {
  assert.deepEqual(await runMcpCommand(["--no-telemetry", "mcp"]), []);
});

test("events conformance sends conformance_run_triggered with suite events", async () => {
  const statePath = await createStatePath();
  const recorder = createRecordingClient();

  await captureProcessOutput(() =>
    main(
      ["node", "mcpjam", "--format", "json", "events", "conformance", "--url", DEAD_URL],
      {
        telemetry: {
          statePath,
          env: cleanTelemetryEnv(),
          createId: () => UUID_A,
          createClient: recorder.createClient,
        },
      },
    ),
  );

  const conformance = recorder.events.filter(
    (event) => event.event === "conformance_run_triggered",
  );
  assert.equal(conformance.length, 1);
  assert.deepEqual(conformance[0].properties, {
    run_source: "cli",
    suite: "events",
    mode: "single",
    cli_version: recorder.events.find((event) => event.event === "cli_command")
      ?.properties.cli_version,
  });
});

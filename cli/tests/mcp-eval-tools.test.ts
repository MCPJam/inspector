import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { PlatformApiClient } from "@mcpjam/sdk/platform";
import {
  HELD_OPERATION_NAMES,
  localEvalToolNames,
  operationAnnotations,
  operationDescription,
} from "@mcpjam/sdk/internal/mcp-surface";
import { createMcpJamMcpServer } from "../src/lib/mcp-server.js";
import {
  EVAL_TOOLS_SIGN_IN_MESSAGE,
  localEvalToolOperations,
  type ResolveEvalToolClient,
} from "../src/lib/mcp-eval-tools.js";
import {
  MCPJAM_MCP_TOOLS,
  type McpJamToolCall,
} from "../src/lib/mcp-tool-runner.js";

type FakeResponse = { status: number; body: unknown; requestId?: string };

/** A real client whose requests never leave the process. */
function clientAnswering(respond: (url: URL) => FakeResponse) {
  const requests: URL[] = [];
  const client = new PlatformApiClient({
    baseUrl: "https://mcpjam.example/api/v1",
    getAuth: () => "sk_test_token",
    fetch: async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      const { status, body, requestId } = respond(url);
      return new Response(JSON.stringify(body), {
        status,
        headers: {
          "content-type": "application/json",
          ...(requestId ? { "x-request-id": requestId } : {}),
        },
      });
    },
  });
  return { client, requests };
}

async function connect(options: {
  evals?: boolean;
  resolveEvalClient?: ResolveEvalToolClient;
  onToolCalled?: (call: McpJamToolCall) => void;
}) {
  const handle = createMcpJamMcpServer({ version: "0.0.0-test", ...options });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "eval-agent", version: "1.0.0" });
  await handle.server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await handle.close();
    },
  };
}

test("without --evals, the tools are the debugging tools alone", async () => {
  const session = await connect({});
  try {
    const { tools } = await session.client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [...MCPJAM_MCP_TOOLS].sort(),
    );
  } finally {
    await session.close();
  }
});

test("with --evals, it lists the hosted eval tools as the hosted server describes them, minus held betas", async () => {
  const session = await connect({ evals: true });
  try {
    const { tools } = await session.client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [...MCPJAM_MCP_TOOLS, ...localEvalToolNames()].sort(),
    );
    for (const operation of localEvalToolOperations()) {
      const tool = byName.get(operation.name);
      assert.ok(tool, operation.name);
      assert.equal(tool.title, operation.title);
      assert.equal(tool.description, operationDescription(operation));
      assert.deepEqual(tool.annotations, operationAnnotations(operation));
    }
    for (const held of HELD_OPERATION_NAMES) {
      assert.equal(byName.has(held), false, held);
    }
    assert.ok(byName.has("list_projects") && byName.has("run_eval_suite"));
  } finally {
    await session.close();
  }
});

test("a call runs on the resolved client, names the agent, and reports telemetry", async () => {
  const callers: (string | undefined)[] = [];
  const calls: McpJamToolCall[] = [];
  const { client, requests } = clientAnswering(() => ({
    status: 200,
    body: { items: [{ id: "proj_1", name: "Checkout" }] },
  }));
  const session = await connect({
    evals: true,
    resolveEvalClient: (callerName) => {
      callers.push(callerName);
      return { client, appOrigin: "https://mcpjam.example" };
    },
    onToolCalled: (call) => calls.push(call),
  });
  try {
    const result = (await session.client.callTool({
      name: "list_projects",
      arguments: {},
    })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
    assert.notEqual(result.isError, true);
    assert.deepEqual(
      (result.structuredContent?.items as { id: string }[]).map(
        (item) => item.id,
      ),
      ["proj_1"],
    );
    assert.ok(Array.isArray(result.structuredContent?.permalinks));
    assert.equal(requests[0]?.pathname, "/api/v1/projects");
    assert.deepEqual(callers, ["eval-agent"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.tool, "list_projects");
    assert.equal(calls[0]?.success, true);
  } finally {
    await session.close();
  }
});

test("a refusal keeps the server's code, reason and request id", async () => {
  const calls: McpJamToolCall[] = [];
  const { client } = clientAnswering(() => ({
    status: 400,
    requestId: "req_12345678",
    body: {
      code: "VALIDATION_ERROR",
      message: "Host host_1 is not attached to this suite.",
      details: { reason: "HOST_NOT_ATTACHED" },
    },
  }));
  const session = await connect({
    evals: true,
    resolveEvalClient: () => ({ client, appOrigin: "https://mcpjam.example" }),
    onToolCalled: (call) => calls.push(call),
  });
  try {
    const result = (await session.client.callTool({
      name: "list_projects",
      arguments: {},
    })) as {
      isError?: boolean;
      content: { text: string }[];
      structuredContent?: { error?: Record<string, unknown> };
    };
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /^VALIDATION_ERROR: Host host_1/);
    assert.match(result.content[0]!.text, /req_12345678/);
    assert.equal(result.structuredContent?.error?.code, "VALIDATION_ERROR");
    assert.equal(result.structuredContent?.error?.requestId, "req_12345678");
    assert.equal(calls[0]?.success, false);
    assert.equal(calls[0]?.errorCode, "VALIDATION_ERROR");
  } finally {
    await session.close();
  }
});

test("with no sign-in, an eval tool says how to sign in and debugging still works", async () => {
  const saved = {
    MCPJAM_API_KEY: process.env.MCPJAM_API_KEY,
    MCPJAM_AUTH_FILE: process.env.MCPJAM_AUTH_FILE,
  };
  delete process.env.MCPJAM_API_KEY;
  process.env.MCPJAM_AUTH_FILE = path.join(
    await mkdtemp(path.join(tmpdir(), "mcpjam-no-login-")),
    "auth.json",
  );
  const session = await connect({ evals: true });
  try {
    const result = (await session.client.callTool({
      name: "list_eval_suites",
      arguments: {},
    })) as { isError?: boolean; content: { text: string }[] };
    assert.equal(result.isError, true);
    assert.equal(result.content[0]!.text, EVAL_TOOLS_SIGN_IN_MESSAGE);
    const servers = (await session.client.callTool({
      name: "list_servers",
      arguments: {},
    })) as { isError?: boolean };
    assert.notEqual(servers.isError, true);
  } finally {
    await session.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

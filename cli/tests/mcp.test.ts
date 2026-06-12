import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import {
  buildTargetConfig,
  createMcpJamMcpServer,
  deriveServerName,
  type McpJamMcpServerHandle,
} from "../src/lib/mcp-server.js";

const TARGET_FIXTURE = fileURLToPath(
  new URL("./fixtures/notifying-target-server.mjs", import.meta.url),
);

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

interface TestContext {
  handle: McpJamMcpServerHandle;
  client: Client;
  callTool(name: string, args?: Record<string, unknown>): Promise<{
    isError: boolean;
    payload: any;
  }>;
  close(): Promise<void>;
}

async function startTestContext(): Promise<TestContext> {
  const handle = createMcpJamMcpServer({
    version: "0.0.0-test",
    defaultTimeoutMs: 15_000,
  });
  const [clientTransport, serverTransport] = createLinkedTransportPair();
  const client = new Client({ name: "mcpjam-cli-tests", version: "0.0.0" });

  await handle.server.connect(serverTransport as never);
  await client.connect(clientTransport as never);

  return {
    handle,
    client,
    async callTool(name, args = {}) {
      const result = (await client.callTool({
        name,
        arguments: args,
      })) as {
        isError?: boolean;
        content: Array<{ type: string; text?: string }>;
      };
      const text = result.content[0]?.text ?? "";
      return {
        isError: result.isError === true,
        payload: text ? JSON.parse(text) : undefined,
      };
    },
    async close() {
      await client.close().catch(() => undefined);
      await handle.close();
    },
  };
}

test("buildTargetConfig validates target selection", () => {
  assert.throws(() => buildTargetConfig({}, 1_000), /exactly one target/);
  assert.throws(
    () => buildTargetConfig({ url: "https://x.test/mcp", command: "node" }, 1_000),
    /exactly one target/,
  );
  assert.throws(
    () => buildTargetConfig({ url: "not a url" }, 1_000),
    /Invalid URL/,
  );
  assert.throws(
    () => buildTargetConfig({ url: "ftp://x.test/mcp" }, 1_000),
    /Invalid URL scheme/,
  );
  assert.throws(
    () => buildTargetConfig({ command: "node", accessToken: "tok" }, 1_000),
    /accessToken/,
  );
  assert.throws(
    () => buildTargetConfig({ url: "https://x.test/mcp", cwd: "/tmp" }, 1_000),
    /can only be used together with "command"/,
  );

  const http = buildTargetConfig(
    { url: "https://x.test/mcp", accessToken: "tok", timeoutMs: 5_000 },
    1_000,
  );
  assert.equal(http.target, "https://x.test/mcp");
  assert.equal((http.config as { accessToken?: string }).accessToken, "tok");
  assert.equal(http.config.timeout, 5_000);

  const stdio = buildTargetConfig(
    { command: "node", args: ["server.js"], env: { KEY: "v" } },
    1_000,
  );
  assert.equal(stdio.target, "node");
  assert.deepEqual((stdio.config as { args?: string[] }).args, ["server.js"]);
  assert.equal(stdio.config.timeout, 1_000);
});

test("deriveServerName derives readable unique names", () => {
  const taken = new Set(["x.test"]);
  assert.equal(
    deriveServerName({ url: "https://api.demo.test/mcp" }, () => false),
    "api.demo.test",
  );
  assert.equal(
    deriveServerName({ url: "https://x.test/mcp" }, (name) => taken.has(name)),
    "x.test-2",
  );
  assert.equal(
    deriveServerName({ command: "/usr/local/bin/node" }, () => false),
    "node",
  );
});

test("mcp server exposes the debugging tool surface", async () => {
  const context = await startTestContext();
  try {
    const tools = await context.client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "call_tool",
      "connect_server",
      "disconnect_server",
      "get_notifications",
      "get_prompt",
      "list_prompts",
      "list_resources",
      "list_servers",
      "list_tools",
      "ping_server",
      "probe_server",
      "read_resource",
      "server_doctor",
      "server_info",
    ]);
  } finally {
    await context.close();
  }
});

test("invalid input returns a structured tool error", async () => {
  const context = await startTestContext();
  try {
    const both = await context.callTool("connect_server", {
      url: "https://x.test/mcp",
      command: "node",
    });
    assert.equal(both.isError, true);
    assert.equal(both.payload.error.code, "USAGE_ERROR");

    const unknown = await context.callTool("list_tools", {
      server: "nope",
    });
    assert.equal(unknown.isError, true);
    assert.match(unknown.payload.error.message, /not connected/);
  } finally {
    await context.close();
  }
});

test("connect, exercise, observe notifications, disconnect", async () => {
  const context = await startTestContext();
  try {
    const connected = await context.callTool("connect_server", {
      name: "target",
      command: process.execPath,
      args: [TARGET_FIXTURE],
    });
    assert.equal(connected.isError, false, JSON.stringify(connected.payload));
    assert.equal(connected.payload.server, "target");
    assert.equal(connected.payload.status, "connected");
    assert.equal(
      connected.payload.initialization?.serverVersion?.name,
      "notifying-target",
    );

    const servers = await context.callTool("list_servers");
    assert.equal(servers.payload.servers.length, 1);
    assert.equal(servers.payload.servers[0].server, "target");
    assert.equal(servers.payload.servers[0].status, "connected");
    assert.equal(servers.payload.servers[0].target.kind, "stdio");

    const info = await context.callTool("server_info", { server: "target" });
    assert.equal(info.payload.initialization.transport, "stdio");

    const ping = await context.callTool("ping_server", { server: "target" });
    assert.equal(ping.payload.status, "ok");

    const tools = await context.callTool("list_tools", { server: "target" });
    assert.deepEqual(
      tools.payload.tools.map((tool: { name: string }) => tool.name),
      ["echo"],
    );

    const echoed = await context.callTool("call_tool", {
      server: "target",
      tool: "echo",
      arguments: { text: "hi" },
    });
    assert.equal(echoed.isError, false, JSON.stringify(echoed.payload));
    assert.equal(echoed.payload.content[0].text, "echo: hi");

    const resources = await context.callTool("list_resources", {
      server: "target",
    });
    assert.equal(resources.payload.resources[0].uri, "demo://greeting");

    const resource = await context.callTool("read_resource", {
      server: "target",
      uri: "demo://greeting",
    });
    assert.match(resource.payload.contents[0].text, /hello from the target/);

    const prompts = await context.callTool("list_prompts", {
      server: "target",
    });
    assert.equal(prompts.payload.prompts[0].name, "greet");

    const prompt = await context.callTool("get_prompt", {
      server: "target",
      prompt: "greet",
      arguments: { name: "Ada" },
    });
    assert.match(prompt.payload.messages[0].content.text, /Ada/);

    // The echo tool emits notifications/message before returning; poll
    // briefly because dispatch to the buffer is asynchronous.
    let logged: any;
    for (let attempt = 0; attempt < 40 && !logged; attempt += 1) {
      const notifications = await context.callTool("get_notifications", {
        server: "target",
        method: "notifications/message",
      });
      logged = notifications.payload.notifications.find(
        (entry: { params?: { data?: string } }) =>
          entry.params?.data === "echoed: hi",
      );
      if (!logged) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.ok(logged, "expected the echo log notification to be buffered");

    const disconnected = await context.callTool("disconnect_server", {
      server: "target",
    });
    assert.equal(disconnected.payload.status, "disconnected");

    const after = await context.callTool("list_servers");
    assert.equal(after.payload.servers.length, 0);

    const drained = await context.callTool("get_notifications", {
      server: "target",
    });
    assert.equal(drained.payload.notifications.length, 0);
  } finally {
    await context.close();
  }
});

test("connect_server cleans up failed connections so the name can be retried", async () => {
  const context = await startTestContext();
  try {
    const failed = await context.callTool("connect_server", {
      name: "flaky",
      command: process.execPath,
      args: ["-e", "process.exit(1)"],
    });
    assert.equal(failed.isError, true);

    const servers = await context.callTool("list_servers");
    assert.equal(servers.payload.servers.length, 0);

    const retried = await context.callTool("connect_server", {
      name: "flaky",
      command: process.execPath,
      args: [TARGET_FIXTURE],
    });
    assert.equal(retried.isError, false, JSON.stringify(retried.payload));
    assert.equal(retried.payload.status, "connected");

    await context.callTool("disconnect_server", { server: "flaky" });
  } finally {
    await context.close();
  }
});

test("server_doctor runs a stateless sweep against a stdio target", async () => {
  const context = await startTestContext();
  try {
    const doctor = await context.callTool("server_doctor", {
      command: process.execPath,
      args: [TARGET_FIXTURE],
    });
    assert.equal(doctor.isError, false, JSON.stringify(doctor.payload));
    assert.equal(doctor.payload.status, "ready");
    assert.equal(doctor.payload.tools.length, 1);
    assert.equal(doctor.payload.target.kind, "stdio");
  } finally {
    await context.close();
  }
});

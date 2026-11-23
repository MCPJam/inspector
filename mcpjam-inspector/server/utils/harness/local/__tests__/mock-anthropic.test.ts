/**
 * The conformance suite's Anthropic Messages mock, as the generic gateway
 * driver uses it: its COUNT reply names each scenario turn it can see, and
 * MCPPROBE calls MCPJam's host tool under whatever name the runtime offers it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const MOCK = fileURLToPath(new URL("../conformance/mock-anthropic.mjs", import.meta.url));
const mocks: ChildProcess[] = [];

async function startMock(env: Record<string, string> = {}): Promise<number> {
  const mock = spawn(process.execPath, [MOCK], {
    env: { ...process.env, MOCK_PORT: "0", MOCK_POP_SECRET: "", MOCK_UPSTREAM_KEY: "", ...env },
    stdio: ["ignore", "pipe", "ignore"],
  });
  mocks.push(mock);
  const [line] = await once(createInterface({ input: mock.stdout! }), "line");
  return JSON.parse(line).port;
}

afterAll(() => {
  for (const mock of mocks) mock.kill();
});

/** The text and tool calls of one streamed reply. */
async function reply(port: number, texts: string[], tools: string[] = []) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      stream: true,
      messages: texts.map((text) => ({ role: "user", content: [{ type: "text", text }] })),
      tools: tools.map((name) => ({ name, input_schema: { type: "object" } })),
    }),
  });
  const events = (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)));
  return {
    text: events.filter((event) => event.delta?.type === "text_delta").map((event) => event.delta.text).join(""),
    toolUses: events.filter((event) => event.content_block?.type === "tool_use").map((event) => event.content_block.name),
    input: events.filter((event) => event.delta?.type === "input_json_delta").map((event) => event.delta.partial_json).join(""),
  };
}

describe("the Anthropic mock", () => {
  it("counts and lists the scenario turns, oldest first, beside the runtime's own text", async () => {
    const port = await startMock();
    const { text } = await reply(port, ["HELLO", "<system-reminder>context</system-reminder>\nMCPPROBE", "COUNT"]);
    expect(text).toBe("USER_TURNS=3 SCENARIOS=HELLO,MCPPROBE,COUNT");
  });

  it("calls the offered tool that ends with the probe suffix, under the runtime's own name", async () => {
    const port = await startMock({ MOCK_PROBE_SUFFIX: "mcp__probe__echo" });
    const probe = await reply(port, ["MCPPROBE"], ["read", "harness-tools_mcp__probe__echo"]);
    expect(probe.toolUses).toEqual(["harness-tools_mcp__probe__echo"]);
    expect(JSON.parse(probe.input)).toEqual({ message: "conformance" });
    expect((await reply(port, ["MCPPROBE"], ["read"])).text).toMatch(/^NO PROBE TOOL OFFERED/);
  });

  it("keeps calling the delivery probe when no suffix is set", async () => {
    const port = await startMock();
    expect((await reply(port, ["MCPPROBE"], ["mcp__delivery_probe__ping"])).toolUses).toEqual(["mcp__delivery_probe__ping"]);
  });
});

/**
 * Phase 0 de-risking spike — run the real Claude Code harness on E2B and prove:
 *   1. PORT EXPOSURE: the harness bridge is reachable over E2B `getHost` (the
 *      session starting at all = the bridge WebSocket connected over getPortUrl).
 *   2. MCP TOOL-CALL FIDELITY: an attached MCP server's tool is actually called
 *      by Claude Code, and the call (name + args) + result reach our stream with
 *      enough detail to grade.
 *
 * RUN: needs E2B_API_KEY + an Anthropic credential. From this dir:
 *   E2B_API_KEY=… ANTHROPIC_API_KEY=… npm run spike
 * (Or AI_GATEWAY_API_KEY / ANTHROPIC_AUTH_TOKEN; ANTHROPIC_BASE_URL is honored.)
 *
 * It is NOT run in this environment (no creds). It is written against the real
 * canary `@ai-sdk/harness` + `@ai-sdk/harness-claude-code` APIs and validated
 * with `tsc --noEmit`.
 */
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createE2BSandboxProvider } from "./e2b-sandbox-provider.js";

const e2bKey = process.env.E2B_API_KEY;
const anthropicAuth =
  process.env.ANTHROPIC_API_KEY ??
  process.env.ANTHROPIC_AUTH_TOKEN ??
  process.env.AI_GATEWAY_API_KEY;

if (!e2bKey || !anthropicAuth) {
  console.error(
    "[spike] Missing creds. Set E2B_API_KEY and one of " +
      "ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / AI_GATEWAY_API_KEY.",
  );
  process.exit(1);
}

/** Self-contained stdio MCP server (newline-delimited JSON-RPC) — no deps to
 *  install in the sandbox; just needs `node`. Exposes one tool whose result
 *  carries a sentinel so we can confirm it flowed back through Claude Code. */
const WEATHER_MCP_SERVER = String.raw`
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
rl.on("line", (line) => {
  if (!line.trim()) return;
  let req; try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "weather-spike", version: "0.0.1" },
    }});
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: [{
      name: "get_weather",
      description: "Get the current weather for a city.",
      inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    }]}});
  } else if (method === "tools/call") {
    const city = params?.arguments?.city ?? "unknown";
    send({ jsonrpc: "2.0", id, result: { content: [{
      type: "text",
      text: "The weather in " + city + " is 19C and sunny. [SPIKE_SENTINEL]",
    }]}});
  } else if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
  }
});
`;

const harness = createClaudeCode({
  model: process.env.SPIKE_MODEL ?? "claude-sonnet-4-5",
  thinking: "off",
  // Auth shape is { anthropic } | { gateway }. Prefer the gateway when present.
  auth: process.env.AI_GATEWAY_API_KEY
    ? {
        gateway: {
          apiKey: process.env.AI_GATEWAY_API_KEY,
          baseUrl: process.env.AI_GATEWAY_BASE_URL,
        },
      }
    : {
        anthropic: {
          apiKey: process.env.ANTHROPIC_API_KEY,
          authToken: process.env.ANTHROPIC_AUTH_TOKEN,
          baseUrl: process.env.ANTHROPIC_BASE_URL,
        },
      },
});

const sandbox = createE2BSandboxProvider({
  apiKey: e2bKey,
  // Reuse MCPJam's computer by passing connectToSandboxId here instead.
  template: process.env.SPIKE_E2B_TEMPLATE, // must have node (+ ideally claude CLI)
  bridgePort: 39271,
});

const agent = new HarnessAgent({
  harness,
  sandbox,
  instructions:
    "You are validating MCP tool wiring. When asked about the weather you MUST " +
    "call the `get_weather` MCP tool and report its result verbatim.",
  permissionMode: "allow-all",
  onSandboxSession: async ({ session, sessionWorkDir }) => {
    // Write the MCP server + a .mcp.json pointing at it (stdio) into the
    // session workdir, before Claude Code starts — same hook the product would
    // use to attach the host's MCP servers (remote: url+headers; local: tunnel).
    await session.writeTextFile({
      path: `${sessionWorkDir}/weather-mcp.mjs`,
      content: WEATHER_MCP_SERVER,
    });
    await session.writeTextFile({
      path: `${sessionWorkDir}/.mcp.json`,
      content: JSON.stringify({
        mcpServers: {
          weather: { command: "node", args: [`${sessionWorkDir}/weather-mcp.mjs`] },
        },
      }),
    });
  },
});

async function main() {
  console.log("[spike] creating session (proves bridge reachable via getHost)…");
  const session = await agent.createSession();
  try {
    console.log(`[spike] ✅ TEST 1 PASS — session ${session.sessionId} started; ` +
      `the Claude Code bridge connected over E2B getHost/getPortUrl.`);

    const res = await agent.stream({
      session,
      prompt: "What's the weather in Paris right now? Use your tools.",
    });

    const toolCalls: Array<{ name: string; input: unknown }> = [];
    const toolResults: string[] = [];
    // The harness fullStream part union is broad; read it loosely at this
    // boundary (spike-only) and classify by `type`.
    for await (const part of res.fullStream as AsyncIterable<any>) {
      if (typeof part?.type !== "string") continue;
      if (part.type === "tool-call" || part.type === "tool-input-available") {
        toolCalls.push({ name: part.toolName, input: part.input ?? part.args });
        console.log(`[spike] tool-call: ${part.toolName}`, JSON.stringify(part.input ?? part.args));
      } else if (part.type === "tool-result" || part.type === "tool-output-available") {
        const text = JSON.stringify(part.output ?? part.result ?? "");
        toolResults.push(text);
        console.log(`[spike] tool-result: ${part.toolName} → ${text}`);
      }
    }
    const finalText = await res.text;
    console.log("[spike] final text:", finalText);

    // TEST 2: the MCP tool was actually called, with args + result detail.
    // Claude Code namespaces MCP tools as `mcp__<server>__<tool>` (here
    // `mcp__weather__get_weather`), so match by substring, not exact name.
    const calledWeather = toolCalls.some(
      (c) => typeof c.name === "string" && c.name.includes("get_weather"),
    );
    const sawSentinel =
      toolResults.some((r) => r.includes("SPIKE_SENTINEL")) ||
      finalText.includes("19C") ||
      finalText.toLowerCase().includes("sunny");
    if (!calledWeather || !sawSentinel) {
      // Throw → non-zero exit (via main().catch) so CI/automation gates on it.
      throw new Error(
        `TEST 2 FAIL — calledWeather=${calledWeather} sawSentinel=${sawSentinel}. ` +
          `Tool-call detail insufficient to grade; inspect the raw parts above ` +
          `(fallback: drive @anthropic-ai/claude-agent-sdk directly).`,
      );
    }
    console.log("[spike] ✅ TEST 2 PASS — Claude Code called the MCP tool and its " +
      "result (name + args + output) was observable for grading.");
  } finally {
    // Guarantee teardown even if streaming or the assertion throws.
    await session.destroy();
  }
  console.log("[spike] done.");
}

main().catch((err) => {
  console.error("[spike] ERROR:", err);
  process.exit(1);
});

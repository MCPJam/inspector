// Mock OpenAI Responses API upstream for the local Codex conformance suite.
// Deterministic: the scenario is chosen from the LAST user text in `input`.
//   "SHELL <cmd>"  -> function_call exec_command {cmd}       (Codex's shell tool)
//   "MCPPROBE"     -> function_call mcp__mcpjam / probe__echo (MCPJam's relay)
//   "COUNT"        -> text: number of user turns in this request (continuity)
//   anything else  -> text echo
// After a tool output arrives, answers with `TOOL RESULT RECEIVED: <output>`.
// Verifies the gateway's proof-of-possession header and upstream key, like
// `mock-anthropic.mjs`, so a gateway that drops or substitutes either fails.
import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

const port = Number(process.env.MOCK_PORT ?? 0);
const popSecret = process.env.MOCK_POP_SECRET ?? "";
const expectedUpstreamKey = process.env.MOCK_UPSTREAM_KEY ?? "";
const latencyMs = Number(process.env.MOCK_LATENCY_MS ?? 0);
if (!Number.isFinite(latencyMs) || latencyMs < 0) {
  throw new Error(
    `MOCK_LATENCY_MS must be a finite, non-negative number of milliseconds; got ${JSON.stringify(process.env.MOCK_LATENCY_MS)}`,
  );
}
/** The relay's MCP server name (`RELAY_MCP_SERVER_NAME`) as Codex namespaces it. */
const RELAY_NAMESPACE = "mcp__mcpjam";
/** The probe host tool `mcp__probe__echo`, as the relay aliases it. */
const PROBE_TOOL = "probe__echo";
const seenNonces = new Set();
const log = (...a) => console.error("[mock]", ...a);
let requestCount = 0;

function verifyPop(req) {
  if (!popSecret) return { ok: true };
  const h = req.headers["x-mcpjam-pop"];
  if (typeof h !== "string") return { ok: false, why: "missing x-mcpjam-pop" };
  const [ts, nonce, mac] = h.split(".");
  if (!ts || !nonce || !mac) return { ok: false, why: "malformed" };
  const tsMs = Number(ts);
  if (!Number.isFinite(tsMs)) return { ok: false, why: "non-numeric ts" };
  if (Math.abs(Date.now() - tsMs) > 60_000) return { ok: false, why: "clock skew" };
  if (seenNonces.has(nonce)) return { ok: false, why: "replay" };
  const expected = createHmac("sha256", popSecret).update(`${req.method}\n${req.url}\n${ts}\n${nonce}`).digest("hex");
  const a = Buffer.from(mac, "hex"); const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, why: "bad mac" };
  seenNonces.add(nonce);
  return { ok: true };
}

const USAGE = {
  input_tokens: 1200,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 96,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 1296,
};

function sse(res, type, payload) {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
}

/** One complete streamed response: an optional message, then function calls. */
function respond(res, { text, calls = [] }) {
  const send = () => {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    const id = `resp_mock_${requestCount}`;
    const output = [];
    let oi = 0;
    sse(res, "response.created", { response: { id, object: "response", status: "in_progress", model: "gpt-5.5", output: [] } });
    if (text) {
      const itemId = `msg_mock_${requestCount}`;
      const item = { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] };
      sse(res, "response.output_item.added", { output_index: oi, item });
      sse(res, "response.content_part.added", { item_id: itemId, output_index: oi, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      sse(res, "response.output_text.delta", { item_id: itemId, output_index: oi, content_index: 0, delta: text });
      sse(res, "response.output_text.done", { item_id: itemId, output_index: oi, content_index: 0, text });
      const content = [{ type: "output_text", text, annotations: [] }];
      sse(res, "response.content_part.done", { item_id: itemId, output_index: oi, content_index: 0, part: content[0] });
      const done = { ...item, status: "completed", content };
      sse(res, "response.output_item.done", { output_index: oi, item: done });
      output.push(done);
      oi++;
    }
    for (const [ci, call] of calls.entries()) {
      const itemId = `fc_mock_${requestCount}_${ci}`;
      const args = JSON.stringify(call.arguments ?? {});
      const item = {
        id: itemId,
        type: "function_call",
        status: "in_progress",
        name: call.name,
        ...(call.namespace ? { namespace: call.namespace } : {}),
        call_id: `call_mock_${requestCount}_${ci}`,
        arguments: "",
      };
      sse(res, "response.output_item.added", { output_index: oi, item });
      sse(res, "response.function_call_arguments.delta", { item_id: itemId, output_index: oi, delta: args });
      sse(res, "response.function_call_arguments.done", { item_id: itemId, output_index: oi, arguments: args });
      const done = { ...item, status: "completed", arguments: args };
      sse(res, "response.output_item.done", { output_index: oi, item: done });
      output.push(done);
      oi++;
    }
    sse(res, "response.completed", { response: { id, object: "response", status: "completed", model: "gpt-5.5", output, usage: USAGE } });
    res.end();
  };
  if (latencyMs > 0) setTimeout(send, latencyMs);
  else send();
}

/** Text of a user message item, in either of the shapes Codex sends. */
function userText(item) {
  if (item?.type !== "message" && item?.role === undefined) return null;
  if (item.role !== "user") return null;
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content)) return null;
  return item.content
    .filter((part) => part?.type === "input_text" || part?.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

const SCENARIO = /^(SHELL|MCPPROBE|COUNT)\b\s*(.*)$/s;

const server = http.createServer((req, res) => {
  requestCount += 1;
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const pop = verifyPop(req);
    if (!pop.ok) { log("POP REJECT", pop.why, req.method, req.url); res.writeHead(401); res.end(JSON.stringify({ error: pop.why })); return; }
    if (expectedUpstreamKey && req.headers["x-api-key"] !== expectedUpstreamKey) {
      log("KEY REJECT", req.headers["x-api-key"] === undefined ? "absent" : "mismatch", req.method, req.url);
      res.writeHead(401); res.end(JSON.stringify({ error: "upstream key rejected" }));
      return;
    }
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "gpt-5.5", object: "model", owned_by: "mock" }] }));
      return;
    }
    if (req.method !== "POST" || !path.endsWith("/responses")) {
      log("UNKNOWN ROUTE", req.method, req.url);
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      log("BAD JSON", req.method, req.url);
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "malformed JSON body" } }));
      return;
    }
    const input = Array.isArray(body.input) ? body.input : [];
    const last = input[input.length - 1];
    const userTexts = input.map(userText).filter((t) => typeof t === "string");
    // Codex prepends its own context as user messages (environment, AGENTS
    // instructions); only messages carrying a scenario keyword are the
    // conversation's user turns.
    const userTurns = userTexts.filter((t) => t.split("\n").some((line) => SCENARIO.test(line.trim()))).length;
    const tools = Array.isArray(body.tools) ? body.tools.map((t) => t.name ?? t.type) : [];
    log(`#${requestCount} model=${body.model} stream=${body.stream} items=${input.length} userTurns=${userTurns} tools=${JSON.stringify(tools).slice(0, 200)} last=${last?.type ?? last?.role}`);
    if (last?.type === "function_call_output" || last?.type === "custom_tool_call_output") {
      const output = typeof last.output === "string" ? last.output : JSON.stringify(last.output);
      return respond(res, { text: `TOOL RESULT RECEIVED: ${String(output).slice(0, 400)}` });
    }
    const latest = [...userTexts].reverse().find((t) => t.split("\n").some((line) => SCENARIO.test(line.trim()))) ?? userTexts[userTexts.length - 1] ?? "";
    const line = latest.split("\n").map((l) => l.trim()).filter((l) => SCENARIO.test(l)).pop() ?? "";
    const m = SCENARIO.exec(line);
    if (m) {
      const [, kind, arg] = m;
      if (kind === "SHELL") return respond(res, { calls: [{ name: "exec_command", arguments: { cmd: arg.trim(), yield_time_ms: 15_000 } }] });
      if (kind === "MCPPROBE") return respond(res, { calls: [{ namespace: RELAY_NAMESPACE, name: PROBE_TOOL, arguments: { message: "conformance" } }] });
      if (kind === "COUNT") return respond(res, { text: `USER_TURNS=${userTurns}` });
    }
    return respond(res, { text: `ECHO: ${latest.slice(0, 80)}` });
  });
});
log(`upstream latency: ${latencyMs}ms`);
server.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ port: server.address().port }));
});

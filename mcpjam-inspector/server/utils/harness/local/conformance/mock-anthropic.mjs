// Mock Anthropic Messages API upstream for the local-harness conformance suite.
// Deterministic: the scenario is chosen from the LAST user text message.
//   "READFILE <path>"  -> tool_use Read {file_path}
//   "BASH <cmd>"       -> tool_use Bash {command}
//   "WRITE <path>"     -> tool_use Write {file_path, content}
//   "COUNT"            -> text: number of user turns seen in this request (continuity probe)
//   anything else      -> text echo
// After a tool_result arrives, answers with a final text summarising the result.
// Verifies the gateway's proof-of-possession header when MOCK_POP_SECRET is set.
import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

const port = Number(process.env.MOCK_PORT ?? 0);
const popSecret = process.env.MOCK_POP_SECRET ?? "";
const seenNonces = new Set();
const log = (...a) => console.error("[mock]", ...a);
let requestCount = 0;

function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const [event, data] of events) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  res.end();
}
function textEvents(id, text, inputTokens) {
  return [
    ["message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: "claude-haiku-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 12 } }],
    ["message_stop", { type: "message_stop" }],
  ];
}
function toolEvents(id, name, input, inputTokens) {
  const json = JSON.stringify(input);
  return [
    ["message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: "claude-haiku-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `Using ${name}.` } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: `toolu_${id}`, name, input: {} } }],
    ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: json } }],
    ["content_block_stop", { type: "content_block_stop", index: 1 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 30 } }],
    ["message_stop", { type: "message_stop" }],
  ];
}
function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return { text: m.content, toolResult: null };
    const blocks = Array.isArray(m.content) ? m.content : [];
    const tr = blocks.find((b) => b.type === "tool_result");
    if (tr) return { text: null, toolResult: tr };
    const t = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    return { text: t, toolResult: null };
  }
  return { text: "", toolResult: null };
}
function verifyPop(req) {
  if (!popSecret) return { ok: true };
  const h = req.headers["x-mcpjam-pop"];
  if (typeof h !== "string") return { ok: false, why: "missing x-mcpjam-pop" };
  const [ts, nonce, mac] = h.split(".");
  if (!ts || !nonce || !mac) return { ok: false, why: "malformed" };
  if (Math.abs(Date.now() - Number(ts)) > 60_000) return { ok: false, why: "clock skew" };
  if (seenNonces.has(nonce)) return { ok: false, why: "replay" };
  const expected = createHmac("sha256", popSecret).update(`${req.method}\n${req.url}\n${ts}\n${nonce}`).digest("hex");
  const a = Buffer.from(mac, "hex"); const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, why: "bad mac" };
  seenNonces.add(nonce);
  return { ok: true };
}
const server = http.createServer((req, res) => {
  requestCount += 1;
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const pop = verifyPop(req);
    if (!pop.ok) { log("POP REJECT", pop.why, req.method, req.url); res.writeHead(401); res.end(JSON.stringify({ error: pop.why })); return; }
    if (req.method === "POST" && req.url?.startsWith("/v1/messages")) {
      if (req.url.includes("count_tokens")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ input_tokens: 42 })); return; }
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const userTurns = messages.filter((m) => m.role === "user" && (typeof m.content === "string" || (Array.isArray(m.content) && m.content.some((b) => b.type === "text")))).length;
      const id = `msg_${requestCount}`;
      const { text, toolResult } = lastUserText(messages);
      const tools = Array.isArray(body.tools) ? body.tools.map((t) => t.name) : [];
      log(`#${requestCount} model=${body.model} stream=${body.stream} msgs=${messages.length} userTurns=${userTurns} tools=${tools.length} last=${toolResult ? "tool_result" : JSON.stringify((text ?? "").slice(0, 60))}`);
      const inputTokens = 100 + messages.length * 10;
      if (toolResult) {
        const content = Array.isArray(toolResult.content) ? toolResult.content.map((b) => b.text ?? "").join("") : String(toolResult.content ?? "");
        return sse(res, textEvents(id, `TOOL RESULT RECEIVED: ${content.slice(0, 200)}`, inputTokens));
      }
      const t = (text ?? "").trim();
      if (t.split("\n").some((l) => /^SLOW\b/.test(l))) {
        log("SLOW scenario: holding the response 8s");
        setTimeout(() => sse(res, textEvents(id, "SLOW DONE", inputTokens)), 8000);
        return;
      }
      const m = /^(READFILE|BASH|WRITE|COUNT)\b\s*(.*)$/s.exec(t.split("\n").filter((l) => /^(READFILE|BASH|WRITE|COUNT)\b/.test(l)).pop() ?? "");
      if (m) {
        const [, kind, arg] = m;
        if (kind === "READFILE") return sse(res, toolEvents(id, "Read", { file_path: arg.trim() }, inputTokens));
        if (kind === "BASH") return sse(res, toolEvents(id, "Bash", { command: arg.trim() }, inputTokens));
        if (kind === "WRITE") return sse(res, toolEvents(id, "Write", { file_path: arg.trim(), content: "written by the conformance mock\n" }, inputTokens));
        if (kind === "COUNT") return sse(res, textEvents(id, `USER_TURNS=${userTurns}`, inputTokens));
      }
      return sse(res, textEvents(id, `ECHO: ${t.slice(0, 80)}`, inputTokens));
    }
    log("UNKNOWN ROUTE", req.method, req.url);
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
});
server.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ port: server.address().port }));
});

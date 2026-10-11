// Shared rig for the codex-probe probes (a)-(e).
//
// Derived from ../{fake-responses-server,app-server-client}.mjs
// (read-only there). Extensions over those:
//   - fake server logs EVERY request (method, raw url, path, selected headers,
//     body) and every HTTP upgrade attempt, on any path, so a URL-shape probe
//     sees exactly what codex hits;
//   - a script step may be a function of the request (dynamic scripting), may
//     carry `namespace` on a function call (for namespaced MCP tools), and may
//     delay;
//   - the app-server can be spawned `detached` (own process group), the way a
//     supervisor would, so the group can be signalled as a unit.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  appendFileSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const HERE = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
export const CODEX_JS = join(HERE, "node_modules/@openai/codex/bin/codex.js");
export const RUNS = join(HERE, "runs");

const USAGE = {
  input_tokens: 1200,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 96,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 1296,
};

/**
 * script: array of steps (entry N answers model request N; last repeats) OR
 *         function({body, index, path}) => step.
 * step:   { text?, functionCalls?: [{name, namespace?, arguments, callId?}],
 *           customToolCalls?: [{name, input, callId?}], delayMs?, status? }
 */
export function createFake({ script, logPath }) {
  if (logPath) {
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, "");
  }
  const requests = [];
  let index = 0;
  const log = (entry) => {
    requests.push(entry);
    if (logPath) appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  };
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const path = (req.url ?? "").split("?")[0];
      let parsed;
      try {
        parsed = body ? JSON.parse(body) : undefined;
      } catch {
        parsed = { unparsed: body.slice(0, 2000) };
      }
      const entry = {
        t: Date.now(),
        method: req.method,
        url: req.url,
        path,
        headers: {
          host: req.headers.host,
          "content-type": req.headers["content-type"],
          "user-agent": req.headers["user-agent"],
          originator: req.headers.originator,
          hasAuthorization: Boolean(req.headers.authorization),
        },
        body: parsed,
      };
      log(entry);
      if (req.method === "GET" && path.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "gpt-5-nano", object: "model", owned_by: "fake" }] }));
        return;
      }
      if (req.method !== "POST" || !path.endsWith("/responses")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `no route for ${req.method} ${path}` } }));
        return;
      }
      const i = index++;
      let step;
      if (typeof script === "function") step = await script({ body: parsed, index: i, path });
      else step = script[Math.min(i, script.length - 1)] ?? { text: "done" };
      step ??= { text: "done" };
      if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
      if (step.status) {
        res.writeHead(step.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: step.errorMessage ?? "scripted error" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      streamStep(res, step, i + 1);
    });
  });
  server.on("upgrade", (req, socket) => {
    log({ t: Date.now(), method: req.method, url: req.url, path: (req.url ?? "").split("?")[0], upgrade: req.headers.upgrade });
    socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
  });
  return {
    server,
    requests,
    async listen(port = 0, host = "127.0.0.1") {
      await new Promise((r) => server.listen(port, host, r));
      return `http://${host}:${server.address().port}`;
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

function sse(res, type, payload) {
  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
}

function streamStep(res, step, turn) {
  const responseId = `resp_fake_${turn}`;
  const output = [];
  let oi = 0;
  sse(res, "response.created", {
    response: { id: responseId, object: "response", created_at: Math.floor(Date.now() / 1000), status: "in_progress", model: "gpt-5-nano", output: [] },
  });
  if (step.text) {
    const itemId = `msg_fake_${turn}`;
    const item = { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] };
    sse(res, "response.output_item.added", { output_index: oi, item });
    sse(res, "response.content_part.added", { item_id: itemId, output_index: oi, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    sse(res, "response.output_text.delta", { item_id: itemId, output_index: oi, content_index: 0, delta: step.text });
    sse(res, "response.output_text.done", { item_id: itemId, output_index: oi, content_index: 0, text: step.text });
    const content = [{ type: "output_text", text: step.text, annotations: [] }];
    sse(res, "response.content_part.done", { item_id: itemId, output_index: oi, content_index: 0, part: content[0] });
    const done = { ...item, status: "completed", content };
    sse(res, "response.output_item.done", { output_index: oi, item: done });
    output.push(done);
    oi++;
  }
  for (const [ci, call] of (step.customToolCalls ?? []).entries()) {
    const itemId = `ctc_fake_${turn}_${ci}`;
    const input = typeof call.input === "string" ? call.input : JSON.stringify(call.input ?? {});
    const item = { id: itemId, type: "custom_tool_call", status: "in_progress", name: call.name, call_id: call.callId ?? `call_fake_${turn}_${ci}`, input: "" };
    sse(res, "response.output_item.added", { output_index: oi, item });
    sse(res, "response.custom_tool_call_input.delta", { item_id: itemId, output_index: oi, delta: input });
    sse(res, "response.custom_tool_call_input.done", { item_id: itemId, output_index: oi, input });
    const done = { ...item, status: "completed", input };
    sse(res, "response.output_item.done", { output_index: oi, item: done });
    output.push(done);
    oi++;
  }
  for (const [ci, call] of (step.functionCalls ?? []).entries()) {
    const itemId = `fc_fake_${turn}_${ci}`;
    const args = typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {});
    const item = {
      id: itemId,
      type: "function_call",
      status: "in_progress",
      name: call.name,
      ...(call.namespace ? { namespace: call.namespace } : {}),
      call_id: call.callId ?? `call_fake_${turn}_${ci}`,
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
  sse(res, "response.completed", {
    response: { id: responseId, object: "response", status: "completed", model: "gpt-5-nano", output, usage: USAGE },
  });
  res.end();
}

/** A fresh per-probe directory tree: home/, codex-home/, cwd/, tmp/. */
export function freshDirs(name) {
  const root = join(RUNS, name);
  rmSync(root, { recursive: true, force: true });
  const dirs = {
    root,
    home: join(root, "home"),
    codexHome: join(root, "codex-home"),
    cwd: join(root, "cwd"),
    tmp: join(root, "tmp"),
  };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  return dirs;
}

/** TOML for a CODEX_HOME config.toml (only the bits these probes need). */
export function renderConfig({ baseUrl, mcpServers = {}, extra = "" }) {
  const q = JSON.stringify;
  const lines = [
    'model = "gpt-5-nano"',
    'model_provider = "probe"',
    'web_search = "disabled"',
    "",
    "[model_providers.probe]",
    'name = "probe"',
    `base_url = ${q(baseUrl)}`,
    'env_key = "PROBE_API_KEY"',
    'wire_api = "responses"',
  ];
  for (const [name, c] of Object.entries(mcpServers)) {
    lines.push("", `[mcp_servers.${name}]`, `command = ${q(c.command)}`, `args = [${(c.args ?? []).map(q).join(", ")}]`);
    for (const [k, v] of Object.entries(c)) {
      if (["command", "args", "env"].includes(k)) continue;
      lines.push(`${k} = ${typeof v === "string" ? q(v) : v}`);
    }
    if (c.env) {
      lines.push("", `[mcp_servers.${name}.env]`);
      for (const [k, v] of Object.entries(c.env)) lines.push(`${k} = ${q(v)}`);
    }
  }
  if (extra) lines.push("", extra);
  return `${lines.join("\n")}\n`;
}

/** Spawn `node codex.js app-server` and speak JSONL JSON-RPC. */
export function startAppServer({ codexHome, cwd, home, env = {}, logPath, detached = false, wrapper = [] }) {
  if (logPath) {
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, "");
  }
  const logf = (direction, frame) => logPath && appendFileSync(logPath, `${JSON.stringify({ t: Date.now(), direction, frame })}\n`);
  const fullEnv = {
    ...process.env,
    HOME: home,
    CODEX_HOME: codexHome,
    PROBE_API_KEY: "probe-placeholder",
    RUST_LOG: process.env.RUST_LOG ?? "warn",
    ...env,
  };
  // Never leak the real agent proxy credentials into codex's own outbound
  // config unless a probe opts in; codex only talks to 127.0.0.1 here.
  const argv = [...wrapper, process.execPath, CODEX_JS, "app-server"];
  const child = spawn(argv[0], argv.slice(1), { cwd, env: fullEnv, stdio: ["pipe", "pipe", "pipe"], detached });
  const events = new EventEmitter();
  events.setMaxListeners(100);
  const pending = new Map();
  const notifications = [];
  const serverRequests = [];
  const stderr = [];
  let serverRequestHandler = async () => ({ decision: "decline" });
  let nextId = 1;
  let buf = "";
  let dead = null;
  const send = (frame) => {
    logf("out", frame);
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  };
  const handle = (frame) => {
    logf("in", frame);
    if (frame.id !== undefined && frame.method !== undefined) {
      serverRequests.push(frame);
      events.emit("serverRequest", frame);
      Promise.resolve(serverRequestHandler(frame)).then(
        (result) => send({ jsonrpc: "2.0", id: frame.id, result }),
        (e) => send({ jsonrpc: "2.0", id: frame.id, error: { code: -32603, message: String(e?.message ?? e) } })
      );
      return;
    }
    if (frame.method !== undefined) {
      notifications.push(frame);
      events.emit("notification", frame);
      return;
    }
    const p = pending.get(frame.id);
    if (!p) return;
    pending.delete(frame.id);
    if (frame.error) p.reject(Object.assign(new Error(JSON.stringify(frame.error)), { rpcError: frame.error }));
    else p.resolve(frame.result);
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        handle(JSON.parse(line));
      } catch {
        stderr.push(`[unparsed stdout] ${line}`);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => {
    stderr.push(c);
    if (logPath) appendFileSync(`${logPath}.stderr`, c);
  });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  child.on("exit", (code, signal) => {
    dead = new Error(`app-server exited code=${code} signal=${signal}`);
    for (const p of pending.values()) p.reject(dead);
    pending.clear();
  });
  child.stdin.on("error", () => {});
  const api = {
    child,
    events,
    notifications,
    serverRequests,
    stderr,
    exited,
    onServerRequest(fn) {
      serverRequestHandler = fn;
    },
    request(method, params, timeoutMs = 60_000) {
      if (dead) return Promise.reject(dead);
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (v) => (clearTimeout(timer), resolve(v)),
          reject: (e) => (clearTimeout(timer), reject(e)),
        });
        send({ jsonrpc: "2.0", id, method, params });
      });
    },
    notify(method, params) {
      send({ jsonrpc: "2.0", method, params });
    },
    async init() {
      const r = await api.request("initialize", { clientInfo: { name: "codex-probe", title: "codex probe", version: "0.0.0" } });
      api.notify("initialized", {});
      return r;
    },
    waitFor(pred, timeoutMs = 60_000, label = "condition") {
      const hit = notifications.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          events.off("notification", l);
          reject(new Error(`timeout waiting for ${label}`));
        }, timeoutMs);
        const l = (f) => {
          if (pred(f)) {
            clearTimeout(timer);
            events.off("notification", l);
            resolve(f);
          }
        };
        events.on("notification", l);
      });
    },
    async startThreadAndTurn({ threadParams, turnParams = {}, prompt = "Do the thing.", timeoutMs = 90_000 }) {
      const thread = await api.request("thread/start", threadParams);
      const threadId = thread.thread.id;
      const turn = await api.request("turn/start", { threadId, input: [{ type: "text", text: prompt }], ...turnParams });
      const turnId = turn.turn.id;
      let completed;
      try {
        completed = await api.waitFor(
          (f) => f.method === "turn/completed" && f.params?.turn?.id === turnId,
          timeoutMs,
          "turn/completed"
        );
      } catch (e) {
        completed = { params: { turn: { status: `probe-timeout: ${e.message}` } } };
      }
      return { thread, threadId, turnId, completed: completed.params.turn };
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.stdin.end();
      } catch {}
      child.kill("SIGTERM");
      const t = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(t);
    },
  };
  return api;
}

export const items = (notifications, type, method = "item/completed") =>
  notifications.filter((n) => n.method === method && (!type || n.params?.item?.type === type)).map((n) => n.params.item);

export const toolNames = (body) =>
  (body?.tools ?? []).map((t) => (t.type === "namespace" ? `${t.name}{${(t.tools ?? []).map((x) => x.name).join(",")}}` : t.name ?? t.type));

/** function_call_output items the client sent back to the model, by call_id. */
export const callOutputs = (requests) => {
  const out = {};
  for (const r of requests) for (const i of r.body?.input ?? []) if (i?.type === "function_call_output" || i?.type === "custom_tool_call_output") out[i.call_id] = i.output;
  return out;
};

export const writeJson = (path, data) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
};

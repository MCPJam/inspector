// A scripted stand-in for the OpenAI Responses API, so the app-server probes
// and the adapter's live tests are deterministic and cost nothing.
//
// WHY THIS EXISTS. Every interesting app-server behaviour (approval requests,
// tool calls, interrupts) is downstream of what the MODEL decides to do. Driving
// that with a real model makes the gates nondeterministic and spends gateway
// budget per run. This server decides instead: a script says "turn 1 calls
// shell, turn 2 answers with text", and the same bytes come back every time.
//
// It also answers the P4 endpoint-inventory gate: every request is logged with
// its method and path, so "does app-server hit anything outside the proxy's
// POST /v1/responses + GET /v1/models allowlist?" is read off the log rather
// than assumed.
//
// The script never invents tool names. A step names a tool, and if the incoming
// request does not DECLARE that tool the server fails the turn loudly — which is
// how we learn Codex's real tool surface instead of guessing at it.
import { createServer } from "node:http";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_USAGE = {
  input_tokens: 1200,
  input_tokens_details: { cached_tokens: 1024 },
  output_tokens: 96,
  output_tokens_details: { reasoning_tokens: 64 },
  total_tokens: 1296,
};

/**
 * @param {object} options
 * @param {Array<{text?: string, reasoning?: string, functionCalls?: Array<{name: string, arguments: unknown, callId?: string}>}>} options.script
 *   One entry per model round-trip. Codex re-POSTs after every tool result, so
 *   entry N is what the model "says" on request N.
 * @param {string} [options.logPath] NDJSON request log (the endpoint inventory).
 * @param {boolean} [options.strictToolNames=true] Fail a step that names a tool
 *   the request did not declare.
 */
export function createFakeResponsesServer({
  script,
  logPath,
  strictToolNames = true,
}) {
  if (logPath) mkdirSync(dirname(logPath), { recursive: true });
  const requests = [];
  let turn = 0;

  const log = (entry) => {
    requests.push(entry);
    if (logPath) appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  };

  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0];
      let parsed;
      try {
        parsed = body ? JSON.parse(body) : undefined;
      } catch {
        parsed = { unparsed: body };
      }
      log({
        t: Date.now(),
        method: req.method,
        path,
        // Presence only. The value is a broker placeholder, but a log that
        // carries credentials is a log nobody can attach to a bug report.
        hasAuthorization: Boolean(req.headers.authorization),
        body: parsed,
      });

      if (req.method === "GET" && path.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [{ id: "gpt-5-nano", object: "model", owned_by: "fake" }],
          }),
        );
        return;
      }

      if (req.method !== "POST" || !path.endsWith("/responses")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `no route for ${path}` } }));
        return;
      }

      const stepIndex = Math.min(turn, script.length - 1);
      const step = script[stepIndex] ?? { text: "done" };
      turn += 1;
      const declared = new Set(
        (parsed?.tools ?? [])
          .map((tool) => tool?.name ?? tool?.function?.name ?? tool?.type)
          .filter(Boolean),
      );
      const missing = (step.functionCalls ?? [])
        .map((call) => call.name)
        .filter((name) => !declared.has(name));
      if (strictToolNames && missing.length) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message:
                `script step ${stepIndex} calls ${missing.join(", ")}, which this ` +
                `request does not declare. Declared: ${[...declared].join(", ") || "(none)"}`,
            },
          }),
        );
        return;
      }

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      streamStep(res, step, turn);
    });
  });

  return {
    server,
    /** Every request seen, in order — the endpoint inventory. */
    requests,
    async listen(port = 0, host = "127.0.0.1") {
      await new Promise((resolve) => server.listen(port, host, resolve));
      const address = server.address();
      return `http://${host}:${address.port}`;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
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
  let outputIndex = 0;

  sse(res, "response.created", {
    response: {
      id: responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "in_progress",
      model: "gpt-5-nano",
      output: [],
    },
  });

  if (step.reasoning) {
    const itemId = `rs_fake_${turn}`;
    const item = {
      id: itemId,
      type: "reasoning",
      summary: [],
      content: [],
      status: "in_progress",
    };
    sse(res, "response.output_item.added", { output_index: outputIndex, item });
    sse(res, "response.reasoning_summary_part.added", {
      item_id: itemId,
      output_index: outputIndex,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    });
    for (const chunk of chunks(step.reasoning)) {
      sse(res, "response.reasoning_summary_text.delta", {
        item_id: itemId,
        output_index: outputIndex,
        summary_index: 0,
        delta: chunk,
      });
    }
    sse(res, "response.reasoning_summary_text.done", {
      item_id: itemId,
      output_index: outputIndex,
      summary_index: 0,
      text: step.reasoning,
    });
    const done = {
      ...item,
      status: "completed",
      summary: [{ type: "summary_text", text: step.reasoning }],
    };
    sse(res, "response.output_item.done", {
      output_index: outputIndex,
      item: done,
    });
    output.push(done);
    outputIndex += 1;
  }

  if (step.text) {
    const itemId = `msg_fake_${turn}`;
    const item = {
      id: itemId,
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: [],
    };
    sse(res, "response.output_item.added", { output_index: outputIndex, item });
    sse(res, "response.content_part.added", {
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    for (const chunk of chunks(step.text)) {
      sse(res, "response.output_text.delta", {
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        delta: chunk,
      });
    }
    sse(res, "response.output_text.done", {
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      text: step.text,
    });
    const content = [{ type: "output_text", text: step.text, annotations: [] }];
    sse(res, "response.content_part.done", {
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part: content[0],
    });
    const done = { ...item, status: "completed", content };
    sse(res, "response.output_item.done", {
      output_index: outputIndex,
      item: done,
    });
    output.push(done);
    outputIndex += 1;
  }

  for (const [callIndex, call] of (step.customToolCalls ?? []).entries()) {
    const itemId = `ctc_fake_${turn}_${callIndex}`;
    const input =
      typeof call.input === "string" ? call.input : JSON.stringify(call.input ?? {});
    const item = {
      id: itemId,
      type: "custom_tool_call",
      status: "in_progress",
      name: call.name,
      call_id: call.callId ?? `call_fake_${turn}_${callIndex}`,
      input: "",
    };
    sse(res, "response.output_item.added", { output_index: outputIndex, item });
    sse(res, "response.custom_tool_call_input.delta", {
      item_id: itemId,
      output_index: outputIndex,
      delta: input,
    });
    sse(res, "response.custom_tool_call_input.done", {
      item_id: itemId,
      output_index: outputIndex,
      input,
    });
    const done = { ...item, status: "completed", input };
    sse(res, "response.output_item.done", { output_index: outputIndex, item: done });
    output.push(done);
    outputIndex += 1;
  }

  for (const [callIndex, call] of (step.functionCalls ?? []).entries()) {
    const itemId = `fc_fake_${turn}_${callIndex}`;
    const args =
      typeof call.arguments === "string"
        ? call.arguments
        : JSON.stringify(call.arguments ?? {});
    const item = {
      id: itemId,
      type: "function_call",
      status: "in_progress",
      name: call.name,
      call_id: call.callId ?? `call_fake_${turn}_${callIndex}`,
      arguments: "",
    };
    sse(res, "response.output_item.added", { output_index: outputIndex, item });
    for (const chunk of chunks(args)) {
      sse(res, "response.function_call_arguments.delta", {
        item_id: itemId,
        output_index: outputIndex,
        delta: chunk,
      });
    }
    sse(res, "response.function_call_arguments.done", {
      item_id: itemId,
      output_index: outputIndex,
      arguments: args,
    });
    const done = { ...item, status: "completed", arguments: args };
    sse(res, "response.output_item.done", {
      output_index: outputIndex,
      item: done,
    });
    output.push(done);
    outputIndex += 1;
  }

  sse(res, "response.completed", {
    response: {
      id: responseId,
      object: "response",
      status: "completed",
      model: "gpt-5-nano",
      output,
      usage: DEFAULT_USAGE,
    },
  });
  res.end();
}

/** Split into a few deltas so streaming assembly is exercised, not bypassed. */
function chunks(text, size = 24) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [text];
}

// CLI: `node fake-responses-server.mjs <script.json> [port]`
if (import.meta.url === `file://${process.argv[1]}`) {
  const [scriptPath, port = "0"] = process.argv.slice(2);
  const script = scriptPath
    ? JSON.parse(readFileSync(scriptPath, "utf8"))
    : [{ text: "Hello from the fake Responses server." }];
  const fake = createFakeResponsesServer({
    script: Array.isArray(script) ? script : script.steps,
    logPath: process.env.FAKE_RESPONSES_LOG,
  });
  fake.listen(Number(port)).then((url) => {
    process.stdout.write(`${url}\n`);
  });
}

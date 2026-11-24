#!/usr/bin/env node
/**
 * Production traffic smoke test (PT-1).
 *
 * Sends synthetic OTLP/JSON traffic to an MCPJam Inspector with a project's
 * producer credential, then reads it back as a separate project member and
 * checks the counts, the refusals and the outcome ordering. Repeatable: each
 * run uses its own `service.name`, and drops are compared with a baseline.
 *
 *   MCPJAM_PRODUCER_TOKEN=mjotlp_... MCPJAM_READER_TOKEN=<member bearer> \
 *     npm run production-traffic:smoke -w @mcpjam/inspector -- \
 *       --url https://<inspector origin> --project <projectId> [--python <python>]
 *
 * MCPJAM_READER_TOKEN falls back to MCPJAM_API_KEY. `--python` also sends a
 * gzip protobuf export through the official OpenTelemetry exporter
 * (otlp_export.py). Neither token is ever printed. Prints a JSON report and
 * exits 0 only when every check passes.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    url: { type: "string" },
    project: { type: "string" },
    "run-id": { type: "string" },
    python: { type: "string" },
  },
});
const producer = process.env.MCPJAM_PRODUCER_TOKEN ?? "";
const reader =
  process.env.MCPJAM_READER_TOKEN || process.env.MCPJAM_API_KEY || "";
if (!args.url || !args.project || !producer || !reader) {
  console.error(
    "Usage: MCPJAM_PRODUCER_TOKEN=mjotlp_... MCPJAM_READER_TOKEN=<member bearer> production-traffic:smoke --url <origin> --project <projectId> [--python <python>]",
  );
  process.exit(2);
}
const origin = new URL(args.url).origin;
const project = args.project;
const runId = args["run-id"] ?? randomBytes(4).toString("hex");
const serviceName = `pt-smoke-${runId}`;
const endpoint = (id) => `${origin}/api/v1/projects/${id}/otlp/v1/traces`;

const hex = (bytes) => randomBytes(bytes).toString("hex");
const nowNs = () => BigInt(Date.now()) * 1_000_000n;
const ids = () => ({ traceId: hex(16), spanId: hex(8) });
const attr = (key, value) =>
  typeof value === "number"
    ? { key, value: { intValue: String(value) } }
    : { key, value: { stringValue: value } };

function call(span, toolName, extra = []) {
  const start = nowNs() - 3_000_000_000n;
  return {
    ...span,
    name: `tools/call ${toolName ?? "unknown"}`,
    kind: 2,
    startTimeUnixNano: String(start),
    endTimeUnixNano: String(start + 25_000_000n),
    attributes: [
      attr("mcp.method.name", "tools/call"),
      ...(toolName ? [attr("gen_ai.tool.name", toolName)] : []),
      attr("mcp.client.name", "pt-smoke"),
      ...extra,
    ],
  };
}
function outcome(of, status, endNs, spanId = hex(8)) {
  return {
    traceId: of.traceId,
    spanId,
    parentSpanId: of.spanId,
    name: "mcpjam.outcome",
    kind: 1,
    startTimeUnixNano: String(endNs - 1_000_000n),
    endTimeUnixNano: String(endNs),
    attributes: [
      attr("mcpjam.outcome.name", "refund_committed"),
      attr("mcpjam.outcome.status", status),
    ],
  };
}
const resource = (environment) => ({
  attributes: [
    attr("service.name", serviceName),
    attr("service.version", "smoke-1"),
    attr("deployment.environment.name", environment),
  ],
});
const batch = (spans, staging = []) =>
  JSON.stringify({
    resourceSpans: [
      { resource: resource("production"), scopeSpans: [{ spans }] },
      ...(staging.length
        ? [{ resource: resource("staging"), scopeSpans: [{ spans: staging }] }]
        : []),
    ],
  });

/** The parsed JSON body, or the start of a body that is not JSON. */
async function bodyOf(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { notJson: text.slice(0, 200) };
  }
}

async function post(body, { token = producer, id = project } = {}) {
  const response = await fetch(endpoint(id), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body,
  });
  return {
    status: response.status,
    body: await bodyOf(response),
  };
}
async function read(path, query = {}, token = reader) {
  const response = await fetch(
    `${origin}/api/v1/projects/${project}/production/${path}?${new URLSearchParams(query)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return {
    status: response.status,
    body: await bodyOf(response),
  };
}

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), ...(ok ? {} : { detail }) });
};
const window = () => ({
  from: String(Date.now() - 3_600_000),
  to: String(Date.now() + 60_000),
});

// The drop counters are per project and day, so compare with a baseline.
const baseline = await read("counts", window());
check("reader can read counts", baseline.status === 200, baseline.body);
const dropsBefore = baseline.body?.dropped?.missing_tool_name ?? 0;

const refund = ids();
const protocolError = ids();
const toolError = ids();
const rejected = ids();
const late = ids();
const tied = ids();
const t = nowNs() - 1_000_000_000n;
const first = batch(
  [
    call(refund, "refund_order"),
    outcome(refund, "not_met", t),
    call(protocolError, "get_order", [attr("error.type", "-32603")]),
    call(toolError, "refund_order", [attr("error.type", "tool_error")]),
    call(rejected, "get_order", [attr("rpc.response.status_code", -32602)]),
    call(ids(), null),
  ],
  [call(ids(), "get_order")],
);
for (const attempt of ["first send", "identical resend"]) {
  const sent = await post(first);
  check(
    `${attempt}: accepted with one span rejected`,
    sent.status === 200 && sent.body?.partialSuccess?.rejectedSpans === "1",
    sent,
  );
}
// An outcome before its call, a newer report, then an older one retried; and
// two reports with the same end time, where the greater span id wins.
for (const spans of [
  [outcome(late, "met", t + 2_000_000n)],
  [call(late, "refund_order"), call(tied, "refund_order")],
  [outcome(late, "not_met", t + 1_000_000n)],
  [
    outcome(tied, "met", t, "00000000000000aa"),
    outcome(tied, "not_met", t, "00000000000000ff"),
  ],
]) {
  const sent = await post(batch(spans));
  check("outcome ordering batch accepted", sent.status === 200, sent);
}

const otherProject = `${hex(16)}`;
const wrongProject = await post(batch([call(ids(), "get_order")]), {
  id: otherProject,
});
check(
  "producer credential refused for another project",
  [403, 404].includes(wrongProject.status),
  wrongProject,
);
const missing = await post(batch([call(ids(), "get_order")]), { token: "" });
check("missing credential refused", missing.status === 401, missing);
const writerRead = await read("counts", window(), producer);
check(
  "producer credential cannot read",
  [401, 403].includes(writerRead.status),
  { status: writerRead.status },
);

let python = null;
if (args.python) {
  const exporter = fileURLToPath(new URL("./otlp_export.py", import.meta.url));
  python = await new Promise((done) => {
    const child = spawn(
      args.python,
      [
        exporter,
        "--endpoint",
        endpoint(project),
        "--service-name",
        `${serviceName}-py`,
        "--gzip",
      ],
      { env: { ...process.env, MCPJAM_PRODUCER_TOKEN: producer } },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("close", (status) =>
      done({ status, sent: stdout.trim().split("\n").pop() }),
    );
  });
  check("python protobuf export succeeded", python.status === 0, python);
}

// Reads may trail writes on a replicated database; give them a few seconds.
const expected = { received: 6, evaluated: 3, unmeasured: 3 };
let counts;
for (let attempt = 0; attempt < 10; attempt += 1) {
  counts = await read("counts", { ...window(), serviceName });
  if (counts.body?.received === expected.received) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
const c = counts.body ?? {};
check(
  "counts match",
  c.received === 6 && c.evaluated === 3 && c.unmeasured === 3,
  c,
);
check(
  "review flags match",
  c.flagged?.protocol_error === 1 &&
    c.flagged?.rejected_request === 1 &&
    c.flagged?.tool_error === 1 &&
    c.flagged?.outcome_not_met === 2,
  c.flagged,
);
const totals = await read("counts", window());
const dropDelta = (totals.body?.dropped?.missing_tool_name ?? 0) - dropsBefore;
check("one refused span counted once across the resend", dropDelta === 1, {
  dropDelta,
});

const calls = await read("calls", { ...window(), serviceName, limit: "50" });
const outcomeOf = (span) =>
  calls.body?.items?.find(
    (item) => item.ref === `${span.traceId}:${span.spanId}`,
  )?.outcomes?.[0]?.status;
check(
  "refund outcome reads not_met",
  outcomeOf(refund) === "not_met",
  calls.body,
);
check(
  "outcome sent before its call, retried late, reads met",
  outcomeOf(late) === "met",
  calls.body,
);
check(
  "tied outcomes resolve to the greater span id",
  outcomeOf(tied) === "not_met",
  calls.body,
);
if (python?.status === 0) {
  const pyCalls = await read("calls", {
    ...window(),
    serviceName: `${serviceName}-py`,
  });
  check(
    "python export is readable",
    pyCalls.body?.items?.length === 1,
    pyCalls.body,
  );
}

const passed = checks.every((item) => item.ok);
console.log(
  JSON.stringify(
    { target: origin, project, runId, serviceName, passed, counts: c, checks },
    null,
    2,
  ),
);
process.exit(passed ? 0 : 1);

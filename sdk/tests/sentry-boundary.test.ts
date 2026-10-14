import { NodeClient, Scope, defaultStackParser } from "@sentry/node";
import { fileURLToPath } from "node:url";
import { sdkDiagnosticBoundary } from "../src/internal/sentry-boundary";

const original = { DO_NOT_TRACK: process.env.DO_NOT_TRACK, MCPJAM_TELEMETRY_DISABLED: process.env.MCPJAM_TELEMETRY_DISABLED };
beforeEach(() => {
  delete process.env.DO_NOT_TRACK;
  delete process.env.MCPJAM_TELEMETRY_DISABLED;
});
afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

it("reconstructs real SDK capture and direct-send envelopes at the only final serializer", async () => {
  const sent: unknown[] = [];
  const client = new NodeClient({
    dsn: "https://public@example.ingest.sentry.io/123",
    integrations: [], stackParser: defaultStackParser,
    transport: () => sdkDiagnosticBoundary("@mcpjam/sdk@1.2.3")({
      send: async (envelope) => { sent.push(envelope); return {}; },
      flush: async () => true,
    }),
  });
  client.init();
  const scope = new Scope();
  scope.setClient(client);
  scope.setExtra("request", "PRIVATE_SENTINEL");
  const error = new TypeError("PRIVATE_SENTINEL");
  error.stack = `TypeError: PRIVATE_SENTINEL\n    at PRIVATE_SENTINEL (${fileURLToPath(new URL("../src/sentry.ts", import.meta.url))}:10:4)\n    at malicious (/customers/PRIVATE_SENTINEL.ts:1:1)`;
  scope.captureException(error);
  await client.flush(1000);
  client.sendEvent({ message: "PRIVATE_SENTINEL", extra: { content: "PRIVATE_SENTINEL" } }, { attachments: [{ filename: "PRIVATE_SENTINEL", data: "PRIVATE_SENTINEL" }] });
  await client.flush(1000);
  expect(sent).toHaveLength(2);
  expect(JSON.stringify(sent)).toContain('"type":"TypeError"');
  expect(JSON.stringify(sent)).toContain('"filename":"src/sentry.ts"');
  expect(JSON.stringify(sent)).toContain('"lineno":10');
  expect(JSON.stringify(sent)).not.toContain("PRIVATE_SENTINEL");
  expect(JSON.stringify(sent)).not.toContain('"function"');
  await client.close(1000);
});

it.each(["DO_NOT_TRACK", "MCPJAM_TELEMETRY_DISABLED"])("rechecks late %s opt-out for queued errors and transactions", async (key) => {
  const sent: unknown[] = [];
  const transport = sdkDiagnosticBoundary("@mcpjam/sdk@1.2.3")({ send: async (value) => { sent.push(value); return {}; }, flush: async () => true });
  const envelope = () => [{}, [[{ type: "event" }, { message: "PRIVATE_SENTINEL" }], [{ type: "transaction" }, { transaction: "PRIVATE_SENTINEL" }], [{ type: "attachment" }, "PRIVATE_SENTINEL"]]];
  await transport.send(envelope() as never);
  expect(sent).toHaveLength(1);
  expect(JSON.stringify(sent)).not.toContain("PRIVATE_SENTINEL");
  for (const value of ["1", "true"]) {
    process.env[key] = value;
    await transport.send(envelope() as never);
  }
  expect(sent).toHaveLength(1);
});

it("never coerces customer basenames or invalid line values into verified locations", async () => {
  const sent: unknown[] = [];
  const transport = sdkDiagnosticBoundary("@mcpjam/sdk@1.2.3")({ send: async (value) => { sent.push(value); return {}; }, flush: async () => true });
  const frames = [
    { filename: "/customer/src/sentry.ts", lineno: 1 },
    { filename: "src/sentry.ts", lineno: "PRIVATE_SENTINEL" },
    { filename: "src/sentry.ts", lineno: 1.5 },
    { filename: "src/sentry.ts", lineno: 0 },
    { filename: "src/sentry.ts", lineno: 10, function: "PRIVATE_SENTINEL", vars: { data: "PRIVATE_SENTINEL" } },
  ];
  await transport.send([{}, [[{ type: "event" }, { exception: { values: [{ type: "Error", stacktrace: { frames } }] } }]]] as never);
  expect(JSON.stringify(sent)).not.toContain("PRIVATE_SENTINEL");
  expect(JSON.stringify(sent)).toContain('"dropped_frames":4');
  expect(JSON.stringify(sent)).toContain('"filename":"src/sentry.ts","in_app":true,"lineno":10');
});

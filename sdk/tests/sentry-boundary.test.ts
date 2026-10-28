import { NodeClient, Scope, defaultStackParser } from "@sentry/node";
import { fileURLToPath } from "node:url";
import {
  sdkDiagnosticBoundary,
  sdkFrameAliases,
} from "../src/internal/sentry-boundary";
import { rebuildSentryEvent } from "../src/internal/telemetry.js";

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

it("aliases every Windows spelling of a verified SDK file and no same-named customer file", () => {
  const aliases = sdkFrameAliases(
    "C:\\Program Files\\app\\node_modules\\@mcpjam\\sdk",
    ["dist/index.js"],
    true
  );
  expect(aliases).toEqual({
    "C:\\Program Files\\app\\node_modules\\@mcpjam\\sdk\\dist\\index.js":
      "dist/index.js",
    "C:/Program Files/app/node_modules/@mcpjam/sdk/dist/index.js":
      "dist/index.js",
    "file:///C:/Program%20Files/app/node_modules/@mcpjam/sdk/dist/index.js":
      "dist/index.js",
  });
  // V8 prints an ESM frame as its module URL and a CommonJS frame as a native
  // path; Sentry's parser turns the URL into a decoded forward-slash path.
  const sites = (file: string, line: number) => [
    `    at PRIVATE_SENTINEL (file:///C:/Program%20Files/${file}:${line}:1)`,
    `    at PRIVATE_SENTINEL (C:\\Program Files\\${file.replaceAll("/", "\\")}:${line + 1}:1)`,
  ];
  const parsed = defaultStackParser(
    [
      "Error: PRIVATE_SENTINEL",
      ...sites("app/node_modules/@mcpjam/sdk/dist/index.js", 10),
      ...sites("app/dist/index.js", 20),
      ...sites("other/node_modules/@mcpjam/sdk/dist/index.js", 30),
    ].join("\n")
  );
  const frames = [
    ...parsed,
    {
      filename:
        "file:///C:/Program%20Files/app/node_modules/@mcpjam/sdk/dist/index.js",
      lineno: 12,
    },
    { filename: "file:///C:/Program%20Files/app/dist/index.js", lineno: 22 },
  ];
  const event = rebuildSentryEvent(
    { exception: { values: [{ type: "Error", stacktrace: { frames } }] } },
    { files: ["dist/index.js"], frameAliases: aliases }
  );
  expect(event).toMatchObject({
    extra: { dropped_frames: 5 },
    exception: {
      values: [
        {
          stacktrace: {
            frames: [11, 10, 12].map((lineno) => ({
              filename: "dist/index.js",
              lineno,
            })),
          },
        },
      ],
    },
  });
  expect(JSON.stringify(event)).not.toMatch(
    /PRIVATE_SENTINEL|Program|app\/|other/
  );
});

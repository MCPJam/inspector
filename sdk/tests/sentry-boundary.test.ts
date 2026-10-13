import { NodeClient, Scope, defaultStackParser } from "@sentry/node";
import { fileURLToPath } from "node:url";
import { sdkDiagnosticBoundary } from "../src/internal/sentry-boundary";

const original = {
  DO_NOT_TRACK: process.env.DO_NOT_TRACK,
  MCPJAM_TELEMETRY_DISABLED: process.env.MCPJAM_TELEMETRY_DISABLED,
};
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

it("reconstructs actual SDK errors at the final transport and keeps safe frames", async () => {
  const sent: unknown[] = [];
  const boundary = sdkDiagnosticBoundary("@mcpjam/sdk@1.2.3");
  const client = new NodeClient({
    ...boundary.hooks,
    dsn: "https://public@example.ingest.sentry.io/123",
    integrations: [],
    stackParser: defaultStackParser,
    transport: () => ({
      send: async (envelope) => {
        sent.push(envelope);
        return {};
      },
      flush: async () => true,
    }),
  });
  client.on("beforeEnvelope", boundary.envelope);
  client.init();
  const scope = new Scope();
  scope.setClient(client);
  scope.setExtra("request", "PRIVATE_SENTINEL");
  const error = new TypeError("PRIVATE_SENTINEL");
  error.stack = `TypeError: PRIVATE_SENTINEL\n    at getApiKeyHash (${fileURLToPath(new URL("../src/sentry.ts", import.meta.url))}:10:4)\n    at malicious (/customers/PRIVATE_SENTINEL.ts:1:1)`;
  scope.captureException(error);
  await client.flush(1000);
  expect(sent).toHaveLength(1);
  expect(JSON.stringify(sent)).toContain('"type":"TypeError"');
  expect(JSON.stringify(sent)).toContain('"filename":"src/sentry.ts"');
  expect(JSON.stringify(sent)).not.toContain("PRIVATE_SENTINEL");
  await client.close(1000);
});

it("drops attachments and transactions queued before DNT changes", () => {
  const boundary = sdkDiagnosticBoundary("@mcpjam/sdk@1.2.3");
  const envelope = {
    0: {},
    1: [
      [{ type: "attachment" }, "PRIVATE_SENTINEL"],
      [
        { type: "transaction" },
        {
          transaction: "PRIVATE_SENTINEL",
          spans: [
            {
              description: "PRIVATE_SENTINEL",
              data: { secret: "PRIVATE_SENTINEL" },
            },
          ],
        },
      ],
    ],
  };
  boundary.envelope(envelope);
  expect(JSON.stringify(envelope)).not.toContain("PRIVATE_SENTINEL");
  expect(envelope[1]).toHaveLength(1);
  process.env.MCPJAM_TELEMETRY_DISABLED = "true";
  boundary.envelope(envelope);
  expect(envelope[1]).toEqual([]);
});

it.each(["1", "true"])(
  "honors DO_NOT_TRACK=%s for every diagnostic family",
  (value) => {
    process.env.DO_NOT_TRACK = value;
    const boundary = sdkDiagnosticBoundary("@mcpjam/sdk@1.2.3");
    expect(boundary.hooks.beforeSend?.({}, { attachments: [] })).toBeNull();
  }
);

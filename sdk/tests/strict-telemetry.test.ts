import { describe, expect, it } from "vitest";
import {
  rebuildSentryBreadcrumb,
  restrictSentryEnvelope,
  rebuildSentryEvent,
  rebuildSentrySpan,
  rebuildSentryTransaction,
} from "../src/internal/telemetry.js";

const secret = "PRIVATE_SENTINEL_customer_content";
const catalog = {
  files: ["server/example.ts"],
  routes: ["/api/items/:id"],
  actorId: "ab5fb35f-4604-4d5b-8724-fd2e69539cbe",
};
const dirty = {
  event_id: "a".repeat(32),
  user: { id: secret, email: secret },
  message: secret,
  request: { url: secret, data: secret },
  contexts: { arbitrary: secret },
  extra: { content: secret },
  tags: { deployment: "hosted", arbitrary: secret },
  attachments: [secret],
  exception: {
    values: [
      {
        type: "TypeError",
        value: secret,
        stacktrace: {
          frames: [
            {
              filename: "server/example.ts",
              function: "handle",
              lineno: 10,
              vars: { secret },
              pre_context: [secret],
            },
            {
              filename: `/home/${secret}/server/example.ts`,
              function: "handle",
              in_app: true,
            },
            { filename: "server/example.ts", function: secret },
          ],
        },
      },
      { type: secret, value: secret },
    ],
  },
  breadcrumbs: [
    { category: "http", type: "http", message: secret, data: { secret } },
  ],
};

describe("strict telemetry reconstruction", () => {
  it("accepts only exact trusted frame aliases and drops non-diagnostic envelope families", () => {
    const event = {
      exception: {
        values: [
          {
            type: "Error",
            stacktrace: {
              frames: [
                { filename: "/trusted/server/example.ts", function: secret, lineno: 7 },
              ],
            },
          },
        ],
      },
    };
    const options = {
      ...catalog,
      frameAliases: { "/trusted/server/example.ts": "server/example.ts" },
    };
    const result = rebuildSentryEvent(event, options);
    expect(JSON.stringify(result)).toContain('"filename":"server/example.ts"');
    expect(JSON.stringify(result)).not.toContain("/trusted/");
    const envelope: [object, unknown[]] = [
      { trace: { secret } },
      [
        [{ type: "event" }, dirty],
        [{ type: "transaction" }, { transaction: secret }],
        ...[
          "attachment",
          "replay_event",
          "replay_recording",
          "profile",
          "session",
          "log",
        ].map((type) => [{ type }, secret]),
      ],
    ];
    restrictSentryEnvelope(envelope, options);
    expect(envelope[0]).toMatchObject({ event_id: "a".repeat(32), sent_at: expect.any(String) });
    expect(envelope[1]).toHaveLength(1);
    expect(JSON.stringify(envelope)).not.toContain(secret);
  });
  it("rebuilds exception chains without mutating the source or retaining unknown fields", () => {
    const output = rebuildSentryEvent(dirty, catalog);
    expect(JSON.stringify(output)).not.toContain(secret);
    expect(dirty.message).toBe(secret);
    expect(output).toMatchObject({
      user: { id: catalog.actorId },
      tags: { deployment: "hosted" },
      extra: { dropped_frames: 2 },
      exception: {
        values: [
          {
            type: "TypeError",
            value: "TypeError",
            stacktrace: {
              frames: [
                {
                  filename: "server/example.ts",
                  lineno: 10,
                  in_app: true,
                },
              ],
            },
          },
          { type: "UnknownError", value: "UnknownError" },
        ],
      },
      breadcrumbs: [{ category: "http", type: "http" }],
    });
    expect(rebuildSentryEvent(dirty)).not.toHaveProperty("user");

  });
  it("rebuilds transactions and child spans separately", () => {
    const span = {
      description: secret,
      data: { secret },
      tags: { secret },
      op: "http.client",
      trace_id: "a".repeat(32),
      span_id: "b".repeat(16),
      start_timestamp: 3,
      timestamp: 4,
    };
    const output = rebuildSentryTransaction(
      {
        ...dirty,
        type: "transaction",
        transaction: secret,
        start_timestamp: 3,
        timestamp: 4,
        spans: [span],
      },
      catalog
    );
    expect(JSON.stringify(output)).not.toContain(secret);
    expect(output.transaction).toBe("unknown_operation");
    expect(
      rebuildSentrySpan({ ...span, description: "/api/items/:id" }, catalog)
    ).toMatchObject({ description: "/api/items/:id", data: {} });
    expect(rebuildSentryBreadcrumb({ message: secret })).toBeNull();
  });
});

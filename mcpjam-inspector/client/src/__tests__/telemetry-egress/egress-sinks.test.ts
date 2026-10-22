import { expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import {
  scanAll,
  sinkOf,
  sentinel,
  EgressDecodeError,
  decodeSentryEnvelope,
} from "../../../../e2e/telemetry/egress";

it("finds sentinel content in compressed Axiom NDJSON and preserves a clean positive control", () => {
  const body = gzipSync(
    Buffer.from(
      [
        JSON.stringify({ event: "request_completed", duration_ms: 2 }),
        JSON.stringify({ extra: sentinel("axiom") }),
      ].join("\n"),
    ),
  );
  const { decoded, hits } = scanAll([
    { url: "https://api.axiom.co/v1/datasets/test/ingest", method: "POST", transport: "fetch", headers: {}, body },
  ]);
  expect(decoded).toHaveLength(1);
  expect(decoded[0].axiom).toMatchObject([
    { event: "request_completed", duration_ms: 2 },
    {},
  ]);
  expect(hits).toContainEqual(
    expect.objectContaining({
      sink: "axiom",
      where: expect.stringContaining("extra"),
    }),
  );
  expect(sinkOf("https://api.axiom.co.evil.example/ingest")).toBe("other");
});

it("scans every Sentry envelope item type and envelope metadata", () => {
  const types = [
    "event",
    "transaction",
    "span",
    "attachment",
    "profile",
    "log",
    "replay_event",
    "unknown",
  ];
  const payload = JSON.stringify({ content: sentinel("envelope") });
  const body = Buffer.from(
    [
      JSON.stringify({ trace: sentinel("header") }),
      ...types.flatMap((type) => [
        JSON.stringify({ type, length: Buffer.byteLength(payload) }),
        payload,
      ]),
    ].join("\n"),
  );
  const { decoded, hits } = scanAll([
    {
      url: "https://o1.ingest.us.sentry.io/api/1/envelope/",
      method: "POST", transport: "fetch", headers: {},
      body,
    },
  ]);
  expect(decoded[0].sentry?.items.map((item) => item.header.type)).toEqual(
    types,
  );
  expect(hits.length).toBeGreaterThanOrEqual(types.length + 1);
});

it("fails closed on corrupt compressed data and truncated Sentry items", () => {
  expect(() =>
    scanAll([
      {
        url: "https://api.axiom.co/v1/datasets/test/ingest",
        method: "POST", transport: "fetch", headers: {},
        body: new Uint8Array([0x1f, 0x8b]),
      },
    ]),
  ).toThrow(EgressDecodeError);
  expect(() =>
    decodeSentryEnvelope(Buffer.from('{}\n{"type":"event","length":999}\n{}')),
  ).toThrow(EgressDecodeError);
});

import { describe, expect, it } from "vitest";
import { decodeOtlpTraces } from "../otlp-decode.js";
import {
  ExportTraceServiceRequest,
  ExportTraceServiceResponse,
} from "../otlp-proto.js";
import { encodeExportResponse, formatOf, inflate } from "../otlp-receiver.js";
import {
  hashProducerToken,
  PRODUCER_TOKEN_PATTERN,
} from "../producer-verifier.js";
import { mapTraceBatch } from "../span-mapping.js";
import { gzipSync } from "node:zlib";

const TRACE = "5b8efff798038103d269b633813fc60c";
const CALL = "eee19b7ec3c1b174";
const OUTCOME = "eee19b7ec3c1b175";
const START = 1_763_618_400_000_000_000n;

const kv = (key: string, value: string | number) =>
  typeof value === "number"
    ? { key, value: { intValue: String(value) } }
    : { key, value: { stringValue: value } };

function request(
  spans: unknown[],
  resource = [kv("service.name", "orders-lab")],
) {
  return {
    resourceSpans: [
      { resource: { attributes: resource }, scopeSpans: [{ spans }] },
    ],
  };
}

function call(
  extra: object = {},
  attributes = [kv("gen_ai.tool.name", "refund_order")],
) {
  return {
    traceId: TRACE,
    spanId: CALL,
    name: "tools/call refund_order",
    kind: 2,
    startTimeUnixNano: String(START),
    endTimeUnixNano: String(START + 1_000_000n),
    attributes: [
      kv("mcp.method.name", "tools/call"),
      kv("rpc.response.status_code", -32602),
      kv("gen_ai.tool.call.arguments", '{"order_id":"1042"}'),
      kv("customer.email", "fictional@example.com"),
      ...attributes,
    ],
    ...extra,
  };
}

function outcome(extra: object = {}, status = "not_met") {
  return {
    traceId: TRACE,
    spanId: OUTCOME,
    parentSpanId: CALL,
    name: "mcpjam.outcome",
    kind: 1,
    startTimeUnixNano: String(START + 2_000_000n),
    endTimeUnixNano: String(START + 3_000_000n),
    attributes: [
      kv("mcpjam.outcome.name", "refund_committed"),
      kv("mcpjam.outcome.status", status),
    ],
    ...extra,
  };
}

const map = (body: object, storeContent = false) =>
  mapTraceBatch(
    decodeOtlpTraces(new TextEncoder().encode(JSON.stringify(body)), "json"),
    {
      policy: { storeContent },
      batchDigest: "digest",
      receivedAt: new Date("2026-11-20T08:00:00Z"),
    },
  );

describe("producer credential contract", () => {
  it("hashes exactly as the backend does (same test vector)", () => {
    const token = `mjotlp_${"A".repeat(43)}`;
    expect(PRODUCER_TOKEN_PATTERN.test(token)).toBe(true);
    expect(hashProducerToken(token)).toBe(
      "gGTD0tEiMht4iJWBiku5XXYyYMHrLk5VxfPqUySPXTM",
    );
  });
});

describe("mapTraceBatch", () => {
  it("keeps the contract's attributes and drops content under a metadata-only policy", () => {
    const batch = map(request([call(), outcome()]));
    expect(batch.calls).toEqual([
      expect.objectContaining({
        traceId: TRACE,
        spanId: CALL,
        toolName: "refund_order",
        serviceName: "orders-lab",
        deploymentEnvironment: "production",
        rpcStatusCode: "-32602",
        arguments: null,
        result: null,
      }),
    ]);
    expect(
      JSON.stringify(batch, (_k, v) => (typeof v === "bigint" ? `${v}` : v)),
    ).not.toContain("fictional@example.com");
    expect(batch.outcomes).toEqual([
      expect.objectContaining({
        callTraceId: TRACE,
        callSpanId: CALL,
        outcomeStatus: "not_met",
        outcomeEndTimeUnixNano: START + 3_000_000n,
      }),
    ]);
    expect(batch.rejectedSpans).toBe(0);
  });

  it("stores arguments only when the policy stores content", () => {
    expect(map(request([call()]), true).calls[0]?.arguments).toBe(
      '{"order_id":"1042"}',
    );
  });

  it("attaches an outcome through a span link when it has no parent", () => {
    const linked = outcome({
      parentSpanId: "",
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      links: [{ traceId: TRACE, spanId: CALL }],
    });
    expect(map(request([linked])).outcomes[0]).toMatchObject({
      callTraceId: TRACE,
      callSpanId: CALL,
    });
  });

  it("rejects spans that break the contract, counts them, and ignores other methods", () => {
    const batch = map(
      request([
        call({}, []),
        call({ spanId: "0000000000000000" }),
        outcome({ parentSpanId: "" }),
        outcome({}, "maybe"),
        call({ kind: 3 }),
        { ...call(), attributes: [kv("mcp.method.name", "tools/list")] },
      ]),
    );
    expect(batch.calls).toEqual([]);
    expect(
      Object.fromEntries(batch.drops.map((d) => [d.reason, d.count])),
    ).toEqual({
      missing_tool_name: 1,
      invalid_span: 1,
      outcome_without_call: 1,
      invalid_outcome: 1,
    });
    expect(batch.drops[0]).toMatchObject({
      batchDigest: "digest",
      day: "2026-11-20",
    });
    expect(batch.rejectionSummary).toMatch(/^Rejected 4 span\(s\)/);
  });

  it("rejects a time ClickHouse can't store and keeps the rest of the batch", () => {
    const latestStorable = 2n ** 63n - 1n;
    const batch = map(
      request([
        call(),
        call({
          spanId: "eee19b7ec3c1b176",
          endTimeUnixNano: String(latestStorable),
        }),
        call({
          spanId: "eee19b7ec3c1b177",
          endTimeUnixNano: String(latestStorable + 1n),
        }),
        outcome({ endTimeUnixNano: String(10n ** 30n) }),
      ]),
    );
    expect(batch.calls.map((row) => row.spanId)).toEqual([
      CALL,
      "eee19b7ec3c1b176",
    ]);
    expect(batch.outcomes).toEqual([]);
    expect(
      Object.fromEntries(batch.drops.map((d) => [d.reason, d.count])),
    ).toEqual({ invalid_span: 1, invalid_outcome: 1 });
  });

  it("reads the environment a test copy reports", () => {
    const staging = request(
      [call()],
      [
        kv("service.name", "orders-lab"),
        kv("deployment.environment.name", "staging"),
      ],
    );
    expect(map(staging).calls[0]?.deploymentEnvironment).toBe("staging");
  });
});

describe("decoding both encodings", () => {
  it("reads protobuf ids and times exactly as the JSON form", () => {
    const json = request([call(), outcome()]);
    const bytes = (hexId: string) => Buffer.from(hexId, "hex");
    const proto = ExportTraceServiceRequest.encode(
      ExportTraceServiceRequest.fromObject(
        request([
          { ...call(), traceId: bytes(TRACE), spanId: bytes(CALL) },
          {
            ...outcome(),
            traceId: bytes(TRACE),
            spanId: bytes(OUTCOME),
            parentSpanId: bytes(CALL),
          },
        ]),
      ),
    ).finish();
    const fromJson = decodeOtlpTraces(
      new TextEncoder().encode(JSON.stringify(json)),
      "json",
    );
    expect(decodeOtlpTraces(proto, "protobuf")).toEqual(fromJson);
  });

  it("rejects a body that is not an export", () => {
    expect(() =>
      decodeOtlpTraces(new TextEncoder().encode("not json"), "json"),
    ).toThrow(/not valid UTF-8 JSON/);
  });
});

describe("receiver plumbing", () => {
  it("accepts the two OTLP media types, with parameters", () => {
    expect(formatOf("application/x-protobuf")).toBe("protobuf");
    expect(formatOf("application/json; charset=utf-8")).toBe("json");
    expect(formatOf("text/plain")).toBeNull();
  });

  it("inflates gzip and refuses other encodings", async () => {
    const body = new TextEncoder().encode("{}");
    expect(Buffer.from(await inflate(gzipSync(body), "gzip")).toString()).toBe(
      "{}",
    );
    await expect(inflate(body, "br")).rejects.toMatchObject({ status: 415 });
  });

  it("writes partial success in the request's encoding", () => {
    const json = encodeExportResponse("json", 2, "Rejected 2 span(s)");
    expect(JSON.parse(String(json.body))).toEqual({
      partialSuccess: {
        rejectedSpans: "2",
        errorMessage: "Rejected 2 span(s)",
      },
    });
    const proto = encodeExportResponse("protobuf", 2, "Rejected 2 span(s)");
    const decoded = ExportTraceServiceResponse.toObject(
      ExportTraceServiceResponse.decode(proto.body as Uint8Array),
      { longs: Number },
    );
    expect(decoded).toEqual({
      partialSuccess: { rejectedSpans: 2, errorMessage: "Rejected 2 span(s)" },
    });
    expect(encodeExportResponse("json", 0, null).body).toBe("{}");
  });
});

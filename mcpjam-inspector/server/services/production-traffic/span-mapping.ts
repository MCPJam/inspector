/**
 * Decoded spans → the rows the store keeps, under the PT-1 span contract
 * (engineering spec E8).
 *
 * - A call is a SERVER span with `mcp.method.name = tools/call` and a
 *   `gen_ai.tool.name`.
 * - An outcome is an `mcpjam.outcome` span naming an outcome and `met` or
 *   `not_met`, attached to its call as a child or through a span link.
 *
 * Only the attributes read below are kept, so content in a custom attribute
 * never reaches storage. Arguments and results are kept only under a policy
 * that stores content. Spans of other methods are accepted and ignored; spans
 * that claim to be a call or an outcome but break the contract are rejected,
 * counted per reason and reported back as OTLP partial success.
 */
import type { CallRow, DropRow, OutcomeRow, TrafficBatch } from "./store.js";
import type {
  AttributeValue,
  NormalizedResourceSpans,
  NormalizedSpan,
} from "./otlp-decode.js";

export type CapturePolicy = { storeContent: boolean };

export type MappedBatch = TrafficBatch & {
  rejectedSpans: number;
  /** OTLP partial-success message, or null when nothing was rejected. */
  rejectionSummary: string | null;
};

type RejectReason =
  | "invalid_span"
  | "missing_tool_name"
  | "invalid_outcome"
  | "outcome_without_call";

const SPAN_KIND_SERVER = 2;
const OUTCOME_SPAN_NAME = "mcpjam.outcome";
const OUTCOME_NAME = /^[a-z][a-z0-9_.]{0,63}$/;
const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const MAX_FIELD_LENGTH = 256;

const isId = (id: string, pattern: RegExp) =>
  pattern.test(id) && /[1-9a-f]/.test(id);

function text(
  attributes: Map<string, AttributeValue>,
  ...keys: string[]
): string {
  for (const key of keys) {
    const value = attributes.get(key);
    if (value !== undefined && value !== "") {
      return String(value).slice(0, MAX_FIELD_LENGTH);
    }
  }
  return "";
}

function content(
  attributes: Map<string, AttributeValue>,
  key: string,
  policy: CapturePolicy,
): string | null {
  if (!policy.storeContent) return null;
  const value = attributes.get(key);
  return value === undefined ? null : String(value);
}

// OTLP times are unsigned 64-bit, and the JSON encoding can carry larger ones,
// but DateTime64(9) stores nanoseconds as a signed Int64. A later time can't be
// stored, and one that reached the insert could fail the whole batch, which
// the exporter would then resend forever.
const LATEST_STORABLE_UNIX_NANO = 2n ** 63n - 1n;

function validTiming(span: NormalizedSpan): boolean {
  return (
    span.startTimeUnixNano > 0n &&
    span.endTimeUnixNano >= span.startTimeUnixNano &&
    span.endTimeUnixNano <= LATEST_STORABLE_UNIX_NANO
  );
}

export function mapTraceBatch(
  resourceSpans: NormalizedResourceSpans[],
  options: { policy: CapturePolicy; batchDigest: string; receivedAt: Date },
): MappedBatch {
  const calls: CallRow[] = [];
  const outcomes: OutcomeRow[] = [];
  const rejected = new Map<RejectReason, number>();
  const reject = (reason: RejectReason) =>
    rejected.set(reason, (rejected.get(reason) ?? 0) + 1);

  for (const { resource, spans } of resourceSpans) {
    const serviceName = text(resource, "service.name");
    const serviceVersion = text(resource, "service.version");
    // A server that names no environment is treated as production; test
    // copies are told to report theirs (`staging`) so they stay out of counts.
    const deploymentEnvironment =
      text(resource, "deployment.environment.name", "deployment.environment") ||
      "production";

    for (const span of spans) {
      const attrs = span.attributes;
      if (span.name === OUTCOME_SPAN_NAME) {
        const outcomeName = text(attrs, "mcpjam.outcome.name");
        const status = text(attrs, "mcpjam.outcome.status");
        if (
          !isId(span.traceId, TRACE_ID) ||
          !isId(span.spanId, SPAN_ID) ||
          !validTiming(span) ||
          !OUTCOME_NAME.test(outcomeName) ||
          (status !== "met" && status !== "not_met")
        ) {
          reject("invalid_outcome");
          continue;
        }
        const parent = isId(span.parentSpanId, SPAN_ID)
          ? { traceId: span.traceId, spanId: span.parentSpanId }
          : span.links.find(
              (link) =>
                isId(link.traceId, TRACE_ID) && isId(link.spanId, SPAN_ID),
            );
        if (!parent) {
          reject("outcome_without_call");
          continue;
        }
        outcomes.push({
          callTraceId: parent.traceId,
          callSpanId: parent.spanId,
          outcomeName,
          outcomeStatus: status,
          outcomeEndTimeUnixNano: span.endTimeUnixNano,
          outcomeTraceId: span.traceId,
          outcomeSpanId: span.spanId,
        });
        continue;
      }

      if (
        attrs.get("mcp.method.name") !== "tools/call" ||
        span.kind !== SPAN_KIND_SERVER
      ) {
        continue;
      }
      if (
        !isId(span.traceId, TRACE_ID) ||
        !isId(span.spanId, SPAN_ID) ||
        !validTiming(span)
      ) {
        reject("invalid_span");
        continue;
      }
      const toolName = text(attrs, "gen_ai.tool.name");
      if (!toolName) {
        reject("missing_tool_name");
        continue;
      }
      calls.push({
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: isId(span.parentSpanId, SPAN_ID) ? span.parentSpanId : "",
        startTimeUnixNano: span.startTimeUnixNano,
        endTimeUnixNano: span.endTimeUnixNano,
        serviceName,
        serviceVersion,
        deploymentEnvironment,
        toolName,
        clientName: text(attrs, "mcp.client.name"),
        clientVersion: text(attrs, "mcp.client.version"),
        protocolVersion: text(attrs, "mcp.protocol.version"),
        jsonrpcRequestId: text(attrs, "jsonrpc.request.id"),
        conversationId: text(attrs, "gen_ai.conversation.id"),
        errorType: text(attrs, "error.type"),
        rpcStatusCode: text(
          attrs,
          "rpc.response.status_code",
          "rpc.status_code",
        ),
        spanStatusCode: span.statusCode,
        arguments: content(attrs, "gen_ai.tool.call.arguments", options.policy),
        result: content(attrs, "gen_ai.tool.call.result", options.policy),
      });
    }
  }

  const day = options.receivedAt.toISOString().slice(0, 10);
  const drops: DropRow[] = [...rejected].map(([reason, count]) => ({
    reason,
    count,
    batchDigest: options.batchDigest,
    day,
  }));
  const rejectedSpans = drops.reduce((sum, drop) => sum + drop.count, 0);
  return {
    calls,
    outcomes,
    drops,
    rejectedSpans,
    rejectionSummary:
      rejectedSpans === 0
        ? null
        : `Rejected ${rejectedSpans} span(s): ${drops
            .map((drop) => `${drop.count} ${drop.reason}`)
            .join(", ")}. See the MCPJam production traffic span contract.`,
  };
}

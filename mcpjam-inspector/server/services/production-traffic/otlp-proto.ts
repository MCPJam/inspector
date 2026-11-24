/**
 * The OTLP/HTTP protobuf messages the trace receiver reads and writes.
 *
 * Field numbers and types are copied from opentelemetry-proto
 * (`collector/trace/v1/trace_service.proto`, `trace/v1/trace.proto`,
 * `common/v1/common.proto`, `resource/v1/resource.proto`) and
 * `google/rpc/status.proto`. Only the fields the receiver uses are declared:
 * protobuf decoders skip fields a schema does not name, so a newer exporter's
 * additions are ignored rather than rejected. `@opentelemetry/otlp-transformer`
 * is not used because it encodes requests and decodes responses, with no
 * request decoder.
 */
import protobuf from "protobufjs";

const OTLP_TRACE_PROTO = `
syntax = "proto3";
package mcpjam.otlp;

message AnyValue {
  oneof value {
    string string_value = 1;
    bool bool_value = 2;
    int64 int_value = 3;
    double double_value = 4;
    ArrayValue array_value = 5;
    KeyValueList kvlist_value = 6;
    bytes bytes_value = 7;
  }
}
message ArrayValue { repeated AnyValue values = 1; }
message KeyValueList { repeated KeyValue values = 1; }
message KeyValue { string key = 1; AnyValue value = 2; }

message Resource { repeated KeyValue attributes = 1; }

message Status { string message = 2; int32 code = 3; }

message Link {
  bytes trace_id = 1;
  bytes span_id = 2;
}

message Span {
  bytes trace_id = 1;
  bytes span_id = 2;
  bytes parent_span_id = 4;
  string name = 5;
  int32 kind = 6;
  fixed64 start_time_unix_nano = 7;
  fixed64 end_time_unix_nano = 8;
  repeated KeyValue attributes = 9;
  repeated Link links = 13;
  Status status = 15;
}

message ScopeSpans { repeated Span spans = 2; }
message ResourceSpans { Resource resource = 1; repeated ScopeSpans scope_spans = 2; }

message ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }
message ExportTracePartialSuccess { int64 rejected_spans = 1; string error_message = 2; }
message ExportTraceServiceResponse { ExportTracePartialSuccess partial_success = 1; }

message RpcStatus { int32 code = 1; string message = 2; }
`;

const root = protobuf.parse(OTLP_TRACE_PROTO, { keepCase: false }).root;

export const ExportTraceServiceRequest = root.lookupType(
  "mcpjam.otlp.ExportTraceServiceRequest",
);
export const ExportTraceServiceResponse = root.lookupType(
  "mcpjam.otlp.ExportTraceServiceResponse",
);
/** `google.rpc.Status`: same fields and numbers, local name. */
export const RpcStatus = root.lookupType("mcpjam.otlp.RpcStatus");

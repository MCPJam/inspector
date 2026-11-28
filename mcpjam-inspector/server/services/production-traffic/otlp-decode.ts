/**
 * OTLP/HTTP trace exports, JSON or protobuf, decoded into one shape.
 *
 * The two encodings differ only in how ids and integers travel: OTLP/JSON
 * carries trace and span ids as hex strings and 64-bit integers as strings
 * or numbers, protobuf carries ids as bytes. Both are normalized here, so
 * mapping (`span-mapping.ts`) sees lowercase hex ids and bigint nanoseconds
 * whatever the exporter sent.
 */
import { ExportTraceServiceRequest } from "./otlp-proto.js";

export type OtlpFormat = "json" | "protobuf";

export type AttributeValue = string | number | boolean;

export type NormalizedSpan = {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: bigint;
  endTimeUnixNano: bigint;
  attributes: Map<string, AttributeValue>;
  links: { traceId: string; spanId: string }[];
  statusCode: number;
};

export type NormalizedResourceSpans = {
  resource: Map<string, AttributeValue>;
  spans: NormalizedSpan[];
};

/** The body is not an OTLP trace export: a permanent 400 for the exporter. */
export class OtlpDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OtlpDecodeError";
  }
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** OTLP/JSON names fields in lowerCamelCase only, as protobuf's toObject does. */
function list(object: Json, key: string): Json[] {
  const value = object[key];
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function toBigInt(value: unknown): bigint {
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return BigInt(Math.trunc(value));
  }
  return 0n;
}

function toInt(value: unknown): number {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isInteger(number) ? number : 0;
}

type IdEncoding = "hex" | "base64";

function toHexId(value: unknown, encoding: IdEncoding): string {
  if (typeof value !== "string" || value === "") return "";
  if (encoding === "hex") return value.toLowerCase();
  return Buffer.from(value, "base64").toString("hex");
}

/** A scalar attribute value; arrays and maps become JSON text. */
function toAttributeValue(any: unknown): AttributeValue | undefined {
  if (!isObject(any)) return undefined;
  const string = any.stringValue;
  if (typeof string === "string") return string;
  const bool = any.boolValue;
  if (typeof bool === "boolean") return bool;
  // Kept as decimal text: a 64-bit id or code must not lose digits.
  const int = any.intValue;
  if (typeof int === "string" || typeof int === "number") return String(int);
  const double = any.doubleValue;
  if (typeof double === "number") return double;
  const array = any.arrayValue;
  const kvlist = any.kvlistValue;
  if (isObject(array) || isObject(kvlist))
    return JSON.stringify(array ?? kvlist);
  return undefined;
}

function toAttributes(entries: Json[]): Map<string, AttributeValue> {
  const attributes = new Map<string, AttributeValue>();
  for (const entry of entries) {
    const key = entry.key;
    const value = toAttributeValue(entry.value);
    if (typeof key === "string" && value !== undefined) {
      attributes.set(key, value);
    }
  }
  return attributes;
}

function toSpan(span: Json, encoding: IdEncoding): NormalizedSpan {
  const status = span.status;
  return {
    traceId: toHexId(span.traceId, encoding),
    spanId: toHexId(span.spanId, encoding),
    parentSpanId: toHexId(span.parentSpanId, encoding),
    name: typeof span.name === "string" ? span.name : "",
    kind: toInt(span.kind),
    startTimeUnixNano: toBigInt(span.startTimeUnixNano),
    endTimeUnixNano: toBigInt(span.endTimeUnixNano),
    attributes: toAttributes(list(span, "attributes")),
    links: list(span, "links").map((link) => ({
      traceId: toHexId(link.traceId, encoding),
      spanId: toHexId(link.spanId, encoding),
    })),
    statusCode: isObject(status) ? toInt(status.code) : 0,
  };
}

function normalize(
  request: unknown,
  encoding: IdEncoding,
): NormalizedResourceSpans[] {
  if (!isObject(request)) {
    throw new OtlpDecodeError("The body is not an OTLP trace export");
  }
  return list(request, "resourceSpans").map((resourceSpans) => {
    const resource = resourceSpans.resource;
    return {
      resource: toAttributes(
        isObject(resource) ? list(resource, "attributes") : [],
      ),
      spans: list(resourceSpans, "scopeSpans").flatMap((scopeSpans) =>
        list(scopeSpans, "spans").map((span) => toSpan(span, encoding)),
      ),
    };
  });
}

export function decodeOtlpTraces(
  body: Uint8Array,
  format: OtlpFormat,
): NormalizedResourceSpans[] {
  if (format === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(body),
      );
    } catch {
      throw new OtlpDecodeError("The body is not valid UTF-8 JSON");
    }
    return normalize(parsed, "hex");
  }
  let message;
  try {
    message = ExportTraceServiceRequest.decode(body);
  } catch {
    throw new OtlpDecodeError("The body is not a protobuf trace export");
  }
  return normalize(
    ExportTraceServiceRequest.toObject(message, {
      longs: String,
      bytes: String,
      defaults: false,
    }),
    "base64",
  );
}

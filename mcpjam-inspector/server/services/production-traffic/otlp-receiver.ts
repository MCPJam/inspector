/**
 * The byte-level half of the OTLP/HTTP trace receiver: bounded reads of the
 * request, gzip, and responses in the request's own encoding, as the OTLP
 * specification requires.
 *
 * Both limits apply to this route alone (the rest of `/api/v1` keeps its 1 MiB
 * cap): 5 MiB on the wire, checked against `Content-Length` before anything is
 * read and again while streaming, and 5 MiB once inflated, enforced by zlib
 * as it inflates so a small gzip bomb cannot expand past it.
 */
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import type { OtlpFormat } from "./otlp-decode.js";
import { ExportTraceServiceResponse, RpcStatus } from "./otlp-proto.js";

const gunzipAsync = promisify(gunzip);

export const MAX_WIRE_BYTES = 5 * 1024 * 1024;
export const MAX_DECODED_BYTES = 5 * 1024 * 1024;

const CONTENT_TYPES: Record<OtlpFormat, string> = {
  json: "application/json",
  protobuf: "application/x-protobuf",
};

/** A request this receiver cannot accept, with the status to answer. */
export class OtlpRequestError extends Error {
  constructor(
    readonly status: 400 | 413 | 415,
    message: string,
  ) {
    super(message);
    this.name = "OtlpRequestError";
  }
}

export function formatOf(contentType: string | undefined): OtlpFormat | null {
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
  if (mediaType === CONTENT_TYPES.protobuf) return "protobuf";
  if (mediaType === CONTENT_TYPES.json) return "json";
  return null;
}

const TOO_LARGE = `Send batches under ${MAX_WIRE_BYTES / 1024 / 1024} MiB, compressed or not: lower the exporter's batch size (OTEL_BSP_MAX_EXPORT_BATCH_SIZE).`;

/** True when the declared length is already over the wire limit. */
export function declaresTooLarge(contentLength: string | undefined): boolean {
  const declared = Number(contentLength);
  return Number.isFinite(declared) && declared > MAX_WIRE_BYTES;
}

export async function readBody(request: Request): Promise<Uint8Array> {
  if (declaresTooLarge(request.headers.get("content-length") ?? undefined)) {
    throw new OtlpRequestError(413, TOO_LARGE);
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_WIRE_BYTES) {
      await reader.cancel();
      throw new OtlpRequestError(413, TOO_LARGE);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function inflate(
  body: Uint8Array,
  contentEncoding: string | undefined,
): Promise<Uint8Array> {
  const encoding = contentEncoding?.trim().toLowerCase() || "identity";
  if (encoding === "identity") return body;
  if (encoding !== "gzip") {
    throw new OtlpRequestError(
      415,
      "Send the batch uncompressed or with Content-Encoding: gzip.",
    );
  }
  try {
    return await gunzipAsync(body, { maxOutputLength: MAX_DECODED_BYTES });
  } catch (error) {
    if ((error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE") {
      throw new OtlpRequestError(413, TOO_LARGE);
    }
    throw new OtlpRequestError(400, "The gzip body could not be decompressed.");
  }
}

export type EncodedBody = {
  body: Uint8Array<ArrayBuffer> | string;
  contentType: string;
};

/** An ExportTraceServiceResponse, with partial success when spans were refused. */
export function encodeExportResponse(
  format: OtlpFormat,
  rejectedSpans: number,
  errorMessage: string | null,
): EncodedBody {
  const partialSuccess =
    rejectedSpans > 0 ? { errorMessage: errorMessage ?? "" } : null;
  if (format === "json") {
    // OTLP/JSON writes 64-bit integers as strings.
    return {
      body: JSON.stringify(
        partialSuccess
          ? {
              partialSuccess: {
                ...partialSuccess,
                rejectedSpans: String(rejectedSpans),
              },
            }
          : {},
      ),
      contentType: CONTENT_TYPES.json,
    };
  }
  return {
    body: new Uint8Array(
      ExportTraceServiceResponse.encode(
        ExportTraceServiceResponse.fromObject(
          partialSuccess
            ? { partialSuccess: { ...partialSuccess, rejectedSpans } }
            : {},
        ),
      ).finish(),
    ),
    contentType: CONTENT_TYPES.protobuf,
  };
}

/** A google.rpc.Status body for an error response. */
export function encodeStatus(
  format: OtlpFormat,
  httpStatus: number,
  message: string,
): EncodedBody {
  // gRPC codes for the HTTP statuses this route uses.
  const grpcCode =
    { 400: 3, 401: 16, 403: 7, 404: 5, 413: 8, 415: 3, 429: 8, 501: 12 }[
      httpStatus
    ] ?? 14;
  if (format === "json") {
    return {
      body: JSON.stringify({ code: grpcCode, message }),
      contentType: CONTENT_TYPES.json,
    };
  }
  return {
    body: new Uint8Array(
      RpcStatus.encode(
        RpcStatus.fromObject({ code: grpcCode, message }),
      ).finish(),
    ),
    contentType: CONTENT_TYPES.protobuf,
  };
}

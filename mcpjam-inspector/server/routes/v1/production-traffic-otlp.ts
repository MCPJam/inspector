/**
 * POST /api/v1/projects/:projectId/otlp/v1/traces: the OTLP/HTTP trace
 * receiver for production MCP traffic (PT-1).
 *
 * Mounted ahead of the v1 bearer middleware (see `routes/v1/index.ts`): the
 * caller is an OpenTelemetry exporter holding a producer credential, which is
 * not a user and is checked here against the install's own Convex. Responses
 * follow OTLP/HTTP instead of the v1 envelope: an ExportTraceServiceResponse,
 * or a google.rpc.Status in the request's encoding, with 429 and 503 as the
 * retryable refusals.
 */
import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import { logger } from "../../utils/logger.js";
import { reportRouteFailure } from "../../utils/route-error-report.js";
import { looksLikeConvexId } from "./convex-id-param.js";
import { getProductionTrafficStore } from "../../services/production-traffic/clickhouse-store.js";
import {
  decodeOtlpTraces,
  OtlpDecodeError,
  type OtlpFormat,
} from "../../services/production-traffic/otlp-decode.js";
import {
  encodeExportResponse,
  encodeStatus,
  formatOf,
  inflate,
  OtlpRequestError,
  readBody,
  type EncodedBody,
} from "../../services/production-traffic/otlp-receiver.js";
import {
  getProducerVerifier,
  PRODUCER_TOKEN_PATTERN,
  ProducerVerificationUnavailableError,
  type ProducerRefusal,
} from "../../services/production-traffic/producer-verifier.js";
import { mapTraceBatch } from "../../services/production-traffic/span-mapping.js";
import { TrafficStoreUnavailableError } from "../../services/production-traffic/store.js";

export const OTLP_TRACES_PATH = "/projects/:projectId/otlp/v1/traces";

/** Batches checked and written at once by this process; more get a 429. */
const MAX_IN_FLIGHT = 16;
const RETRY_AFTER_SECONDS = "5";
let inFlight = 0;

type ErrorStatus = 400 | 401 | 403 | 404 | 413 | 415 | 429 | 501 | 503;

const REFUSALS: Record<
  ProducerRefusal,
  { status: ErrorStatus; message: string }
> = {
  unknown_credential: {
    status: 401,
    message:
      "This producer credential is not recognized. Issue one in the project's production traffic settings and update your exporter.",
  },
  revoked: {
    status: 401,
    message:
      "This producer credential was revoked. Issue a new one in the project's production traffic settings and update your exporter.",
  },
  expired: {
    status: 401,
    message:
      "This producer credential has expired. Rotate it or issue a new one, then update your exporter.",
  },
  project_mismatch: {
    status: 403,
    message:
      "This producer credential belongs to a different project. Send to that project's endpoint, or issue a credential for this one.",
  },
  ingest_disabled: {
    status: 403,
    message:
      "Production traffic is off for this project. A project admin can turn it on in the project's production traffic settings.",
  },
  project_unavailable: {
    status: 404,
    message: "This project no longer exists or is being deleted.",
  },
};

function send(
  c: Context,
  status: 200 | ErrorStatus,
  encoded: EncodedBody,
  headers: Record<string, string> = {},
) {
  return c.body(encoded.body, status, {
    "Content-Type": encoded.contentType,
    ...headers,
  });
}

const otlp = new Hono();

otlp.post(OTLP_TRACES_PATH, async (c) => {
  const format: OtlpFormat | null = formatOf(c.req.header("content-type"));
  if (!format) {
    return send(
      c,
      415,
      encodeStatus(
        "json",
        415,
        "Send OTLP traces as application/x-protobuf or application/json.",
      ),
    );
  }
  const fail = (
    status: ErrorStatus,
    message: string,
    headers?: Record<string, string>,
  ) => send(c, status, encodeStatus(format, status, message), headers);

  const projectId = c.req.param("projectId");
  if (!looksLikeConvexId(projectId)) {
    return fail(
      404,
      "Project not found. Check the project id in the endpoint.",
    );
  }
  const token = /^Bearer\s+(\S+)\s*$/i.exec(
    c.req.header("authorization") ?? "",
  )?.[1];
  if (!token || !PRODUCER_TOKEN_PATTERN.test(token)) {
    return fail(
      401,
      "Send this project's producer credential as Authorization: Bearer mjotlp_…. A project admin can issue one in the production traffic settings.",
    );
  }

  let store;
  let verifier;
  try {
    store = getProductionTrafficStore();
    verifier = getProducerVerifier();
  } catch (error) {
    reportRouteFailure("Production traffic is misconfigured", error, {
      source: "v1.production-traffic.otlp.configuration",
      hop: "mcpjam_internal",
      context: { event: "production_traffic.misconfigured" },
    });
    store = null;
  }
  if (!store || !verifier) {
    return fail(
      501,
      "Production traffic is not set up on this MCPJam deployment.",
    );
  }
  if (inFlight >= MAX_IN_FLIGHT) {
    return fail(
      429,
      "This receiver is at capacity. Retry after the delay in Retry-After.",
      { "Retry-After": RETRY_AFTER_SECONDS },
    );
  }

  inFlight += 1;
  try {
    const verdict = await verifier.verify(projectId, token);
    if (!verdict.ok) {
      logger.info("Refused a production traffic batch", {
        event: "production_traffic.batch_refused",
        projectId,
        reason: verdict.reason,
      });
      const refusal = REFUSALS[verdict.reason];
      return fail(refusal.status, refusal.message);
    }
    const body = await inflate(
      await readBody(c.req.raw),
      c.req.header("content-encoding"),
    );
    const batch = mapTraceBatch(decodeOtlpTraces(body, format), {
      // Metadata only until project capture settings land (spec E5).
      policy: { storeContent: false },
      batchDigest: createHash("sha256").update(body).digest("hex"),
      receivedAt: new Date(),
    });
    await store.record(verdict.projectId, batch);
    logger.info("Accepted a production traffic batch", {
      event: "production_traffic.batch_accepted",
      projectId: verdict.projectId,
      credentialId: verdict.credentialId,
      calls: batch.calls.length,
      outcomes: batch.outcomes.length,
      rejectedSpans: batch.rejectedSpans,
    });
    return send(
      c,
      200,
      encodeExportResponse(format, batch.rejectedSpans, batch.rejectionSummary),
    );
  } catch (error) {
    if (error instanceof OtlpRequestError)
      return fail(error.status, error.message);
    if (error instanceof OtlpDecodeError) {
      return fail(
        400,
        `${error.message}. Send an OTLP ExportTraceServiceRequest.`,
      );
    }
    if (
      error instanceof TrafficStoreUnavailableError ||
      error instanceof ProducerVerificationUnavailableError
    ) {
      reportRouteFailure("Production traffic batch was not accepted", error, {
        source: "v1.production-traffic.otlp",
        hop: "mcpjam_internal",
        context: { projectId },
      });
      return fail(
        503,
        error instanceof TrafficStoreUnavailableError
          ? "Production traffic storage is unavailable. Retry after the delay in Retry-After."
          : "The producer credential could not be checked. Retry after the delay in Retry-After.",
        { "Retry-After": RETRY_AFTER_SECONDS },
      );
    }
    throw error;
  } finally {
    inFlight -= 1;
  }
});

export default otlp;

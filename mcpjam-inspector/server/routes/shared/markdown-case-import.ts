import { logger } from "../../utils/logger.js";
import type { Context } from "hono";
import { z } from "zod";
import {
  markdownSaveSchema,
  MAX_MARKDOWN_BYTES,
} from "../../../shared/markdown-case-import.js";
import {
  createConvexClient,
  requireConvexHttpUrl,
} from "../../services/evals/route-helpers.js";
import { createEvalCasesInBatches } from "./eval-case-batch.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import {
  ErrorCode,
  WebRouteError,
  mapRuntimeError,
  webErrorFromRoute,
} from "../web/errors.js";

/** Extraction runs a model over a document; give it room, but not forever. */
const EXTRACTION_TIMEOUT_MS = 120_000;
/** Matches the client's DEFAULTS.RUNS_PER_TEST for newly authored cases. */
const IMPORTED_CASE_RUNS = 5;

const inputSchema = z
  .object({
    projectId: z.string().min(1),
    suiteId: z.string().min(1),
    fileName: z.string().min(1).max(255).regex(/\.md$/i),
    markdown: z
      .string()
      .min(1)
      .refine(
        (s) =>
          s.trim().length > 0 &&
          new TextEncoder().encode(s).length <= MAX_MARKDOWN_BYTES,
      ),
  })
  .strict();

export async function handleMarkdownImport(
  c: Context,
  operation: "extract" | "save",
  local: boolean,
) {
  try {
    const raw = await c.req.text();
    if (
      new TextEncoder().encode(raw).length >
      (operation === "extract" ? 620000 : 7000000)
    ) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Import request is too large. Split the file.",
      );
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Invalid JSON body.",
      );
    }
    const token = local
      ? body?.convexAuthToken
      : await getConvexBearerForRequest(c);
    if (typeof token !== "string" || !token)
      throw new WebRouteError(
        401,
        ErrorCode.UNAUTHORIZED,
        "Sign in to import cases.",
      );
    if (local) delete body.convexAuthToken;
    const parsed = (
      operation === "extract" ? inputSchema : markdownSaveSchema
    ).safeParse(body);
    if (!parsed.success)
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Invalid Markdown import request.",
      );
    const convex = createConvexClient(token);
    // Also applied on save: recheck ownership and permissions after review.
    await convex.query("testSuites:checkCaseImportAccess" as any, {
      suiteId: body.suiteId,
      projectId: body.projectId,
    });
    if (operation === "extract") {
      const response = await fetch(
        `${requireConvexHttpUrl()}/eval-import/extract-markdown`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(parsed.data),
          // Client disconnect cancels; so does a stalled extraction service.
          signal: AbortSignal.any([
            c.req.raw.signal,
            AbortSignal.timeout(EXTRACTION_TIMEOUT_MS),
          ]),
        },
      );
      // Never advertise an upstream HTML/error document as JSON.
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        const upstream = {
          url: `${requireConvexHttpUrl()}/eval-import/extract-markdown`,
          status: response.status,
          contentType: response.headers.get("content-type"),
          requestId: response.headers.get("x-request-id"),
        };
        // Do not log document text, credentials, or the upstream response body.
        logger.warn(
          "Markdown extraction returned a non-JSON response",
          upstream,
        );
        return c.json(
          {
            code: "extraction_upstream_invalid_response",
            upstreamStatus: response.status,
            error:
              "The Markdown extraction service is unavailable. Please try again.",
          },
          502,
        );
      }
      return new Response(JSON.stringify(data), {
        status: response.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    const request = markdownSaveSchema.parse(parsed.data);
    const result = await createEvalCasesInBatches(convex, {
      suiteId: request.suiteId,
      duplicatePolicy: "block",
      cases: request.cases.map(({ prompt, ...item }) => ({
        ...item,
        steps: [{ id: "prompt", kind: "prompt", prompt }],
        // Inherit the suite model at run time; this stays stable on retries.
        models: [],
        runs: IMPORTED_CASE_RUNS,
        isNegativeTest: false,
        changeSource: "manual",
      })),
    });
    return c.json(result);
  } catch (error) {
    return webErrorFromRoute(c, mapRuntimeError(error));
  }
}

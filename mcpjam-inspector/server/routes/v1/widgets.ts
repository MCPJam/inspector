/**
 * `POST /v1/projects/:projectId/servers/:serverId/widgets/render` — render an
 * MCP App widget headlessly and describe what it produced.
 *
 * WHAT THIS IS FOR. A tool that returns a `ui://` resource is two products in
 * one: the tool result a model reads, and the interface a person sees. Every
 * other machine surface can inspect the first half. Nothing could inspect the
 * second — an agent debugging its own MCP App could read the widget's HTML and
 * had no way to learn whether it actually rendered, what it showed, or which
 * tools it fired on mount.
 *
 * This calls the tool, mounts its widget in real headless Chromium running the
 * production host bridge, and returns the render verdict plus the widget as an
 * ACCESSIBILITY TREE with addressable elements.
 *
 * DEFAULTS ARE REVERSED FROM THE LOCAL ROUTE, and deliberately. The local
 * `POST /api/mcp/widget-render` defaults to a screenshot because its caller is
 * a person looking at pixels. This one defaults to a SNAPSHOT and omits the
 * screenshot, because its caller is usually a model: a base64 PNG it may not
 * even be able to see is the most expensive possible way to say nothing, and
 * a text tree is both cheaper and directly actionable.
 *
 * STATELESS BY CONSTRUCTION. Connect, call, render, read, dispose — all inside
 * one request. That is what makes it safe on the hosted plane, which has no
 * session affinity: the interactive session registry (`/api/mcp/widget-session`)
 * keeps a live Chromium and a live manager in module scope, so a follow-up
 * request would land on a replica that has never heard of the session. Making
 * interactive sessions work there needs a dedicated single-replica renderer
 * service, not a route.
 *
 * CHROMIUM IS THE SCARCE RESOURCE. Each render launches a browser, so the route
 * carries its own concurrency cap. It is deliberately NOT the eval runner's:
 * that semaphore is module-private to `evals-runner.ts` and bounds a different
 * workload (a long fan-out) on a different budget. Sharing one number between
 * an interactive request and a batch job would let either starve the other.
 */
import { Hono } from "hono";
import { z } from "zod";
import { HOSTED_MODE } from "../../config.js";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { renderWidgetForRequest } from "../../utils/widget-render-core.js";
import { CHROMIUM_INSTALL_HINT } from "../../utils/widget-render-core.js";
import { logger } from "../../utils/logger.js";
import { reportRouteFailure } from "../../utils/route-error-report.js";
import { runV1ServerOp } from "./adapter.js";
import { v1Resource } from "./envelope.js";

const widgets = new Hono();

/**
 * Resolve `work`, or reject once `ms` have passed.
 *
 * The loser is NOT cancelled — the render core takes no abort signal — so this
 * bounds the REQUEST, and the caller's `finally` (disposing the harness) is
 * what bounds the browser. Both are needed: without the race a stuck widget
 * holds the request forever; without the disposal it holds Chromium forever.
 */
async function raceDeadline<T>(
  work: Promise<T>,
  ms: number,
  toolName: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          logger.warn("[v1/widgets] render exceeded its wall clock", {
            toolName,
          });
          reject(
            new WebRouteError(
              504,
              ErrorCode.TIMEOUT,
              `Rendering "${toolName}" exceeded the ${ms / 1000}s limit.`,
            ),
          );
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Read an image's type from its own first bytes.
 *
 * Only PNG and JPEG are possible here (the harness shoots one or the other),
 * and an unrecognised prefix falls back to PNG — the harness's default and the
 * only other thing it emits.
 */
function detectImageMimeType(base64: string): string {
  // `/9j/` is the base64 prefix of JPEG's SOI marker; `iVBORw0KG` is PNG's.
  if (base64.startsWith("/9j/")) return "image/jpeg";
  return "image/png";
}

/**
 * Concurrent renders per replica.
 *
 * Each one holds a Chromium context for the length of a page load, so this is
 * a memory ceiling as much as a fairness one. Four matches the render budget
 * the eval runner settled on for the same hardware.
 */
const MAX_CONCURRENT_RENDERS = (() => {
  const raw = Number(process.env.MCPJAM_MAX_CONCURRENT_WIDGET_RENDERS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 4;
})();

/**
 * Wall clock for one render.
 *
 * Shorter than a chat turn because there is no model in the loop: connect,
 * one tool call, one page load. A widget that has not painted in this long is
 * a finding, not a reason to hold the request open.
 */
const RENDER_WALL_CLOCK_MS = 45_000;

let activeRenders = 0;

const renderSchema = z
  .object({
    // Injected by `synthesizeServerBody` from the path — declared so the
    // schema accepts the synthesized body, not because a caller sends them.
    projectId: z.string().min(1),
    serverId: z.string().min(1),
    toolName: z.string().min(1),
    parameters: z.record(z.string(), z.unknown()).optional(),
    /**
     * The widget as a text tree. DEFAULT ON — see the module docblock.
     */
    includeSnapshot: z.boolean().optional(),
    /**
     * A base64 PNG/JPEG of the rendered widget. DEFAULT OFF: it is by far the
     * largest field this endpoint can return, and a caller that cannot see
     * images pays for it anyway.
     */
    includeScreenshot: z.boolean().optional(),
    /**
     * Mount with the OpenAI Apps compatibility shims instead of the plain
     * MCP-UI bridge — what to pass when the widget is being validated against
     * ChatGPT's host rather than a spec-default one.
     */
    injectOpenAiCompat: z.boolean().optional(),
    viewport: z
      .object({
        width: z.number().int().min(1).max(8192),
        height: z.number().int().min(1).max(8192),
      })
      .optional(),
  })
  // NOT `.strict()`: `synthesizeServerBody` merges the path params in, and a
  // strict schema laid over a synthesized body rejects the very fields this
  // module injected. The named fields above are the contract; the OpenAPI
  // entry documents them as the whole of it.
  .describe("Widget render request");

widgets.post(
  "/projects/:projectId/servers/:serverId/widgets/render",
  async (c) =>
    runV1ServerOp(
      c,
      renderSchema,
      async (manager, body) => {
        if (activeRenders >= MAX_CONCURRENT_RENDERS) {
          throw new WebRouteError(
            429,
            ErrorCode.RATE_LIMITED,
            `Too many widget renders in flight (max ${MAX_CONCURRENT_RENDERS}). Retry shortly.`,
          );
        }
        activeRenders += 1;
        const startedAt = Date.now();

        // TEARDOWN IS CHAINED TO THE RENDER, NOT TO THE RACE, and that is the
        // whole point of this shape.
        //
        // The previous revision assigned `result` only after `raceDeadline`
        // resolved, so on a timeout `result` stayed `undefined` and the
        // cleanup's `result?.harness?.dispose()` was a no-op — while the
        // orphaned render kept its Chromium alive and the slot was freed
        // anyway. Repeated timeouts would then exhaust the replica: exactly
        // the stuck-widget case the deadline exists to bound, made worse by
        // the deadline.
        //
        // So the render promise is held separately and disposal hangs off IT.
        // A render that loses the race keeps running (the core takes no abort
        // signal), and whenever it eventually settles its harness is disposed
        // and only then is the slot released.
        const renderPromise = renderWidgetForRequest({
          mcpClientManager: manager,
          serverId: body.serverId,
          toolName: body.toolName,
          parameters: body.parameters ?? {},
          injectOpenAiCompat: body.injectOpenAiCompat === true,
          ...(body.viewport ? { viewport: body.viewport } : {}),
          keepMounted: false,
          // D12: snapshot by default, screenshot on request.
          ...(body.includeSnapshot === false ? {} : { captureSnapshot: true }),
        });

        const teardown = renderPromise
          .then(
            (rendered) => rendered.harness?.dispose(),
            // A render that REJECTED never produced a harness to dispose.
            // Swallowed here because the awaiting caller below reports it;
            // rethrowing would surface an unhandled rejection on the timeout
            // path, where nobody is awaiting this chain.
            () => undefined,
          )
          .catch((error: unknown) => {
            // A leaked Chromium is the failure that takes a replica out, so
            // this pages rather than only landing in Axiom: `logger.warn` is
            // deliberately Sentry-free, and per AGENTS.md a route catch-site
            // reports through `reportRouteFailure` so the origin policy makes
            // the capture decision.
            reportRouteFailure(
              "[v1.widgets] headless browser disposal failed",
              error,
              {
                source: "v1.widgets.render.dispose",
                hop: "mcpjam_internal",
                context: { toolName: body.toolName },
              },
            );
          })
          .finally(() => {
            // Released only once the browser is actually gone. Decrementing
            // any earlier would let the next request launch a browser while
            // this one still existed, which is not a ceiling.
            activeRenders -= 1;
          });

        let result: Awaited<ReturnType<typeof renderWidgetForRequest>>;
        try {
          result = await raceDeadline(
            renderPromise,
            RENDER_WALL_CLOCK_MS,
            body.toolName,
          );

          const observation = result.observation;
          if (observation.status === "no_ui_resource") {
            throw new WebRouteError(
              422,
              ErrorCode.FEATURE_NOT_SUPPORTED,
              `Tool "${body.toolName}" does not declare an MCP App UI resource, so there is no widget to render.`,
            );
          }
          if (observation.status === "browser_unavailable") {
            throw new WebRouteError(
              // 422, and the status argument is NOT what decides that:
              // `v1OnError` derives the wire status from the public CODE
              // (`V1_ERROR_STATUS`), so the earlier `503 as never` cast here
              // was decoration that changed nothing while implying it did.
              //
              // 422 is also the honest answer. The public union has no 503,
              // and "this deployment does not have a browser" is a standing
              // capability fact rather than a transient outage — a caller
              // should stop asking, not back off and retry.
              422,
              ErrorCode.FEATURE_NOT_SUPPORTED,
              `Headless Chromium is unavailable on this deployment (${CHROMIUM_INSTALL_HINT}).`,
            );
          }

          return {
            status: observation.status,
            ...(observation.resourceUri
              ? { resourceUri: observation.resourceUri }
              : {}),
            ...(observation.bridgeInitialized !== undefined
              ? { bridgeInitialized: observation.bridgeInitialized }
              : {}),
            // The evidence an agent debugging a widget is actually after: what
            // the page logged, and what it was blocked from reaching. A widget
            // that "renders" while every fetch is blocked looks fine in a
            // screenshot and is broken.
            ...(observation.consoleErrors?.length
              ? { consoleErrors: observation.consoleErrors }
              : {}),
            ...(observation.blockedRequests?.length
              ? { blockedRequests: observation.blockedRequests }
              : {}),
            ...(result.snapshot ? { snapshot: result.snapshot } : {}),
            ...(body.includeScreenshot === true && observation.screenshotBase64
              ? {
                  screenshot: {
                    // DETECTED, not assumed. The harness re-shoots as
                    // progressively lower-quality JPEG when the PNG is over
                    // its byte budget — the common path for photographic or
                    // complex widgets — so a hardcoded `image/png` mislabels
                    // exactly the screenshots most likely to be re-encoded,
                    // and a client that trusts the type fails to render a
                    // perfectly good image.
                    mimeType: detectImageMimeType(observation.screenshotBase64),
                    base64: observation.screenshotBase64,
                  },
                }
              : {}),
            timings: {
              renderMs: observation.elapsedMs,
              totalMs: Date.now() - startedAt,
            },
          };
        } finally {
          // Nothing to do here: `teardown` was scheduled the moment the render
          // started and runs on every path, including the one where this
          // function threw before `result` existed. Referenced so the chain is
          // visibly intentional rather than looking like a floating promise.
          void teardown;
        }
      },
      (ctx, result) => v1Resource(ctx, result),
      { timeoutMs: RENDER_WALL_CLOCK_MS },
    ),
);

export default widgets;

/** Exported for the route test, which must not reach into module state. */
export const __testing = {
  MAX_CONCURRENT_RENDERS,
  renderSchema,
  isHosted: () => HOSTED_MODE,
};

/**
 * widget-render-request.ts — shared parsing/validation for the headless
 * widget-render request body, used by both `POST /api/mcp/widget-render`
 * (one-shot) and `POST /api/mcp/widget-session` (interactive start). Keeps the
 * two routes' input contract identical: same fields, same validation, same
 * error strings.
 */

/** Upper bound for a requested viewport edge (px) — guards against absurd
 *  allocations while covering desktop/retina capture sizes. */
const MAX_VIEWPORT_EDGE = 8192;

export interface ParsedWidgetRenderRequest {
  serverId: string;
  toolName: string;
  parameters: Record<string, unknown>;
  injectOpenAiCompat: boolean;
  viewport?: { width: number; height: number };
}

export type WidgetRenderRequestParse =
  | { ok: true; value: ParsedWidgetRenderRequest }
  | { ok: false; error: string };

function isPositivePixelDimension(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_VIEWPORT_EDGE
  );
}

/**
 * Validate the shared render request body:
 *   { serverId, toolName, parameters?, injectOpenAiCompat?, viewport? }
 * Tool arguments must be a plain JSON object (a missing value defaults to {});
 * a provided viewport must be `{ width, height }` with positive integer pixels.
 */
export function parseWidgetRenderRequestBody(
  body: unknown,
): WidgetRenderRequestParse {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Invalid request body" };
  }
  const b = body as Record<string, unknown>;

  const serverId = typeof b.serverId === "string" ? b.serverId : "";
  if (!serverId) return { ok: false, error: "serverId is required" };
  const toolName = typeof b.toolName === "string" ? b.toolName : "";
  if (!toolName) return { ok: false, error: "toolName is required" };

  // Tool arguments must be a plain JSON object. Missing/null defaults to {};
  // anything else provided (array, string, number) is a client error rather
  // than silently forwarded to executeTool.
  let parameters: Record<string, unknown> = {};
  if (b.parameters !== undefined && b.parameters !== null) {
    if (typeof b.parameters !== "object" || Array.isArray(b.parameters)) {
      return { ok: false, error: "parameters must be a JSON object" };
    }
    parameters = b.parameters as Record<string, unknown>;
  }

  let viewport: { width: number; height: number } | undefined;
  if (b.viewport !== undefined && b.viewport !== null) {
    const v = b.viewport;
    if (
      typeof v !== "object" ||
      Array.isArray(v) ||
      !isPositivePixelDimension((v as { width?: unknown }).width) ||
      !isPositivePixelDimension((v as { height?: unknown }).height)
    ) {
      return {
        ok: false,
        error:
          "viewport must be an object with positive integer width and height (px)",
      };
    }
    viewport = {
      width: (v as { width: number }).width,
      height: (v as { height: number }).height,
    };
  }

  return {
    ok: true,
    value: {
      serverId,
      toolName,
      parameters,
      injectOpenAiCompat: b.injectOpenAiCompat === true,
      viewport,
    },
  };
}

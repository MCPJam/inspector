import { Hono } from "hono";
import "../../types/hono";
import { SUPPORTED_MODELS, SUPPORTED_MODELS_REVIEWED_AT } from "@/shared/types";
import { getByokProviderAdapter } from "../../utils/byok/providers/index.js";
import { normalizeIds } from "../../utils/byok/list-request.js";
import { StaticModelObservationStore } from "../../utils/byok/static-model-observations.js";

/**
 * POST /api/mcp/byok-models
 *
 * Discover the models a BYOK connection on this machine serves, through the
 * provider's adapter, and reconcile the reviewed static list with the answer.
 *
 * Body: `{ providerKey, apiKey?, baseUrl?, configuredModelIds? }`. The key is
 * used for the one upstream list call and dropped: it is not logged, stored,
 * or echoed, and upstream error bodies are not relayed (see the adapters).
 *
 * Local mode only: `/api/mcp/*` is 410'd in hosted mode except the paths in
 * `HOSTED_OPEN_MCP_PATHS`, and this is not one of them, so a hosted server
 * never makes outbound calls to a caller-supplied base URL.
 */

const byokModels = new Hono();

const observations = new StaticModelObservationStore();

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

byokModels.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { ok: false, code: "invalid_request", message: "Body must be JSON" },
      400,
    );
  }
  const record =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const providerKey = readOptionalString(record.providerKey);
  if (!providerKey) {
    return c.json(
      {
        ok: false,
        code: "invalid_request",
        message: "providerKey is required",
      },
      400,
    );
  }
  const adapter = getByokProviderAdapter(providerKey);
  if (!adapter) {
    return c.json(
      {
        ok: false,
        code: "unsupported_provider",
        message: `No model discovery for provider ${providerKey}`,
      },
      400,
    );
  }

  const configuredModelIds = Array.isArray(record.configuredModelIds)
    ? normalizeIds(
        record.configuredModelIds.filter(
          (id): id is string => typeof id === "string",
        ),
      )
    : undefined;
  const apiKey = readOptionalString(record.apiKey);
  const baseUrl = readOptionalString(record.baseUrl);
  const result = await adapter.listModels({
    providerKey,
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(configuredModelIds ? { configuredModelIds } : {}),
  });

  const staticIds = SUPPORTED_MODELS.filter(
    (model) => model.provider === providerKey,
  ).map((model) => String(model.id));
  const observation = observations.observe(
    `local:${providerKey}`,
    adapter,
    staticIds,
    result,
  );
  const removed = new Set(observation.removed);
  const staticSummary = {
    reviewedAt: SUPPORTED_MODELS_REVIEWED_AT,
    kept: staticIds.filter((id) => !removed.has(id)),
    removed: observation.removed,
    missing: observation.missing,
    recorded: observation.recorded,
    ...(observation.skippedReason
      ? { skippedReason: observation.skippedReason }
      : {}),
  };

  if (!result.ok) {
    return c.json(
      {
        ok: false,
        code: result.code,
        message: result.message,
        ...(result.status !== undefined ? { status: result.status } : {}),
        static: staticSummary,
      },
      result.code === "missing_credentials" ? 400 : 502,
    );
  }
  return c.json({
    ok: true,
    providerKey,
    source: result.source,
    complete: result.complete,
    observedAt: result.observedAt,
    models: result.models,
    static: staticSummary,
  });
});

/** Forget recorded misses. Test-only. */
export function __resetByokModelObservationsForTests(): void {
  observations.reset();
}

export default byokModels;

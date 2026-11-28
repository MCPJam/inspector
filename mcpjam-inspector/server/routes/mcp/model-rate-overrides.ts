import { Hono, type Context } from "hono";
import "../../types/hono";
import {
  MODEL_RATE_FIELDS,
  type ModelRateInput,
} from "@/shared/model-rate-input";
import {
  LocalRateOverrideError,
  localRateOverrides,
} from "../../utils/call-cost/local-rate-overrides.js";
import { reportRouteFailure } from "../../utils/route-error-report.js";

/**
 * /api/mcp/model-rate-overrides: rates a person enters for the models they
 * run on their own keys, stored on this machine and used to price those
 * calls. Local mode only: `/api/mcp/*` is closed in hosted mode except the
 * paths in `HOSTED_OPEN_MCP_PATHS`, and this is not one of them.
 *
 *   GET  /                          current rate per provider and model
 *   GET  /?providerKey=&modelId=    that series' revisions, newest first
 *   POST /                          save a new revision
 *   POST /:rateId/retire            stop using a rate from now on
 */
const modelRateOverrides = new Hono();

const STATUS = { invalid_rate: 400, not_found: 404, changed: 409 } as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown) =>
  typeof value === "string" ? value : undefined;

/** Absent stays absent; anything else not a number reads as NaN, which is refused. */
const number = (value: unknown) =>
  value === undefined || value === null || value === ""
    ? undefined
    : typeof value === "number"
      ? value
      : Number.NaN;

function readRateInput(body: unknown): ModelRateInput {
  const record = isRecord(body) ? body : {};
  const rates = isRecord(record.rates) ? record.rates : {};
  return {
    modelId: text(record.modelId) ?? "",
    providerKey: text(record.providerKey),
    rates: Object.fromEntries(
      MODEL_RATE_FIELDS.map((field) => [field, number(rates[field])]),
    ),
    effectiveAt: number(record.effectiveAt),
    note: text(record.note),
  };
}

function failure(c: Context, error: unknown, action: string) {
  if (error instanceof LocalRateOverrideError) {
    return c.json(
      { ok: false, code: error.code, message: error.message },
      STATUS[error.code],
    );
  }
  reportRouteFailure(`[model-rate-overrides] ${action} failed`, error, {
    source: "mcp.model-rate-overrides",
    hop: "user_server_hop",
  });
  return c.json(
    {
      ok: false,
      code: "storage_error",
      message: `Could not ${action} the rates stored on this machine. Check that the .mcpjam folder in your home directory is writable, then try again.`,
    },
    500,
  );
}

modelRateOverrides.get("/", async (c) => {
  const providerKey = c.req.query("providerKey")?.trim();
  const modelId = c.req.query("modelId")?.trim();
  try {
    return c.json(
      providerKey && modelId
        ? {
            ok: true,
            revisions: await localRateOverrides.history(providerKey, modelId),
          }
        : { ok: true, rates: await localRateOverrides.list() },
    );
  } catch (error) {
    return failure(c, error, "read");
  }
});

modelRateOverrides.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = undefined; // Not JSON: reads as empty, which the validator refuses.
  }
  try {
    const rate = await localRateOverrides.set(readRateInput(body));
    return c.json({ ok: true, rate });
  } catch (error) {
    return failure(c, error, "save");
  }
});

modelRateOverrides.post("/:rateId/retire", async (c) => {
  try {
    const rate = await localRateOverrides.retire(c.req.param("rateId"));
    return c.json({ ok: true, rate });
  } catch (error) {
    return failure(c, error, "update");
  }
});

export default modelRateOverrides;

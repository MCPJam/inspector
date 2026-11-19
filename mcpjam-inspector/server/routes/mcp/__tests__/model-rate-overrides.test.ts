import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import modelRateOverrides from "../model-rate-overrides.js";
import { HOSTED_OPEN_MCP_PATHS } from "../../../middleware/hosted-partition.js";

const BASE = "/api/mcp/model-rate-overrides";

function mount(): Hono {
  const app = new Hono();
  app.route(BASE, modelRateOverrides);
  return app;
}

const post = (app: Hono, path: string, body?: unknown) =>
  app.request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("/api/mcp/model-rate-overrides", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rate-overrides-route-"));
    process.env.MCPJAM_MODEL_RATE_OVERRIDES_FILE = join(dir, "rates.json");
  });

  afterEach(() => {
    delete process.env.MCPJAM_MODEL_RATE_OVERRIDES_FILE;
    rmSync(dir, { recursive: true, force: true });
  });

  it("is not served in hosted mode", () => {
    expect(HOSTED_OPEN_MCP_PATHS.has(BASE)).toBe(false);
  });

  it("saves, lists, shows history and retires a rate", async () => {
    const app = mount();
    const rate = {
      providerKey: "anthropic",
      modelId: "claude-sonnet-4-5",
      rates: { input: 2.5, output: 12, cacheRead: 0.25 },
      note: "Committed-use discount",
    };

    const first = await (await post(app, "", rate)).json();
    const second = await (
      await post(app, "", { ...rate, rates: { input: 2, output: 10 } })
    ).json();
    expect(first).toMatchObject({
      ok: true,
      rate: {
        revision: 1,
        rates: { currency: "USD", input: 2.5, output: 12, cacheRead: 0.25 },
        note: "Committed-use discount",
      },
    });

    const listed = await (await app.request(BASE)).json();
    expect(listed.rates).toEqual([second.rate]);

    const history = await (
      await app.request(
        `${BASE}?providerKey=anthropic&modelId=claude-sonnet-4-5`,
      )
    ).json();
    expect(
      history.revisions.map((r: { revision: number }) => r.revision),
    ).toEqual([2, 1]);

    const stale = await post(app, `/${first.rate.rateId}/retire`);
    expect(stale.status).toBe(409);
    const retired = await post(app, `/${second.rate.rateId}/retire`);
    expect(retired.status).toBe(200);
    expect((await (await app.request(BASE)).json()).rates).toEqual([]);
  });

  it.each([
    [
      { modelId: "m", rates: { input: 1, output: 1 } },
      "Pick the provider these prices apply to.",
    ],
    [
      { providerKey: "ollama", modelId: "m", rates: { input: "1", output: 1 } },
      "Input price must be zero or more. Enter a dollar amount.",
    ],
    [
      { providerKey: "ollama", modelId: "m", rates: { input: 1 } },
      "Output price must be zero or more. Enter a dollar amount.",
    ],
    [undefined, "Enter a model ID, such as anthropic/claude-sonnet-4.5."],
  ])("refuses %j", async (body, message) => {
    const res = await post(mount(), "", body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false,
      code: "invalid_rate",
      message,
    });
  });

  it("answers 404 for a rate that does not exist", async () => {
    expect((await post(mount(), "/nope/retire")).status).toBe(404);
  });
});

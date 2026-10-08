import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import byokModels, {
  __resetByokModelObservationsForTests,
} from "../byok-models.js";
import { SUPPORTED_MODELS_REVIEWED_AT } from "@/shared/types";
import { HOSTED_OPEN_MCP_PATHS } from "../../../middleware/hosted-partition.js";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../utils/byok/__tests__/fixtures",
);
const fixture = (name: string) =>
  readFileSync(path.join(FIXTURES, name), "utf8");
const KEY = "sk-fixture-placeholder";

function mount(): Hono {
  const app = new Hono();
  app.route("/api/mcp/byok-models", byokModels);
  return app;
}

const post = (app: Hono, body: unknown) =>
  app.request("/api/mcp/byok-models", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /api/mcp/byok-models", () => {
  const originalFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetByokModelObservationsForTests();
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("is not served in hosted mode", () => {
    expect(HOSTED_OPEN_MCP_PATHS.has("/api/mcp/byok-models")).toBe(false);
  });

  it("lists through the adapter and reports the static list, key never echoed", async () => {
    fetchMock.mockResolvedValue(
      new Response(fixture("openai-models.json"), { status: 200 }),
    );
    const res = await post(mount(), { providerKey: "openai", apiKey: KEY });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(KEY);
    const json = JSON.parse(text);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      expect.anything(),
    );
    expect(json).toMatchObject({
      ok: true,
      providerKey: "openai",
      source: "provider-list",
      complete: true,
    });
    expect(json.models).toContainEqual({
      nativeId: "gpt-4o",
      canonicalId: "openai/gpt-4o",
    });
    expect(json.static.reviewedAt).toBe(SUPPORTED_MODELS_REVIEWED_AT);
    // First miss: recorded, nothing removed.
    expect(json.static.removed).toEqual([]);
    expect(json.static.kept).toContain("gpt-5.1");
    expect(
      json.static.missing.map((m: { nativeId: string }) => m.nativeId),
    ).toContain("gpt-5.1");
  });

  it("drops a static id only after a second observation an hour later", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_790_000_000_000);
    fetchMock.mockImplementation(
      async () => new Response(fixture("openai-models.json"), { status: 200 }),
    );
    const app = mount();
    const first = await (
      await post(app, { providerKey: "openai", apiKey: KEY })
    ).json();
    expect(first.static.removed).toEqual([]);
    vi.setSystemTime(1_790_000_000_000 + 60 * 60 * 1000);
    const second = await (
      await post(app, { providerKey: "openai", apiKey: KEY })
    ).json();
    expect(second.static.removed).toContain("gpt-5.1");
    expect(second.static.kept).not.toContain("gpt-5.1");
    expect(second.static.kept).toContain("gpt-4o");
  });

  it("an upstream failure removes nothing and relays no upstream body", async () => {
    fetchMock.mockResolvedValue(
      new Response(fixture("openai-401.json"), { status: 401 }),
    );
    const res = await post(mount(), { providerKey: "openai", apiKey: KEY });
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json).toMatchObject({
      ok: false,
      code: "unauthorized",
      status: 401,
    });
    expect(json.static).toMatchObject({
      recorded: false,
      skippedReason: "list_failed",
      removed: [],
    });
    expect(JSON.stringify(json)).not.toContain("Incorrect API key");
  });

  it("answers 400 without a key and without calling out", async () => {
    const res = await post(mount(), { providerKey: "anthropic" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("missing_credentials");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports configured Azure deployments without calling out", async () => {
    const res = await post(mount(), {
      providerKey: "azure",
      apiKey: KEY,
      configuredModelIds: ["prod-gpt51"],
    });
    const json = await res.json();
    expect(json).toMatchObject({
      ok: true,
      source: "configured",
      models: [{ nativeId: "prod-gpt51" }],
      static: { recorded: false, skippedReason: "configured_source" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses unknown providers and bad bodies", async () => {
    const app = mount();
    expect((await post(app, { providerKey: "deepseek" })).status).toBe(400);
    expect((await post(app, {})).status).toBe(400);
    const notJson = await app.request("/api/mcp/byok-models", {
      method: "POST",
      body: "nope",
    });
    expect(notJson.status).toBe(400);
  });
});

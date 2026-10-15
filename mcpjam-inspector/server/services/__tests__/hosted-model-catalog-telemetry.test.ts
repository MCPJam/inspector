import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sinks = vi.hoisted(() => ({
  ingest: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));
vi.mock("@axiomhq/js", () => ({
  Axiom: class {
    ingest = sinks.ingest;
    flush = vi.fn().mockResolvedValue(undefined);
  },
}));
vi.mock("@sentry/node", () => ({
  captureException: sinks.captureException,
  captureMessage: sinks.captureMessage,
}));

const PRIVATE = "PRIVATE_CATALOG_SENTINEL";
const CACHED_MODEL = `vendor/${PRIVATE}`;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("ENVIRONMENT", "prod");
  vi.stubEnv("DO_NOT_TRACK", "0");
  vi.stubEnv("AXIOM_TOKEN", "test-token");
  vi.stubEnv("AXIOM_CLEAN_DATASET", "test-catalog-logs");
  vi.stubEnv("CONVEX_HTTP_URL", `https://backend.example/${PRIVATE}`);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("hosted catalog failure telemetry through the real logger", () => {
  it.each([
    {
      reason: "fetch_failed",
      response: () => new Response(PRIVATE, { status: 503 }),
    },
    {
      reason: "fetch_failed",
      response: () => Promise.reject(new Error(PRIVATE)),
    },
    { reason: "invalid_catalog", response: () => new Response(PRIVATE) },
    { reason: "invalid_catalog", response: () => Response.json(null) },
    { reason: "invalid_catalog", response: () => Response.json({}) },
    { reason: "invalid_catalog", response: () => Response.json({ items: [] }) },
    {
      reason: "invalid_catalog",
      response: () => Response.json({ items: [null, { id: 123 }] }),
    },
  ])(
    "emits one bounded $reason warning and preserves the warm cache",
    async ({ reason, response }) => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => response());
      const catalog = await import("../hosted-model-catalog.js");
      catalog.__setHostedCatalogForTests([CACHED_MODEL]);
      await catalog.refreshHostedModelCatalog();

      expect(sinks.ingest).toHaveBeenCalledExactlyOnceWith(
        "test-catalog-logs",
        [
          expect.objectContaining({
            event: "model_catalog.refresh.failed",
            level: "warn",
            reason,
            environment: "prod",
            authType: "system",
          }),
        ],
      );
      expect(JSON.stringify(sinks.ingest.mock.calls)).not.toContain(PRIVATE);
      expect(catalog.isHostedCatalogModel(CACHED_MODEL)).toBe(true);
      expect(sinks.captureException).not.toHaveBeenCalled();
      expect(sinks.captureMessage).not.toHaveBeenCalled();
    },
  );

  it("reports missing configuration without fetching or exposing configuration text", async () => {
    vi.stubEnv("CONVEX_HTTP_URL", "");
    const fetch = vi.spyOn(globalThis, "fetch");
    const catalog = await import("../hosted-model-catalog.js");
    await catalog.refreshHostedModelCatalog();
    expect(fetch).not.toHaveBeenCalled();
    expect(sinks.ingest).toHaveBeenCalledExactlyOnceWith("test-catalog-logs", [
      expect.objectContaining({
        event: "model_catalog.refresh.failed",
        level: "warn",
        reason: "fetch_failed",
      }),
    ]);
  });

  it("refreshes a valid catalog without emitting the failure event or model identifiers", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ items: [{ id: CACHED_MODEL }] }),
    );
    const catalog = await import("../hosted-model-catalog.js");
    await catalog.refreshHostedModelCatalog();
    expect(catalog.isHostedCatalogModel(CACHED_MODEL)).toBe(true);
    expect(
      sinks.ingest.mock.calls.flatMap((call) => call[1]),
    ).not.toContainEqual(
      expect.objectContaining({ event: "model_catalog.refresh.failed" }),
    );
    expect(JSON.stringify(sinks.ingest.mock.calls)).not.toContain(PRIVATE);
  });
});

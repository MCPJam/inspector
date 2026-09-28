import { describe, expect, it } from "vitest";
import { SUPPORTED_MODELS } from "@/shared/types";
import {
  BYOK_PROVIDER_ADAPTERS,
  anthropicAdapter,
  azureAdapter,
  bedrockAdapter,
  customAdapter,
  getByokProviderAdapter,
  googleAdapter,
  ollamaAdapter,
  openaiAdapter,
  openrouterAdapter,
} from "../providers/index.js";
import { ANTHROPIC_NATIVE_IDS } from "../providers/anthropic.js";
import { GOOGLE_NATIVE_IDS } from "../providers/google.js";
import { OPENAI_NATIVE_IDS } from "../providers/openai.js";
import { ollamaHostRoot } from "../providers/ollama.js";
import { createNativeIdTable } from "../native-id-table.js";
import type { ByokListResult, ByokProviderAdapter } from "../types.js";
import { PLACEHOLDER_KEY, fixtureFetch } from "./fixture-fetch.js";

const NOW = 1_790_000_000_000;
const deps = (f: typeof fetch) => ({ fetch: f, now: () => NOW });

function expectOk(result: ByokListResult) {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
  return result;
}

function expectNoKey(value: unknown) {
  expect(JSON.stringify(value)).not.toContain(PLACEHOLDER_KEY);
}

/** Shared failure contract for adapters that call a list endpoint. */
function describeListFailures(
  adapter: ByokProviderAdapter,
  connection: { baseUrl?: string } = {},
) {
  const conn = {
    providerKey: adapter.providerKey,
    apiKey: PLACEHOLDER_KEY,
    ...connection,
  };

  it("maps 401 to unauthorized without relaying the upstream body or key", async () => {
    const { fetch } = fixtureFetch([
      { match: () => true, status: 401, fixture: "openai-401.json" },
    ]);
    const result = await adapter.listModels(conn, deps(fetch));
    expect(result).toMatchObject({
      ok: false,
      code: "unauthorized",
      status: 401,
    });
    expectNoKey(result);
    // The fixture body echoes a masked key; none of it is relayed.
    expect(JSON.stringify(result)).not.toContain("sk-fixt");
    expect(JSON.stringify(result)).not.toContain("Incorrect API key");
  });

  it("maps other statuses to http_error", async () => {
    const { fetch } = fixtureFetch([
      { match: () => true, status: 503, body: { error: "down" } },
    ]);
    const result = await adapter.listModels(conn, deps(fetch));
    expect(result).toMatchObject({
      ok: false,
      code: "http_error",
      status: 503,
    });
  });

  it("maps a network failure to network_error", async () => {
    const { fetch } = fixtureFetch([{ match: () => true, networkError: true }]);
    const result = await adapter.listModels(conn, deps(fetch));
    expect(result).toMatchObject({ ok: false, code: "network_error" });
    expectNoKey(result);
  });

  it("maps a non-JSON or wrong-shape body to malformed_response", async () => {
    const notJson = fixtureFetch([{ match: () => true, rawBody: "<html>" }]);
    expect(await adapter.listModels(conn, deps(notJson.fetch))).toMatchObject({
      ok: false,
      code: "malformed_response",
    });
    const wrongShape = fixtureFetch([
      { match: () => true, body: { data: "nope", models: "nope" } },
    ]);
    expect(
      await adapter.listModels(conn, deps(wrongShape.fetch)),
    ).toMatchObject({ ok: false, code: "malformed_response" });
  });
}

/** Every static row of the provider has a reviewed table row. */
function expectStaticRowsMapped(
  provider: string,
  adapter: ByokProviderAdapter,
) {
  const staticIds = SUPPORTED_MODELS.filter((m) => m.provider === provider).map(
    (m) => String(m.id),
  );
  expect(staticIds.length).toBeGreaterThan(0);
  for (const nativeId of staticIds) {
    const canonical = adapter.toCanonicalId(nativeId);
    expect(canonical, `${provider} static row ${nativeId}`).toBeDefined();
    expect(adapter.toNativeId(canonical!)).toMatchObject({
      ok: true,
      nativeId,
    });
  }
}

describe("native id tables", () => {
  it("refuses rows without evidence and conflicting rows", () => {
    expect(() =>
      createNativeIdTable("T", [
        { canonicalId: "a/x", nativeId: "x", evidence: " " },
      ]),
    ).toThrow(/no evidence/);
    expect(() =>
      createNativeIdTable("T", [
        { canonicalId: "a/x", nativeId: "x", evidence: "e" },
        { canonicalId: "a/x", nativeId: "y", evidence: "e" },
      ]),
    ).toThrow(/listed twice/);
    expect(() =>
      createNativeIdTable("T", [
        { canonicalId: "a/x", nativeId: "x", evidence: "e" },
        { canonicalId: "a/y", nativeId: "x", evidence: "e" },
      ]),
    ).toThrow(/claimed by/);
  });

  it.each([
    ["openai", OPENAI_NATIVE_IDS],
    ["anthropic", ANTHROPIC_NATIVE_IDS],
    ["google", GOOGLE_NATIVE_IDS],
  ] as const)("every %s row carries evidence", (_provider, rows) => {
    for (const row of rows) expect(row.evidence.length).toBeGreaterThan(20);
  });

  it("never derives a native id by stripping the canonical prefix", () => {
    // Shaped exactly like a mapped id, but not reviewed: unmapped, not guessed.
    expect(openaiAdapter.toNativeId("openai/gpt-9")).toMatchObject({
      ok: false,
      code: "unmapped",
    });
    expect(
      anthropicAdapter.toNativeId("anthropic/claude-opus-9"),
    ).toMatchObject({
      ok: false,
      code: "unmapped",
    });
    expect(googleAdapter.toNativeId("google/gemini-9-pro")).toMatchObject({
      ok: false,
      code: "unmapped",
    });
    // The dotted canonical and the dashed native differ by more than a prefix.
    expect(
      anthropicAdapter.toNativeId("anthropic/claude-sonnet-4.5"),
    ).toMatchObject({
      ok: true,
      nativeId: "claude-sonnet-4-5",
    });
  });

  it.each([
    ["openai", openaiAdapter],
    ["anthropic", anthropicAdapter],
    ["google", googleAdapter],
  ] as const)("maps every SUPPORTED_MODELS %s row", (provider, adapter) => {
    expectStaticRowsMapped(provider, adapter);
  });

  it.each([
    ["azure", azureAdapter],
    ["bedrock", bedrockAdapter],
    ["custom", customAdapter],
    ["ollama", ollamaAdapter],
  ] as const)("%s requires an explicit native id", (_p, adapter) => {
    expect(adapter.toNativeId("azure/gpt-5.1")).toMatchObject({
      ok: false,
      code: "explicit_native_id_required",
    });
    expect(adapter.toCanonicalId("gpt-5.1")).toBeUndefined();
  });

  it("resolves adapters by provider key, custom:<slug> included", () => {
    expect(getByokProviderAdapter("custom:groq")).toBe(customAdapter);
    expect(getByokProviderAdapter("openai")).toBe(openaiAdapter);
    expect(getByokProviderAdapter("constructor")).toBeUndefined();
    expect(getByokProviderAdapter("deepseek")).toBeUndefined();
    expect(Object.keys(BYOK_PROVIDER_ADAPTERS).sort()).toEqual([
      "anthropic",
      "azure",
      "bedrock",
      "custom",
      "google",
      "ollama",
      "openai",
      "openrouter",
    ]);
  });
});

describe("OpenAI adapter", () => {
  it("reads GET /v1/models with a bearer key and maps reviewed ids", async () => {
    const { fetch, requests } = fixtureFetch([
      {
        match: "https://api.openai.com/v1/models",
        fixture: "openai-models.json",
      },
    ]);
    const result = expectOk(
      await openaiAdapter.listModels(
        { providerKey: "openai", apiKey: PLACEHOLDER_KEY },
        deps(fetch),
      ),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.authorization).toBe(`Bearer ${PLACEHOLDER_KEY}`);
    expect(requests[0].url).not.toContain(PLACEHOLDER_KEY);
    expect(result).toMatchObject({
      source: "provider-list",
      complete: true,
      observedAt: NOW,
    });
    expect(result.models.map((m) => m.nativeId)).toContain(
      "text-embedding-3-small",
    );
    expect(result.models.find((m) => m.nativeId === "gpt-4o")).toEqual({
      nativeId: "gpt-4o",
      canonicalId: "openai/gpt-4o",
    });
    // A dated snapshot is listed but not in the reviewed table: no canonical.
    expect(
      result.models.find((m) => m.nativeId === "gpt-5-2025-08-07"),
    ).toEqual({
      nativeId: "gpt-5-2025-08-07",
    });
    expectNoKey(result);
  });

  it("does not call out without a key", async () => {
    const { fetch, requests } = fixtureFetch([]);
    expect(
      await openaiAdapter.listModels({ providerKey: "openai" }, deps(fetch)),
    ).toMatchObject({ ok: false, code: "missing_credentials" });
    expect(requests).toHaveLength(0);
  });

  describeListFailures(openaiAdapter);
});

describe("Anthropic adapter", () => {
  it("pages GET /v1/models with x-api-key and maps dated snapshots", async () => {
    const { fetch, requests } = fixtureFetch([
      {
        match: (url) =>
          url.pathname === "/v1/models" && !url.searchParams.has("after_id"),
        fixture: "anthropic-models-page1.json",
      },
      {
        match: (url) => url.searchParams.get("after_id") === "claude-sonnet-5",
        fixture: "anthropic-models-page2.json",
      },
    ]);
    const result = expectOk(
      await anthropicAdapter.listModels(
        { providerKey: "anthropic", apiKey: PLACEHOLDER_KEY },
        deps(fetch),
      ),
    );
    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe(
      "https://api.anthropic.com/v1/models?limit=1000",
    );
    expect(requests[0].headers["x-api-key"]).toBe(PLACEHOLDER_KEY);
    expect(requests[0].headers["anthropic-version"]).toBe("2023-06-01");
    expect(result.complete).toBe(true);
    expect(result.models).toEqual([
      {
        nativeId: "claude-sonnet-4-5-20250929",
        canonicalId: "anthropic/claude-sonnet-4.5",
        displayName: "Claude Sonnet 4.5",
      },
      {
        nativeId: "claude-sonnet-5",
        canonicalId: "anthropic/claude-sonnet-5",
        displayName: "Claude Sonnet 5",
      },
      {
        nativeId: "claude-haiku-4-5-20251001",
        canonicalId: "anthropic/claude-haiku-4.5",
        displayName: "Claude Haiku 4.5",
      },
      // Listed, not reviewed: no canonical id is guessed for it.
      { nativeId: "claude-opus-4-1-20250805", displayName: "Claude Opus 4.1" },
    ]);
    // Requests still use the alias, not the listed snapshot.
    expect(
      anthropicAdapter.toNativeId("anthropic/claude-haiku-4.5"),
    ).toMatchObject({
      nativeId: "claude-haiku-4-5",
    });
  });

  it("reports an answer it stopped paging through as incomplete", async () => {
    const { fetch } = fixtureFetch([
      { match: () => true, fixture: "anthropic-models-page1.json" },
    ]);
    const result = expectOk(
      await anthropicAdapter.listModels(
        { providerKey: "anthropic", apiKey: PLACEHOLDER_KEY },
        deps(fetch),
      ),
    );
    // page1 always says has_more with the same last_id: the loop stops.
    expect(result.complete).toBe(false);
  });

  it("recognizes a dated snapshot of an alias only in the documented shape", () => {
    expect(
      anthropicAdapter.isSnapshotOf?.(
        "claude-opus-4-8-20260101",
        "claude-opus-4-8",
      ),
    ).toBe(true);
    expect(
      anthropicAdapter.isSnapshotOf?.(
        "claude-opus-4-8-fast",
        "claude-opus-4-8",
      ),
    ).toBe(false);
    expect(
      anthropicAdapter.isSnapshotOf?.(
        "claude-opus-4-80-20260101",
        "claude-opus-4-8",
      ),
    ).toBe(false);
  });

  describeListFailures(anthropicAdapter);
});

describe("Google adapter", () => {
  it("pages GET /v1beta/models with the key in a header, generateContent models only", async () => {
    const { fetch, requests } = fixtureFetch([
      {
        match: (url) => !url.searchParams.has("pageToken"),
        fixture: "google-models-page1.json",
      },
      {
        match: (url) => url.searchParams.get("pageToken") === "page-2-token",
        fixture: "google-models-page2.json",
      },
    ]);
    const result = expectOk(
      await googleAdapter.listModels(
        { providerKey: "google", apiKey: PLACEHOLDER_KEY },
        deps(fetch),
      ),
    );
    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
    );
    expect(requests[0].headers["x-goog-api-key"]).toBe(PLACEHOLDER_KEY);
    for (const request of requests) {
      expect(request.url).not.toContain(PLACEHOLDER_KEY);
      expect(new URL(request.url).searchParams.has("key")).toBe(false);
    }
    expect(result.complete).toBe(true);
    expect(result.models).toEqual([
      {
        nativeId: "gemini-2.5-pro",
        canonicalId: "google/gemini-2.5-pro",
        displayName: "Gemini 2.5 Pro",
        contextLength: 1048576,
      },
      {
        nativeId: "gemini-2.5-flash",
        canonicalId: "google/gemini-2.5-flash",
        displayName: "Gemini 2.5 Flash",
        contextLength: 1048576,
      },
    ]);
  });

  describeListFailures(googleAdapter);
});

describe("OpenRouter adapter", () => {
  it("reads /api/v1/models; ids are canonical as-is", async () => {
    const { fetch, requests } = fixtureFetch([
      {
        match: "https://openrouter.ai/api/v1/models",
        fixture: "openrouter-models.json",
      },
    ]);
    const result = expectOk(
      await openrouterAdapter.listModels(
        { providerKey: "openrouter", apiKey: PLACEHOLDER_KEY },
        deps(fetch),
      ),
    );
    expect(requests[0].headers.authorization).toBe(`Bearer ${PLACEHOLDER_KEY}`);
    expect(result.models[0]).toEqual({
      nativeId: "anthropic/claude-sonnet-4.5",
      canonicalId: "anthropic/claude-sonnet-4.5",
      displayName: "Anthropic: Claude Sonnet 4.5",
      contextLength: 1000000,
    });
    expect(result.models.map((m) => m.nativeId)).toEqual([
      "anthropic/claude-sonnet-4.5",
      "z-ai/glm-4.6",
      "openrouter/auto",
    ]);
    expect(openrouterAdapter.toNativeId("z-ai/glm-4.6")).toMatchObject({
      ok: true,
      nativeId: "z-ai/glm-4.6",
    });
    expect(openrouterAdapter.toNativeId("glm-4.6")).toMatchObject({
      ok: false,
      code: "unmapped",
    });
  });

  it("lists without a key (the endpoint is public)", async () => {
    const { fetch, requests } = fixtureFetch([
      { match: () => true, fixture: "openrouter-models.json" },
    ]);
    expectOk(
      await openrouterAdapter.listModels(
        { providerKey: "openrouter" },
        deps(fetch),
      ),
    );
    expect(requests[0].headers.authorization).toBeUndefined();
  });

  describeListFailures(openrouterAdapter);
});

describe("Ollama adapter", () => {
  it.each([
    [undefined, "http://127.0.0.1:11434"],
    ["http://127.0.0.1:11434/api", "http://127.0.0.1:11434"],
    ["https://ollama.example.com/v1/", "https://ollama.example.com"],
    ["http://gpu-box:11434", "http://gpu-box:11434"],
  ])("host root for %s is %s", (baseUrl, root) => {
    expect(ollamaHostRoot(baseUrl)).toBe(root);
  });

  it("reads /api/tags on the host root with no key", async () => {
    const { fetch, requests } = fixtureFetch([
      {
        match: "https://ollama.example.com/api/tags",
        fixture: "ollama-tags.json",
      },
    ]);
    const result = expectOk(
      await ollamaAdapter.listModels(
        { providerKey: "ollama", baseUrl: "https://ollama.example.com/v1" },
        deps(fetch),
      ),
    );
    expect(requests[0].headers.authorization).toBeUndefined();
    expect(result.models).toEqual([
      { nativeId: "llama3.2:latest" },
      { nativeId: "qwen3:8b" },
    ]);
  });

  describeListFailures(ollamaAdapter, { baseUrl: "http://127.0.0.1:11434" });
});

describe.each([
  ["azure", azureAdapter],
  ["bedrock", bedrockAdapter],
  ["custom:groq", customAdapter],
] as const)("%s adapter (configured ids)", (providerKey, adapter) => {
  it("reports the configured ids without calling out", async () => {
    const { fetch, requests } = fixtureFetch([]);
    const result = expectOk(
      await adapter.listModels(
        {
          providerKey,
          apiKey: PLACEHOLDER_KEY,
          configuredModelIds: [" prod-a ", "prod-b", "prod-a", ""],
        },
        deps(fetch),
      ),
    );
    expect(requests).toHaveLength(0);
    expect(result).toEqual({
      ok: true,
      source: "configured",
      models: [{ nativeId: "prod-a" }, { nativeId: "prod-b" }],
      complete: true,
      observedAt: NOW,
    });
  });
});

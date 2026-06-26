import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchHarnessModelCredential } from "../harness-model-credential";

// Inspector → Convex client for the harness BYOK Anthropic credential.

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_URL = process.env.CONVEX_HTTP_URL;

beforeEach(() => {
  process.env.CONVEX_HTTP_URL = "https://convex.example.com";
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  process.env.CONVEX_HTTP_URL = ORIGINAL_URL;
  vi.restoreAllMocks();
});

function mockFetch(impl: (url: string, init: RequestInit) => Response) {
  globalThis.fetch = vi.fn(async (url: any, init: any) =>
    impl(String(url), init as RequestInit)
  ) as unknown as typeof fetch;
}

describe("fetchHarnessModelCredential", () => {
  it("POSTs projectId + modelId with a normalized bearer and returns the credential", async () => {
    let seenUrl = "";
    let seenInit: RequestInit = {};
    mockFetch((url, init) => {
      seenUrl = url;
      seenInit = init;
      return Response.json({
        ok: true,
        credential: { providerKey: "anthropic", apiKey: "sk-ant-1" },
      });
    });

    const result = await fetchHarnessModelCredential({
      projectId: "p1",
      modelId: "anthropic/claude-haiku-4.5",
      bearer: "raw-token",
    });

    expect(seenUrl).toBe(
      "https://convex.example.com/web/harness/model-credential"
    );
    expect((seenInit.headers as Record<string, string>).authorization).toBe(
      "Bearer raw-token"
    );
    expect(JSON.parse(String(seenInit.body))).toEqual({
      projectId: "p1",
      modelId: "anthropic/claude-haiku-4.5",
    });
    expect(result).toEqual({
      ok: true,
      credential: { providerKey: "anthropic", apiKey: "sk-ant-1" },
    });
  });

  it("maps a 422 (no Anthropic key) to ok:false with the friendly error", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: "This project has no Anthropic API key configured.",
          }),
          { status: 422 }
        )
    );
    const result = await fetchHarnessModelCredential({
      projectId: "p1",
      modelId: "anthropic/claude-haiku-4.5",
      bearer: "t",
    });
    expect(result).toEqual({
      ok: false,
      status: 422,
      error: "This project has no Anthropic API key configured.",
    });
  });

  it("maps a network throw to a 502 result", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await fetchHarnessModelCredential({
      projectId: "p1",
      modelId: "anthropic/claude-haiku-4.5",
      bearer: "t",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(502);
  });
});

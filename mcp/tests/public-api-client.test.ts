import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPublicApiClient,
  PublicApiError,
  toQuery,
} from "../src/lib/public-api-client.js";

const ENV = {
  CONVEX_HTTP_URL: "https://convex.example.site",
  INSPECTOR_API_BASE: "https://inspector.example.com",
};

function mockFetchOnce(
  body: unknown,
  init?: { status?: number; json?: boolean }
) {
  const status = init?.status ?? 200;
  const text =
    init?.json === false ? String(body) : JSON.stringify(body ?? null);
  const fetchMock = vi.fn(async () =>
    new Response(text, {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("toQuery", () => {
  it("builds a query string and drops empty/undefined values", () => {
    expect(toQuery({ a: "x", b: 2, c: undefined, d: null, e: "" })).toBe(
      "?a=x&b=2"
    );
  });

  it("returns an empty string when nothing is set", () => {
    expect(toQuery({ a: undefined })).toBe("");
  });
});

describe("PublicApiClient", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("GETs the convex surface at <CONVEX_HTTP_URL>/v1 with a bearer token", async () => {
    const fetchMock = mockFetchOnce({ id: "u_1" });
    const client = createPublicApiClient(ENV, "tok-123");
    const result = await client.get<{ id: string }>("convex", "/me");

    expect(result).toEqual({ id: "u_1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://convex.example.site/v1/me");
    expect(init?.method).toBe("GET");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok-123"
    );
  });

  it("POSTs the inspector surface at <INSPECTOR_API_BASE>/api/v1 with a JSON body", async () => {
    const fetchMock = mockFetchOnce({ items: [] });
    const client = createPublicApiClient(ENV, "tok");
    await client.post("inspector", "/projects/p1/servers/s1/resources/read", {
      uri: "file:///x",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://inspector.example.com/api/v1/projects/p1/servers/s1/resources/read"
    );
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json"
    );
    expect(JSON.parse(init?.body as string)).toEqual({ uri: "file:///x" });
  });

  it("omits the body (and Content-Type) on a bodyless POST", async () => {
    const fetchMock = mockFetchOnce({ items: [] });
    const client = createPublicApiClient(ENV, "tok");
    await client.post("inspector", "/projects/p1/servers/s1/tools");

    const init = fetchMock.mock.calls[0][1];
    expect(init?.body).toBeUndefined();
    expect(
      (init?.headers as Record<string, string>)["Content-Type"]
    ).toBeUndefined();
  });

  it("raises PublicApiError carrying the canonical v1 envelope on non-2xx", async () => {
    mockFetchOnce(
      { code: "NOT_FOUND", message: "Project not found", details: { projectId: "p9" } },
      { status: 404 }
    );
    const client = createPublicApiClient(ENV, "tok");

    await expect(client.get("convex", "/project-servers?projectId=p9")).rejects.toMatchObject(
      {
        name: "PublicApiError",
        code: "NOT_FOUND",
        message: "Project not found",
        status: 404,
        details: { projectId: "p9" },
      }
    );
  });

  it("falls back to a generic error when the body is not JSON", async () => {
    mockFetchOnce("502 Bad Gateway", { status: 502, json: false });
    const client = createPublicApiClient(ENV, "tok");

    const error = await client.get("inspector", "/x").catch((e) => e);
    expect(error).toBeInstanceOf(PublicApiError);
    expect(error.code).toBe("INTERNAL_ERROR");
    expect(error.status).toBe(502);
  });

  it("raises on a 2xx response carrying a non-JSON body", async () => {
    mockFetchOnce("<html>not json</html>", { status: 200, json: false });
    const client = createPublicApiClient(ENV, "tok");
    const error = await client.get("convex", "/me").catch((e) => e);
    expect(error).toBeInstanceOf(PublicApiError);
    expect(error.status).toBe(200);
  });

  it("returns null (never undefined) on an empty 2xx body", async () => {
    mockFetchOnce("", { status: 200, json: false });
    const client = createPublicApiClient(ENV, "tok");
    expect(await client.get("convex", "/me")).toBeNull();
  });
});

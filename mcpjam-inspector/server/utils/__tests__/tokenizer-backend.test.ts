// @vitest-environment node
import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({ HOSTED_MODE: true }));
vi.mock("../../config.js", () => config);
vi.mock("../logger", () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));
import { fetchTokenizerCount } from "../tokenizer-backend.js";
import {
  countToolsTokens,
  estimateTokensFromChars,
} from "../tokenizer-helpers.js";

const nativeFetch = globalThis.fetch;
const TOKEN = "tokenizer-server-only-canary";
const originalElectron = Object.getOwnPropertyDescriptor(
  process.versions,
  "electron",
);
const fetchMock = vi.fn();

beforeEach(() => {
  config.HOSTED_MODE = true;
  vi.stubEnv("CONVEX_HTTP_URL", "https://backend.example");
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", TOKEN);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock
    .mockReset()
    .mockResolvedValue(Response.json({ ok: true, tokenCount: 17 }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (originalElectron)
    Object.defineProperty(process.versions, "electron", originalElectron);
  else delete process.versions.electron;
});

function headers() {
  return new Headers(fetchMock.mock.calls[0][1].headers);
}

describe("tokenizer server credential boundary", () => {
  it("does not follow a real backend redirect or retry it", async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.writeHead(302, { Location: "/credential-recipient" });
      res.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing test port");
      vi.stubEnv("CONVEX_HTTP_URL", `http://127.0.0.1:${address.port}`);
      vi.stubGlobal("fetch", nativeFetch);
      const tools = [{ name: "search" }];
      expect(await countToolsTokens(tools, "gpt-4o")).toBe(
        estimateTokensFromChars(JSON.stringify(tools)),
      );
      expect(requests).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it("authenticates the real tools helper only to the configured backend", async () => {
    expect(await countToolsTokens([{ name: "tool" }], "gpt-4o")).toBe(17);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://backend.example/tokenizer/count",
    );
    expect(headers().get("x-inspector-service-token")).toBe(TOKEN);
    expect(fetchMock.mock.calls[0][1].redirect).toBe("error");
    expect(fetchMock.mock.calls[0][1].body).not.toContain(TOKEN);
  });

  it.each(["local", "self-hosted", "tokenless hosted", "electron", "http"])(
    "keeps %s anonymous",
    async (mode) => {
      if (mode === "local" || mode === "self-hosted")
        config.HOSTED_MODE = false;
      if (mode === "tokenless hosted")
        vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
      if (mode === "electron")
        Object.defineProperty(process.versions, "electron", {
          value: "40.0.0",
          configurable: true,
        });
      if (mode === "http")
        vi.stubEnv("CONVEX_HTTP_URL", "http://localhost:3211");
      expect(await countToolsTokens([{ name: "tool" }], "gpt-4o")).toBe(17);
      expect(headers().has("x-inspector-service-token")).toBe(false);
    },
  );

  it.each([
    "https://user:password@backend.example",
    "https://backend.example/path",
    "https://backend.example?target=attacker",
    "https://backend.example#fragment",
  ])("rejects non-origin backend configuration %s before fetch", (url) => {
    vi.stubEnv("CONVEX_HTTP_URL", url);
    expect(() => fetchTokenizerCount("hello", "openai/gpt-4o")).toThrow(
      "backend origin",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([429, 503, "network"])(
    "estimates once without retries after %s",
    async (failure) => {
      if (failure === "network")
        fetchMock.mockRejectedValue(new TypeError("fetch failed"));
      else
        fetchMock.mockImplementation(
          async () => new Response(null, { status: failure as number }),
        );
      const tools = [{ name: "search", description: "Search documents" }];
      expect(await countToolsTokens(tools, "gpt-4o")).toBe(
        estimateTokensFromChars(JSON.stringify(tools)),
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
});

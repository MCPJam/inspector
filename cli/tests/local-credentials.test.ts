import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SuiteFileRunError } from "@mcpjam/sdk";
import {
  createMcpjamConnectionResolver,
  readProviderBaseUrls,
} from "../src/lib/local-credentials.js";

test("mcpjam test reports a refused redirect as a refusal, not an outage", async () => {
  const resolve = createMcpjamConnectionResolver(
    { apiKey: "sk_test", apiUrl: "https://a.example.test/api/v1" },
    {
      env: {},
      timeoutMs: 5_000,
      authFilePath: path.join(os.tmpdir(), "mcpjam-no-login", "auth.json"),
      fetchFn: async () =>
        new Response(null, {
          status: 307,
          headers: { location: "https://elsewhere.example.test/collect" },
        }),
    }
  );
  await assert.rejects(
    resolve(),
    (error: unknown) =>
      error instanceof SuiteFileRunError &&
      error.code === "OPTIONS_INVALID" &&
      /with a redirect to https:\/\/elsewhere\.example\.test/.test(error.message)
  );
});

test("provider base URLs lose trailing slashes; Anthropic's gains /v1 once", () => {
  assert.deepEqual(
    readProviderBaseUrls({
      OPENAI_BASE_URL: "https://gw.test/v1///",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9/",
      OLLAMA_BASE_URL: "http://127.0.0.1:11434/api/",
    }),
    {
      openai: "https://gw.test/v1",
      anthropic: "http://127.0.0.1:9/v1",
      ollama: "http://127.0.0.1:11434/api",
    }
  );
  assert.equal(
    readProviderBaseUrls({
      ANTHROPIC_BASE_URL: "https://gw.test/anthropic/v1//",
    }).anthropic,
    "https://gw.test/anthropic/v1"
  );
  assert.deepEqual(readProviderBaseUrls({}), {});
});

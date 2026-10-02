import assert from "node:assert/strict";
import test from "node:test";
import {
  appBaseFromApiBase,
  readProviderBaseUrls,
} from "../src/lib/local-credentials.js";

test("appBaseFromApiBase strips trailing slashes, then /api/v1 exactly once", () => {
  assert.equal(
    appBaseFromApiBase("https://app.mcpjam.com/api/v1/"),
    "https://app.mcpjam.com"
  );
  assert.equal(
    appBaseFromApiBase("https://x.test/prefix/api/v1///"),
    "https://x.test/prefix"
  );
  assert.equal(
    appBaseFromApiBase("https://x.test/api/v1/api/v1"),
    "https://x.test/api/v1"
  );
  assert.equal(appBaseFromApiBase("https://x.test"), "https://x.test");
  assert.equal(appBaseFromApiBase("///"), "");
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

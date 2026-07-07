import { test } from "node:test";
import assert from "node:assert/strict";
import { getConfig } from "../src/config.ts";

test("getConfig defaults the canonical URL to the rigged (wrong) value", () => {
  delete process.env.CANONICAL_URL;
  const cfg = getConfig();
  assert.equal(cfg.canonicalUrl, "https://demo.example.com/mcp");
  assert.equal(cfg.port, 8080);
  assert.equal(cfg.trustedIssuer, null);
});

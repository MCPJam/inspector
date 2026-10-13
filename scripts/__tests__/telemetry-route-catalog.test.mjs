import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mountedRoutes } from "../telemetry-route-catalog.mjs";

test("mount graph composes literal route prefixes and methods", () => {
  const rows = mountedRoutes(fileURLToPath(new URL("../../mcpjam-inspector/server/app.ts", import.meta.url)));
  const keys = rows.map(({ method, path }) => `${method} ${path}`);
  assert.ok(keys.includes("POST /api/web/chat-v2"));
  assert.ok(keys.includes("POST /api/web/tools/execute"));
  assert.ok(keys.includes("POST /api/mcp/chat-v2"));
  assert.ok(!keys.includes("POST /chat-v2"));
  assert.ok(rows.every(({ path }) => path.startsWith("/") && !path.includes("://")));
});

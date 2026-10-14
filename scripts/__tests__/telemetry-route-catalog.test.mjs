import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
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

test("diagnostic names include unique sorted events and literal logger messages", () => {
  const catalog = JSON.parse(
    readFileSync(
      new URL("../../mcpjam-inspector/shared/telemetry-catalog.generated.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(catalog.events, [...new Set(catalog.events)].sort());
  assert.ok(catalog.events.every((name) => catalog.messages.includes(name)));
  assert.ok(catalog.messages.includes("[host-runtime-config] network error"));
});

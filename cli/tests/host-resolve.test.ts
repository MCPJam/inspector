import assert from "node:assert/strict";
import test from "node:test";
import type { MCPClientManager, MCPServerConfig } from "@mcpjam/sdk";
import {
  applyHostToConfig,
  applyHostVisibility,
  assertToolVisibleToHost,
  resolveHostConnection,
  resolveHostFromOptions,
} from "../src/lib/host-resolve.js";
import { CliError } from "../src/lib/output.js";

// Mock the duck-typed ToolMetadataSource the visibility helper reads:
// getAllToolsMetadata(serverId) → name → the tool's `_meta` (with `.ui`).
// Enforces the serverId so the server-scoped lookup stays tested.
function mockManager(
  metadata: Record<string, Record<string, unknown>>,
  expectedServerId = "__cli__",
): MCPClientManager {
  return {
    getAllToolsMetadata: (serverId: string) => {
      assert.equal(serverId, expectedServerId);
      return metadata;
    },
  } as unknown as MCPClientManager;
}

// getAllToolsMetadata returns name → the tool's `_meta` (with `.ui` at top
// level) — that's what the visibility helpers read.
const appOnly = { ui: { visibility: ["app"] } };
const modelVisible = {};

test("resolveHostConnection derives Claude's identity + UI capability", () => {
  const h = resolveHostConnection("claude");
  assert.equal(h.connection.clientInfo?.name, "claude-ai");
  const ext = (h.connection.clientCapabilities?.extensions ?? {}) as Record<
    string,
    unknown
  >;
  assert.ok(ext["io.modelcontextprotocol/ui"]);
  assert.notEqual(h.policy.respectToolVisibility, false);
});

test("resolveHostConnection rejects an unknown host", () => {
  assert.throws(() => resolveHostConnection("bogus"), CliError);
});

test("resolveHostFromOptions rejects --host together with --client-capabilities", () => {
  assert.throws(
    () =>
      resolveHostFromOptions({ host: "claude", clientCapabilities: "{}" }),
    CliError,
  );
});

test("resolveHostFromOptions returns undefined without --host", () => {
  assert.equal(resolveHostFromOptions({}), undefined);
});

test("applyHostToConfig merges identity pins onto an http config", () => {
  const base = { url: "https://example.com/mcp" } as MCPServerConfig;
  const merged = applyHostToConfig(
    base,
    resolveHostConnection("claude").connection,
  ) as Record<string, unknown>;
  assert.equal((merged.clientInfo as { name?: string }).name, "claude-ai");
  assert.ok(merged.clientCapabilities);
});

test("applyHostVisibility drops app-only tools for a visibility-respecting host", () => {
  const tools = [
    { name: "open_widget", ...appOnly },
    { name: "search", ...modelVisible },
  ];
  const manager = mockManager({ open_widget: appOnly, search: modelVisible });
  const result = applyHostVisibility(
    tools,
    manager,
    "__cli__",
    resolveHostConnection("claude").policy,
  );
  assert.equal(result.toolsDroppedVisibility, 1);
  assert.deepEqual(
    result.tools.map((t) => t.name),
    ["search"],
  );
});

test("applyHostVisibility keeps app-only tools when the host opts out (cursor)", () => {
  const tools = [{ name: "open_widget", ...appOnly }];
  const manager = mockManager({ open_widget: appOnly });
  const result = applyHostVisibility(
    tools,
    manager,
    "__cli__",
    resolveHostConnection("cursor").policy,
  );
  assert.equal(result.toolsDroppedVisibility, 0);
  assert.equal(result.tools.length, 1);
});

test("assertToolVisibleToHost rejects an app-only call as a visibility-respecting host", () => {
  const claude = resolveHostConnection("claude");
  assert.throws(
    () =>
      assertToolVisibleToHost(
        mockManager({ open_widget: appOnly }),
        "__cli__",
        "open_widget",
        claude,
      ),
    CliError,
  );
  // A model-visible tool is allowed.
  assert.doesNotThrow(() =>
    assertToolVisibleToHost(
      mockManager({ search: modelVisible }),
      "__cli__",
      "search",
      claude,
    ),
  );
  // The host opting out of visibility never rejects.
  assert.doesNotThrow(() =>
    assertToolVisibleToHost(
      mockManager({ open_widget: appOnly }),
      "__cli__",
      "open_widget",
      resolveHostConnection("cursor"),
    ),
  );
});

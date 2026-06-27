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

// Mock the manager surfaces the host helpers use, enforcing the serverId so the
// server-scoped lookups stay tested:
//  - getAllToolsMetadata(serverId) → name → the tool's `_meta` (applyHostVisibility)
//  - listTools(serverId) → { tools: [{ name, _meta }] } (assertToolVisibleToHost,
//    which lists tools itself — executeTool doesn't populate the metadata map).
function mockManager(opts: {
  metadata?: Record<string, Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  expectedServerId?: string;
}): MCPClientManager {
  const expected = opts.expectedServerId ?? "__cli__";
  return {
    getAllToolsMetadata: (serverId: string) => {
      assert.equal(serverId, expected);
      return opts.metadata ?? {};
    },
    listTools: async (serverId: string) => {
      assert.equal(serverId, expected);
      return { tools: opts.tools ?? [], nextCursor: undefined };
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
  const manager = mockManager({
    metadata: { open_widget: appOnly, search: modelVisible },
  });
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
  const manager = mockManager({ metadata: { open_widget: appOnly } });
  const result = applyHostVisibility(
    tools,
    manager,
    "__cli__",
    resolveHostConnection("cursor").policy,
  );
  assert.equal(result.toolsDroppedVisibility, 0);
  assert.equal(result.tools.length, 1);
});

test("assertToolVisibleToHost rejects an app-only call as a visibility-respecting host", async () => {
  const claude = resolveHostConnection("claude");
  // executeTool doesn't list tools, so the check must list them itself — the
  // mock serves listTools, not a pre-populated metadata map.
  await assert.rejects(
    () =>
      assertToolVisibleToHost(
        mockManager({ tools: [{ name: "open_widget", _meta: appOnly }] }),
        "__cli__",
        "open_widget",
        claude,
      ),
    CliError,
  );
  // A model-visible tool is allowed.
  await assert.doesNotReject(() =>
    assertToolVisibleToHost(
      mockManager({ tools: [{ name: "search", _meta: modelVisible }] }),
      "__cli__",
      "search",
      claude,
    ),
  );
  // A tool not in the listed set is allowed (not a listed app-only tool).
  await assert.doesNotReject(() =>
    assertToolVisibleToHost(
      mockManager({ tools: [] }),
      "__cli__",
      "missing",
      claude,
    ),
  );
  // The host opting out of visibility never rejects.
  await assert.doesNotReject(() =>
    assertToolVisibleToHost(
      mockManager({ tools: [{ name: "open_widget", _meta: appOnly }] }),
      "__cli__",
      "open_widget",
      resolveHostConnection("cursor"),
    ),
  );
});

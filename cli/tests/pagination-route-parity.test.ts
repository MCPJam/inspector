import assert from "node:assert/strict";
import test from "node:test";
import type { MCPClientManager } from "@mcpjam/sdk";
import { listPrompts } from "@mcpjam/sdk";

// `mcpjam prompts list --cursor <cursor>` (cli/src/commands/prompts.ts) is a
// DELIBERATE single-page escape hatch, not aggregation: it calls the SDK's
// `listPrompts` operation with whatever cursor the operator passed and
// returns exactly that one page. Auto-paging only happens when `--cursor` is
// omitted (the official beta.4 client aggregates no-cursor list calls under
// the hood). This test locks in the single-page contract at the layer the
// CLI command itself calls, so nobody "fixes" `--cursor` into a full-drain
// loop.
function mockManagerWithPages(
  pages: Record<string, { prompts: unknown[]; nextCursor?: string }>,
): { manager: MCPClientManager; calls: Array<string | undefined> } {
  const calls: Array<string | undefined> = [];
  const manager = {
    listPrompts: async (
      _serverId: string,
      params?: { cursor?: string },
    ) => {
      const cursor = params?.cursor;
      calls.push(cursor);
      const page = pages[cursor ?? "__first__"];
      if (!page) {
        throw new Error(`unexpected cursor ${cursor}`);
      }
      return page;
    },
  } as unknown as MCPClientManager;
  return { manager, calls };
}

test("listPrompts with an explicit --cursor returns exactly one raw page (no auto-drain)", async () => {
  const { manager, calls } = mockManagerWithPages({
    __first__: { prompts: [{ name: "a" }], nextCursor: "page-2" },
    "page-2": { prompts: [{ name: "b" }], nextCursor: "page-3" },
    "page-3": { prompts: [{ name: "c" }] },
  });

  const result = await listPrompts(manager, {
    serverId: "srv",
    cursor: "page-2",
  });

  // Exactly one page back, with its own nextCursor surfaced for the caller
  // to page forward manually — not aggregated into the full list.
  assert.deepEqual(result.prompts, [{ name: "b" }]);
  assert.equal(result.nextCursor, "page-3");

  // The manager was called exactly once, with the cursor the operator
  // passed — no loop.
  assert.deepEqual(calls, ["page-2"]);
});

test("listPrompts without a cursor requests only the first page (raw passthrough, no client-side loop)", async () => {
  const { manager, calls } = mockManagerWithPages({
    __first__: { prompts: [{ name: "a" }], nextCursor: "page-2" },
  });

  const result = await listPrompts(manager, { serverId: "srv" });

  assert.deepEqual(result.prompts, [{ name: "a" }]);
  assert.equal(result.nextCursor, "page-2");
  // Full-aggregate behavior (when the operator omits --cursor) comes from
  // the official SDK client auto-paging inside `manager.listPrompts` itself,
  // not from a loop in this operation — so the operation calls the manager
  // exactly once regardless.
  assert.deepEqual(calls, [undefined]);
});

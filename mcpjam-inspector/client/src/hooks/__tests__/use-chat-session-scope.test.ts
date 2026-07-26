import { describe, expect, it } from "vitest";
import {
  areHostedSessionScopesEqual,
  isSuccessfulRpcResponse,
  rpcMessageId,
  rpcRequestMethod,
} from "../use-chat-session";

// SEP-2350: the chat step-up counter is cleared ONLY when a successful
// `tools/call` response arrives — never on a `tools/list`/`initialize`/ping
// success (all of which fire on the post-OAuth reconnect after a redirect).
// Responses carry no `method`, so the hook correlates the response `id` to a
// previously-seen outgoing `tools/call` request. These two helpers are the
// building blocks of that gate: `rpcRequestMethod` picks out the outgoing
// `tools/call` to track, and `rpcMessageId` provides the correlation key.
describe("tools/call reset correlation helpers (SEP-2350)", () => {
  it("rpcRequestMethod picks out tools/call but not discovery/handshake methods", () => {
    expect(
      rpcRequestMethod({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
    ).toBe("tools/call");
    // A tools/list / initialize / ping success must NOT be treated as a
    // tool invocation — the hook never tracks their ids, so a later success
    // for them can never reset the budget.
    expect(
      rpcRequestMethod({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    ).toBe("tools/list");
    expect(
      rpcRequestMethod({ jsonrpc: "2.0", id: 3, method: "initialize" }),
    ).toBe("initialize");
    // A response frame carries no method, so it can never be mistaken for the
    // request that gates tracking.
    expect(rpcRequestMethod({ jsonrpc: "2.0", id: 1, result: {} })).toBe(
      undefined,
    );
  });

  it("rpcMessageId returns string/number ids and nothing else (correlation key)", () => {
    expect(rpcMessageId({ jsonrpc: "2.0", id: 7, result: {} })).toBe(7);
    expect(rpcMessageId({ jsonrpc: "2.0", id: "abc", result: {} })).toBe("abc");
    // A notification (no id) or a malformed id can't be correlated across the
    // request/response pair, so it never gates a reset.
    expect(rpcMessageId({ jsonrpc: "2.0", method: "notifications/foo" })).toBe(
      undefined,
    );
    expect(rpcMessageId({ jsonrpc: "2.0", id: { nested: true } })).toBe(
      undefined,
    );
    expect(rpcMessageId(null)).toBe(undefined);
  });

  it("a tools/list success is a successful response but is never a tracked tools/call", () => {
    // Demonstrates the gate: isSuccessfulRpcResponse is true for a tools/list
    // reply, yet because only tools/call request ids are tracked, its id is
    // never in the pending set — so it cannot reset the budget.
    const toolsListResponse = { jsonrpc: "2.0", id: 42, result: { tools: [] } };
    expect(isSuccessfulRpcResponse(toolsListResponse)).toBe(true);
    // The correlated request was a tools/list, which the hook never records.
    expect(
      rpcRequestMethod({ jsonrpc: "2.0", id: 42, method: "tools/list" }),
    ).not.toBe("tools/call");
  });
});

// PR3 (Claude Code harness host): switching the previewed host in the Playground
// must FORK the session — otherwise turns under host B append onto host A's
// transcript while resolving against B (mis-attribution). The chat-reset path
// keys off this comparison, so hostId must be a scope dimension.
describe("areHostedSessionScopesEqual — host switch forks the session", () => {
  const base = { projectId: "p1", chatboxId: undefined, hostId: "host-a" };

  it("treats a different previewed hostId as a different scope (⇒ reset)", () => {
    expect(areHostedSessionScopesEqual(base, { ...base, hostId: "host-b" })).toBe(
      false
    );
  });

  it("treats identical scope as equal (⇒ keep the conversation)", () => {
    expect(areHostedSessionScopesEqual(base, { ...base })).toBe(true);
  });

  it("a different project forks; a different chatbox forks", () => {
    expect(
      areHostedSessionScopesEqual(base, { ...base, projectId: "p2" })
    ).toBe(false);
    expect(
      areHostedSessionScopesEqual(base, { ...base, chatboxId: "cbx" })
    ).toBe(false);
  });

  it("does not consider accessVersion (not part of the scope shape)", () => {
    // Only the three identity dims matter — an accessVersion bump elsewhere
    // keeps the same scope and must not tear down the chat.
    expect(
      areHostedSessionScopesEqual(
        { projectId: "p1", hostId: "h" },
        { projectId: "p1", hostId: "h" }
      )
    ).toBe(true);
  });
});

// SEP-2350: the chat step-up counter is cleared when a SUCCESSFUL JSON-RPC
// response arrives from a server in the traffic log. This predicate is the
// success/error gate — an error reply must never clear the bounded budget.
describe("isSuccessfulRpcResponse — chat step-up reset gate", () => {
  it("treats a response carrying result as success", () => {
    expect(
      isSuccessfulRpcResponse({ jsonrpc: "2.0", id: 1, result: { ok: true } })
    ).toBe(true);
  });

  it("rejects a JSON-RPC error reply", () => {
    expect(
      isSuccessfulRpcResponse({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: "insufficient_scope" },
      })
    ).toBe(false);
  });

  it("rejects a message with neither result nor error (e.g. a request)", () => {
    expect(
      isSuccessfulRpcResponse({ jsonrpc: "2.0", id: 1, method: "tools/call" })
    ).toBe(false);
  });

  it("rejects non-object messages", () => {
    expect(isSuccessfulRpcResponse(null)).toBe(false);
    expect(isSuccessfulRpcResponse("result")).toBe(false);
    expect(isSuccessfulRpcResponse(undefined)).toBe(false);
  });
});

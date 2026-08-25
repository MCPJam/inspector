/**
 * The authoritative half of D4b's accounting: the proxy's own report of a call
 * it refused, correlated to the turn that configured the `.mcp.json` entry.
 * Needed because the real Claude Code adapter flattens the result and drops the
 * `_meta` marker, so the block cannot be recovered from the payload alone.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  __resetHarnessPolicyBlockChannelForTests,
  buildCrossInstanceHarnessPolicyBlockMessage,
  consumeCrossInstanceHarnessPolicyBlockMessage,
  publishHarnessPolicyBlock,
  subscribeHarnessPolicyBlocks,
  type HarnessPolicyBlockEvent,
} from "../harness-policy-block-channel.js";

const TURN_A = "11111111-1111-4111-8111-111111111111";
const TURN_B = "22222222-2222-4222-8222-222222222222";

const event = (over: Partial<HarnessPolicyBlockEvent> = {}) =>
  ({
    serverId: "srv-a",
    toolName: "delete_repo",
    reason: "denyList",
    classification: "destructive",
    at: 123,
    ...over,
  }) satisfies HarnessPolicyBlockEvent;

describe("harness policy block channel", () => {
  beforeEach(() => {
    __resetHarnessPolicyBlockChannelForTests();
  });

  it("delivers to the turn that owns the correlation id", () => {
    const seen: HarnessPolicyBlockEvent[] = [];
    subscribeHarnessPolicyBlocks(TURN_A, (e) => seen.push(e), ["srv-a"]);
    expect(publishHarnessPolicyBlock(TURN_A, event())).toBe(true);
    expect(seen).toEqual([event()]);
  });

  it("never attributes a block to another turn or another server", () => {
    // A misattributed block is measurement on the wrong iteration — worse than
    // a missing one, which is why this channel has no single-live-turn fallback.
    const seen: HarnessPolicyBlockEvent[] = [];
    subscribeHarnessPolicyBlocks(TURN_A, (e) => seen.push(e), ["srv-a"]);
    expect(publishHarnessPolicyBlock(TURN_B, event())).toBe(false);
    expect(
      publishHarnessPolicyBlock(TURN_A, event({ serverId: "srv-z" }))
    ).toBe(false);
    expect(publishHarnessPolicyBlock(undefined, event())).toBe(false);
    expect(seen).toEqual([]);
  });

  it("stops delivering once the turn disposes its subscription", () => {
    const seen: HarnessPolicyBlockEvent[] = [];
    const stop = subscribeHarnessPolicyBlocks(TURN_A, (e) => seen.push(e), [
      "srv-a",
    ]);
    stop();
    expect(publishHarnessPolicyBlock(TURN_A, event())).toBe(false);
    expect(seen).toEqual([]);
  });

  it("round-trips through the cross-replica control frame", () => {
    const seen: HarnessPolicyBlockEvent[] = [];
    subscribeHarnessPolicyBlocks(TURN_A, (e) => seen.push(e), ["srv-a"]);
    const message = buildCrossInstanceHarnessPolicyBlockMessage(
      TURN_A,
      event()
    );
    expect(message).toBeDefined();
    expect(consumeCrossInstanceHarnessPolicyBlockMessage(message)).toBe(true);
    expect(seen).toEqual([event()]);
  });

  it("consumes a malformed frame of ours, and leaves other frames alone", () => {
    const message = buildCrossInstanceHarnessPolicyBlockMessage(
      TURN_A,
      event()
    );
    // Our marker with a reason outside the vocabulary: consumed (so it is never
    // rendered as a JSON-RPC frame in the Logs panel) but not delivered.
    const seen: HarnessPolicyBlockEvent[] = [];
    subscribeHarnessPolicyBlocks(TURN_A, (e) => seen.push(e), ["srv-a"]);
    expect(
      consumeCrossInstanceHarnessPolicyBlockMessage({
        ...message,
        event: { ...event(), reason: "made-up" },
      })
    ).toBe(true);
    expect(seen).toEqual([]);
    // A real JSON-RPC frame must pass through untouched.
    expect(
      consumeCrossInstanceHarnessPolicyBlockMessage({
        jsonrpc: "2.0",
        id: 1,
        result: {},
      })
    ).toBe(false);
    expect(consumeCrossInstanceHarnessPolicyBlockMessage(undefined)).toBe(false);
  });
});

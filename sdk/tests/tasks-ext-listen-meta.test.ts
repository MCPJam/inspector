/**
 * The `subscriptions/listen` declaration seam
 * (`src/mcp-client-manager/tasks-ext-listen-meta.ts`).
 *
 * These run against a REAL upstream `Client`, not a stand-in, because the whole
 * point is the interaction with upstream's private envelope member. If a client
 * bump moves or renames it, or makes `listen()`'s prologue asynchronous, these
 * fail — which is the alarm the module exists to raise.
 */

import { describe, expect, it, vi } from "vitest";
import { Client, CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/client";
import {
  TasksExtListenMetaSeamError,
  resolveListenMetaTarget,
  withTasksExtensionEnvelope,
} from "../src/mcp-client-manager/tasks-ext-listen-meta.js";

const TASKS_EXT = "io.modelcontextprotocol/tasks";
const ENVELOPE_MEMBER = "_outboundMetaEnvelope";

function realClient(): Client {
  return new Client(
    { name: "test", version: "0.0.0" },
    { capabilities: { elicitation: {}, roots: {} } }
  );
}

/** Reads the envelope the way `listen()` does: synchronously, via the member. */
function readEnvelope(client: Client): Record<string, unknown> | undefined {
  return (
    client as unknown as {
      _outboundMetaEnvelope(): Record<string, unknown> | undefined;
    }
  )._outboundMetaEnvelope();
}

describe("seam presence", () => {
  it("the private member upstream builds its listen params from is still there", () => {
    const client = realClient();
    expect(
      typeof (client as unknown as Record<string, unknown>)[ENVELOPE_MEMBER]
    ).toBe("function");
  });
});

describe("declaration injection", () => {
  it("merges the tasks extension into the capabilities the call reads", async () => {
    const client = realClient();
    let seen: Record<string, unknown> | undefined;

    await withTasksExtensionEnvelope(
      client,
      { elicitation: {}, roots: {} },
      async () => {
        seen = readEnvelope(client);
      }
    );

    const capabilities = seen?.[CLIENT_CAPABILITIES_META_KEY] as
      | { extensions?: Record<string, unknown>; elicitation?: unknown; roots?: unknown }
      | undefined;
    expect(capabilities?.extensions?.[TASKS_EXT]).toEqual({});
    // Unrelated declared capabilities survive: this widens the envelope, it
    // does not replace it.
    expect(capabilities?.elicitation).toBeDefined();
    expect(capabilities?.roots).toBeDefined();
  });

  it("preserves an unrelated extension the caller already declared", async () => {
    const client = realClient();
    let seen: Record<string, unknown> | undefined;

    await withTasksExtensionEnvelope(
      client,
      { extensions: { "com.example/other": { a: 1 } } } as never,
      async () => {
        seen = readEnvelope(client);
      }
    );

    const extensions = (
      seen?.[CLIENT_CAPABILITIES_META_KEY] as { extensions?: Record<string, unknown> }
    )?.extensions;
    expect(extensions?.["com.example/other"]).toEqual({ a: 1 });
    expect(extensions?.[TASKS_EXT]).toEqual({});
  });

  it("restores the envelope before anything else can observe it", async () => {
    const client = realClient();
    let inside: Record<string, unknown> | undefined;

    await withTasksExtensionEnvelope(client, {}, async () => {
      inside = readEnvelope(client);
    });

    const after = readEnvelope(client);
    const capsInside = inside?.[CLIENT_CAPABILITIES_META_KEY] as
      | { extensions?: Record<string, unknown> }
      | undefined;
    const capsAfter = after?.[CLIENT_CAPABILITIES_META_KEY] as
      | { extensions?: Record<string, unknown> }
      | undefined;

    expect(capsInside?.extensions?.[TASKS_EXT]).toEqual({});
    // The next request on this client is NOT declared. This is what keeps the
    // opt-in per-request rather than connection-wide.
    expect(capsAfter?.extensions?.[TASKS_EXT]).toBeUndefined();
    expect(
      Object.prototype.hasOwnProperty.call(client, ENVELOPE_MEMBER)
    ).toBe(false);
  });

  it("restores the envelope when the call throws synchronously", () => {
    const client = realClient();
    expect(() =>
      withTasksExtensionEnvelope(client, {}, () => {
        throw new Error("boom");
      })
    ).toThrow("boom");
    expect(
      Object.prototype.hasOwnProperty.call(client, ENVELOPE_MEMBER)
    ).toBe(false);
  });

  it("restores the envelope when the call rejects", async () => {
    const client = realClient();
    await expect(
      withTasksExtensionEnvelope(client, {}, async () => {
        throw new Error("late boom");
      })
    ).rejects.toThrow("late boom");
    expect(
      Object.prototype.hasOwnProperty.call(client, ENVELOPE_MEMBER)
    ).toBe(false);
  });
});

describe("fail loud", () => {
  it("throws rather than silently sending undeclared when the member is gone", () => {
    const fake = {} as unknown as Client;
    expect(() => withTasksExtensionEnvelope(fake, {}, async () => 1)).toThrow(
      TasksExtListenMetaSeamError
    );
  });

  it("throws when the member is no longer a function", () => {
    const fake = { [ENVELOPE_MEMBER]: "moved" } as unknown as Client;
    expect(() => withTasksExtensionEnvelope(fake, {}, async () => 1)).toThrow(
      /not a function/
    );
  });

  it("rejects when the call never read the envelope — an undeclared request on the wire", async () => {
    const client = realClient();
    const call = vi.fn(async () => "sent");
    // Simulates upstream moving the request literal below an `await`, or
    // dropping the envelope from listen entirely. Either way the declaration
    // did not reach the wire, and a conforming server would answer -32003.
    await expect(
      withTasksExtensionEnvelope(client, {}, call)
    ).rejects.toThrow(TasksExtListenMetaSeamError);
    expect(call).toHaveBeenCalled();
  });
});

describe("target resolution", () => {
  it("finds the upstream client through a delegation chain", () => {
    const client = realClient();
    const chained = { inner: { inner: client } };
    expect(resolveListenMetaTarget(chained)).toBe(client);
  });

  it("returns undefined for a test double with no client in the chain", () => {
    expect(resolveListenMetaTarget({ inner: { inner: {} } })).toBeUndefined();
  });

  it("terminates on a self-referential chain instead of hanging", () => {
    const loop: { inner?: unknown } = {};
    loop.inner = loop;
    expect(resolveListenMetaTarget(loop)).toBeUndefined();
  });
});

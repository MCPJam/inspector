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
    // did not reach the wire, and a conforming server would answer -32021.
    await expect(
      withTasksExtensionEnvelope(client, {}, call)
    ).rejects.toThrow(TasksExtListenMetaSeamError);
    expect(call).toHaveBeenCalled();
  });

  it("disposes what the unread call produced, so a seam failure cannot leak a subscription", async () => {
    const client = realClient();
    // `listen()` resolves only after the server's ack, so by the time the seam
    // check runs the subscription is LIVE. The caller only ever sees the
    // rejection, so nothing else can close it.
    const handle = { close: vi.fn(async () => {}) };
    await expect(
      withTasksExtensionEnvelope(
        client,
        {},
        async () => handle,
        (value) => value.close()
      )
    ).rejects.toThrow(TasksExtListenMetaSeamError);
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("still reports the seam failure when disposal itself fails", async () => {
    const client = realClient();
    await expect(
      withTasksExtensionEnvelope(
        client,
        {},
        async () => "handle",
        () => {
          throw new Error("close failed");
        }
      )
    ).rejects.toThrow(TasksExtListenMetaSeamError);
  });

  it("does not dispose the value when the declaration DID reach the call", async () => {
    const client = realClient();
    const dispose = vi.fn();
    await expect(
      withTasksExtensionEnvelope(
        client,
        {},
        async () => {
          readEnvelope(client);
          return "handle";
        },
        dispose
      )
    ).resolves.toBe("handle");
    expect(dispose).not.toHaveBeenCalled();
  });
});

/**
 * The claim the whole module rests on: `listen()`'s prologue reads the outbound
 * envelope SYNCHRONOUSLY, before its first `await`, so a shadow installed and
 * removed around the call reaches that one request and nothing else.
 *
 * Every other test here reads the envelope through the private member by hand.
 * That verifies the shadow, not the claim — a client bump that moved the
 * request literal below an `await` would leave all of them green and break
 * only production. So this one drives a REAL `client.listen()` over a transport
 * that captures the frame, and asserts on what actually went out.
 */
describe("the declaration on a real subscriptions/listen frame", () => {
  const MODERN_PROTOCOL_VERSION = "2026-07-28";
  const SUBSCRIPTION_ID_META_KEY = "io.modelcontextprotocol/subscriptionId";

  type Frame = Record<string, any>;

  /** Captures every outgoing frame and acknowledges any listen. */
  class CapturingTransport {
    onmessage?: (message: Frame) => void;
    onclose?: () => void;
    onerror?: (error: Error) => void;
    readonly sent: Frame[] = [];

    async start(): Promise<void> {}

    async send(message: Frame): Promise<void> {
      this.sent.push(message);
      if (message.method === "subscriptions/listen") {
        queueMicrotask(() =>
          this.onmessage?.({
            jsonrpc: "2.0",
            method: "notifications/subscriptions/acknowledged",
            params: {
              _meta: { [SUBSCRIPTION_ID_META_KEY]: message.id },
              notifications: message.params?.notifications ?? {},
            },
          })
        );
      }
    }

    async close(): Promise<void> {
      this.onclose?.();
    }

    setProtocolVersion(_version: string): void {}
  }

  async function connected(): Promise<{
    client: Client;
    transport: CapturingTransport;
  }> {
    const client = realClient();
    const transport = new CapturingTransport();
    // `connect({ prior })` is the public zero-round-trip modern connect: it
    // establishes the 2026-07-28 era from a supplied `DiscoverResult` with no
    // handshake, which is all `listen()`'s era gate needs. Nothing private is
    // touched to get here.
    //
    // Client 2.0.0 made the blob era-discriminated (`validatePrior`): the
    // verdict is the `kind`, and the `DiscoverResult` moved under `discover`
    // so a corrupt blob can never era-choose by shape alone. `discover` is
    // schema-parsed, and that schema has no `serverInfo` — 2026 identity is
    // `_meta`-stamped per result (spec PR #3002), not a discover member.
    await client.connect(transport as never, {
      prior: {
        kind: "modern",
        discover: {
          supportedVersions: [MODERN_PROTOCOL_VERSION],
          capabilities: {},
        },
      } as never,
    });
    return { client, transport };
  }

  function listenFrame(transport: CapturingTransport): Frame | undefined {
    return transport.sent.find((m) => m.method === "subscriptions/listen");
  }

  it("puts BOTH the eligibility declaration and the extension's taskIds on the wire", async () => {
    const { client, transport } = await connected();

    const handle = await withTasksExtensionEnvelope(
      client,
      { elicitation: {}, roots: {} },
      () =>
        (
          client as unknown as {
            listen(filter: unknown): Promise<{ close(): Promise<void> }>;
          }
        ).listen({ taskIds: ["task-1", "task-2"], toolsListChanged: true })
    );

    const frame = listenFrame(transport);
    expect(frame).toBeDefined();

    // 1. The per-request eligibility declaration. Without it a conforming
    //    server MUST answer -32021.
    const capabilities = frame?.params?._meta?.[CLIENT_CAPABILITIES_META_KEY];
    expect(capabilities?.extensions?.[TASKS_EXT]).toEqual({});
    // The client's own declared capabilities survive the merge.
    expect(capabilities?.elicitation).toEqual({});

    // 2. The extension-only filter member. `taskIds` is not in upstream's
    //    `SubscriptionFilter` type; this pins that upstream still forwards the
    //    filter verbatim rather than stripping unknown members.
    expect(frame?.params?.notifications?.taskIds).toEqual(["task-1", "task-2"]);
    expect(frame?.params?.notifications?.toolsListChanged).toBe(true);

    await handle.close();
    await client.close();
  });

  it("leaves the NEXT request on the same connection undeclared", async () => {
    const { client, transport } = await connected();

    const handle = await withTasksExtensionEnvelope(client, {}, () =>
      (
        client as unknown as {
          listen(filter: unknown): Promise<{ close(): Promise<void> }>;
        }
      ).listen({ taskIds: ["task-1"] })
    );
    await handle.close();

    const second = await (
      client as unknown as {
        listen(filter: unknown): Promise<{ close(): Promise<void> }>;
      }
    ).listen({ toolsListChanged: true });

    const frames = transport.sent.filter(
      (m) => m.method === "subscriptions/listen"
    );
    expect(frames).toHaveLength(2);
    expect(
      frames[1].params?._meta?.[CLIENT_CAPABILITIES_META_KEY]?.extensions?.[
        TASKS_EXT
      ]
    ).toBeUndefined();

    await second.close();
    await client.close();
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

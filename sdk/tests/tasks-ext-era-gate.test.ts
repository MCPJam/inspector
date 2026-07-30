/**
 * The `io.modelcontextprotocol/tasks` era-gate shadow
 * (`src/mcp-client-manager/tasks-ext-era-gate.ts`).
 *
 * These tests drive the REAL upstream gate: they install the shadow on a real
 * `Client` and then invoke the shadowed member with codec stand-ins carrying
 * the two real `era` strings (`rev2025Codec.era` / `rev2026Codec.era`) and the
 * codec's own `hasRequestMethod` answer. The delegation cases therefore run
 * upstream's actual `isSpecRequestMethod` check rather than a stub of it.
 *
 * They also pin WHEN the shadow goes on: never at construction/connect, always
 * on the first extension tasks operation, so a client build that moved the
 * private member can only ever break tasks — not every connection.
 */

import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import {
  TasksExtEraGateSeamError,
  installTasksExtensionEraGateShadow,
} from "../src/mcp-client-manager/tasks-ext-era-gate.js";
import {
  TasksExtRequestMethods,
  cancelTaskExt,
  getTaskExt,
} from "../src/mcp-client-manager/tasks-ext.js";
import {
  createManagedMcpClient,
  wrapLegacyClient,
} from "../src/mcp-client-manager/managed-mcp-client-factory.js";
import { OfficialSdkClientAdapter } from "../src/mcp-client-manager/official-sdk-client-adapter.js";
import { LogLevelMetaClient } from "../src/mcp-client-manager/log-level-meta-client.js";
import type { ManagedMcpClient } from "../src/mcp-client-manager/managed-mcp-client.js";

const MODERN_ERA = "2026-07-28";
const LEGACY_ERA = "2025-11-25";
const GATE = "_assertOutboundRequestInEra";

type Gate = (codec: { era: string }, method: string) => void;

/** A real client with the shadow installed, plus a handle on the gate. */
function shadowedClient(): { client: Client; gate: Gate } {
  const client = new Client({ name: "test", version: "0.0.0" }, {});
  installTasksExtensionEraGateShadow(client);
  const gate = (client as unknown as Record<string, unknown>)[GATE] as Gate;
  return { client, gate: (codec, method) => gate.call(client, codec, method) };
}

/**
 * A codec stand-in. `hasRequestMethod` mirrors the real registries for the
 * methods under test: the 2026 registry has no `tasks/*` at all, and the 2025
 * registry has `tasks/get|result|list|cancel` but not `tasks/update`.
 */
function codecFor(era: string) {
  const inEra =
    era === MODERN_ERA
      ? new Set<string>(["tools/call"])
      : new Set<string>([
          "tools/call",
          "tasks/get",
          "tasks/result",
          "tasks/list",
          "tasks/cancel",
        ]);
  return { era, hasRequestMethod: (method: string) => inEra.has(method) };
}

describe("tasks extension era-gate shadow", () => {
  it("exempts exactly the three extension methods on the 2026-07-28 era", () => {
    const { gate } = shadowedClient();
    for (const method of TasksExtRequestMethods) {
      expect(() => gate(codecFor(MODERN_ERA), method)).not.toThrow();
    }
    expect(TasksExtRequestMethods).toEqual([
      "tasks/get",
      "tasks/update",
      "tasks/cancel",
    ]);
  });

  it("still era-gates a NON-tasks method deleted from the 2026 era", () => {
    const { gate } = shadowedClient();
    // `tasks/list` is a 2025-registry member with no extension counterpart, so
    // it must keep dying locally — the shadow is not a blanket bypass.
    expect(() => gate(codecFor(MODERN_ERA), "tasks/list")).toThrow(
      /not supported by the negotiated protocol version/
    );
    expect(() => gate(codecFor(MODERN_ERA), "tasks/result")).toThrow(
      /not supported by the negotiated protocol version/
    );
  });

  it("is inert on the legacy era — every method delegates", () => {
    const { gate } = shadowedClient();
    const legacy = codecFor(LEGACY_ERA);
    // In-era on 2025-11-25: allowed, exactly as upstream would.
    expect(() => gate(legacy, "tasks/get")).not.toThrow();
    expect(() => gate(legacy, "tasks/cancel")).not.toThrow();
    expect(() => gate(legacy, "tools/call")).not.toThrow();
    // A method the legacy codec does not define is still refused there: the
    // shadow never returns early off the modern era.
    expect(() =>
      gate({ era: LEGACY_ERA, hasRequestMethod: () => false } as never, "tasks/get")
    ).toThrow(/not supported by the negotiated protocol version/);
  });

  it("leaves an unknown extension method era-blind (upstream behavior)", () => {
    const { gate } = shadowedClient();
    // Not in either registry → not a spec method → never gated, by upstream.
    expect(() => gate(codecFor(MODERN_ERA), "io.example/whatever")).not.toThrow();
  });

  it("installs an own property and is idempotent", () => {
    const client = new Client({ name: "test", version: "0.0.0" }, {});
    const target = client as unknown as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(target, GATE)).toBe(false);

    installTasksExtensionEraGateShadow(client);
    const first = target[GATE];
    installTasksExtensionEraGateShadow(client);
    expect(target[GATE]).toBe(first);
  });

  it("is NOT installed by the factory, but IS by the first extension call", async () => {
    const managed = createManagedMcpClient({
      clientInfo: { name: "test", version: "0.0.0" },
      clientOptions: {},
    });
    const inner = (managed as unknown as { inner: Record<string, unknown> })
      .inner;
    // Lazy: building (and connecting) a client never touches the private
    // member — see the module comment on blast radius.
    expect(Object.prototype.hasOwnProperty.call(inner, GATE)).toBe(false);

    // The extension call itself fails (no transport), but only after the
    // shadow is on: the install happens before anything reaches the wire.
    await expect(
      getTaskExt({ client: managed, declaredCapabilities: undefined }, "t")
    ).rejects.toThrow();
    expect(Object.prototype.hasOwnProperty.call(inner, GATE)).toBe(true);
  });

  describe("resolving the instance to shadow", () => {
    const hasGate = (target: object) =>
      Object.prototype.hasOwnProperty.call(target, GATE);

    it("shadows an adapter built WITHOUT the factory", async () => {
      // The previously-broken case: nothing registered this pairing, so the
      // lookup used to no-op and upstream's gate went on to refuse the send.
      const client = new Client({ name: "test", version: "0.0.0" }, {});
      const adapter = new OfficialSdkClientAdapter(client);
      expect(hasGate(client)).toBe(false);

      await expect(
        getTaskExt({ client: adapter, declaredCapabilities: undefined }, "t")
      ).rejects.toThrow();
      expect(hasGate(client)).toBe(true);
    });

    it("walks a decorator chain over an unregistered adapter", async () => {
      const client = new Client({ name: "test", version: "0.0.0" }, {});
      const decorated = new LogLevelMetaClient(
        new OfficialSdkClientAdapter(client),
        () => "warning"
      );

      await expect(
        getTaskExt({ client: decorated, declaredCapabilities: undefined }, "t")
      ).rejects.toThrow();
      expect(hasGate(client)).toBe(true);
    });

    it("stays a silent no-op for a double with no upstream client", async () => {
      // Nothing in the chain is a client, so there is no era gate to shadow —
      // that must not be confused with a moved seam.
      const double = {
        requestWithSchema: async () => ({}),
      } as unknown as ManagedMcpClient;
      await expect(
        cancelTaskExt({ client: double, declaredCapabilities: undefined }, "t")
      ).resolves.toEqual({});
    });

    it("terminates on a self-referential delegation chain", async () => {
      const looped: Record<string, unknown> = {
        requestWithSchema: async () => ({}),
      };
      looped.inner = looped;
      await expect(
        cancelTaskExt(
          {
            client: looped as unknown as ManagedMcpClient,
            declaredCapabilities: undefined,
          },
          "t"
        )
      ).resolves.toEqual({});
    });
  });

  describe("a client whose seam is missing", () => {
    /**
     * Stands in for a future `@modelcontextprotocol/client` that renamed
     * `_assertOutboundRequestInEra`: everything else works, the private member
     * is simply not there.
     */
    function seamlessClient() {
      const sent: string[] = [];
      const stub = {
        listTools: async () => {
          sent.push("tools/list");
          return { tools: [] };
        },
        request: async (req: { method: string }) => {
          sent.push(req.method);
          return {};
        },
      };
      return {
        managed: wrapLegacyClient(stub as unknown as Client),
        sent,
      };
    }

    it("still wraps and still serves non-tasks traffic", async () => {
      const { managed, sent } = seamlessClient();
      // Wrapping did not throw. Neither does an ordinary request: a server
      // that never speaks the extension is unaffected by a moved seam.
      await expect(managed.listTools()).resolves.toEqual({ tools: [] });
      expect(sent).toEqual(["tools/list"]);
    });

    it("fails loudly on a tasks operation, before anything is sent", async () => {
      const { managed, sent } = seamlessClient();
      await expect(
        getTaskExt({ client: managed, declaredCapabilities: undefined }, "t")
      ).rejects.toBeInstanceOf(TasksExtEraGateSeamError);
      await expect(
        cancelTaskExt({ client: managed, declaredCapabilities: undefined }, "t")
      ).rejects.toThrow(/_assertOutboundRequestInEra/);
      expect(sent).toEqual([]);
    });
  });

  describe("fail-loud when the upstream seam moves", () => {
    it("throws when the member is absent (renamed or removed)", () => {
      // Simulates a client bump that renamed `_assertOutboundRequestInEra`.
      const renamed = { _assertOutboundRequestInWireEra: () => {} };
      expect(() =>
        installTasksExtensionEraGateShadow(renamed as unknown as Client)
      ).toThrow(TasksExtEraGateSeamError);
      expect(() =>
        installTasksExtensionEraGateShadow(renamed as unknown as Client)
      ).toThrow(/_assertOutboundRequestInEra/);
    });

    it("throws when the member is no longer a function", () => {
      const notAFunction = { _assertOutboundRequestInEra: "nope" };
      expect(() =>
        installTasksExtensionEraGateShadow(notAFunction as unknown as Client)
      ).toThrow(/not a function/);
    });

    it("names the tasks methods and the verified client version", () => {
      let message = "";
      try {
        installTasksExtensionEraGateShadow({} as unknown as Client);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("tasks/get, tasks/update, tasks/cancel");
      expect(message).toContain("2.0.0");
      expect(message).toContain(MODERN_ERA);
    });
  });
});

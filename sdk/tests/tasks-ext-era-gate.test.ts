/**
 * The `io.modelcontextprotocol/tasks` era-gate shadow
 * (`src/mcp-client-manager/tasks-ext-era-gate.ts`).
 *
 * These tests drive the REAL upstream gate: they install the shadow on a real
 * `Client` and then invoke the shadowed member with codec stand-ins carrying
 * the two real `era` strings (`rev2025Codec.era` / `rev2026Codec.era`) and the
 * codec's own `hasRequestMethod` answer. The delegation cases therefore run
 * upstream's actual `isSpecRequestMethod` check rather than a stub of it.
 */

import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import {
  TasksExtEraGateSeamError,
  installTasksExtensionEraGateShadow,
} from "../src/mcp-client-manager/tasks-ext-era-gate.js";
import { TasksExtRequestMethods } from "../src/mcp-client-manager/tasks-ext.js";
import { createManagedMcpClient } from "../src/mcp-client-manager/managed-mcp-client-factory.js";

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

  it("is installed by the managed-client factory", () => {
    const managed = createManagedMcpClient({
      clientInfo: { name: "test", version: "0.0.0" },
      clientOptions: {},
    });
    const inner = (managed as unknown as { inner: Record<string, unknown> })
      .inner;
    expect(Object.prototype.hasOwnProperty.call(inner, GATE)).toBe(true);
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
      expect(message).toContain("2.0.0-beta.4");
      expect(message).toContain(MODERN_ERA);
    });
  });
});

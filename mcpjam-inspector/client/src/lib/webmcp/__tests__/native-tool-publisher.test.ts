/**
 * Publishing MCPJam's UI tools to a browser-native WebMCP agent.
 *
 * `FakeModelContext` below is not a convenient stub: it encodes what the
 * pinned Chromium 151.0.7922.34 actually does, as probed while this was
 * written — `registerTool` is async, a duplicate name REJECTS, aborting the
 * registration's signal is the only unregister and removes only that
 * registration, and an invocation for an unregistered name is rejected by the
 * browser rather than reaching the page. A test that passed against a friendlier
 * fake would prove nothing about the browser people use.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const trackMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics", () => ({ track: trackMock }));

import { startNativeUiToolPublisher } from "../native-tool-publisher";
import type { NativeToolDescriptor } from "../native-model-context";
import { buildUiToolsCatalog } from "../ui-tools-catalog";
import { listDeferredUiToolCalls } from "../ui-tool-executor";
import {
  useUiToolsRegistry,
  type UiToolDefinition,
} from "../ui-tools-registry";

class FakeModelContext {
  /** Live registrations, exactly as the browser would hold them. */
  readonly tools = new Map<string, NativeToolDescriptor>();
  /** Every registerTool call, in order, including the ones that reject. */
  readonly attempts: string[] = [];
  /** Registrations held open until the test releases them, by name. */
  private readonly gates = new Map<string, Promise<void>>();

  /** Make the next registration of `name` pend until the returned fn runs. */
  gate(name: string): () => void {
    let release!: () => void;
    this.gates.set(
      name,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return release;
  }

  async registerTool(
    descriptor: NativeToolDescriptor,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    this.attempts.push(descriptor.name);
    const gate = this.gates.get(descriptor.name);
    if (gate) {
      this.gates.delete(descriptor.name);
      await gate;
    }
    // Aborted before the platform got to it: nothing is registered.
    if (options?.signal?.aborted) return;
    if (this.tools.has(descriptor.name)) {
      const error = new Error("Duplicate tool name");
      error.name = "InvalidStateError";
      throw error;
    }
    this.tools.set(descriptor.name, descriptor);
    options?.signal?.addEventListener(
      "abort",
      () => {
        // Only THIS registration is removed — a later registration of the
        // same name survives its predecessor's teardown.
        if (this.tools.get(descriptor.name) === descriptor) {
          this.tools.delete(descriptor.name);
        }
      },
      { once: true },
    );
  }

  names(): string[] {
    return [...this.tools.keys()].sort();
  }

  /** What an external agent does: invoke a tool the browser has. */
  invoke(
    name: string,
    args: unknown,
    ctx?: { signal?: AbortSignal },
  ): Promise<unknown> {
    const descriptor = this.tools.get(name);
    if (!descriptor) return Promise.reject(new Error("Tool not found"));
    return descriptor.execute(args, ctx);
  }
}

function installModelContext(fake: unknown, home: "document" | "navigator") {
  Object.defineProperty(
    home === "document" ? document : navigator,
    "modelContext",
    {
      configurable: true,
      value: fake,
    },
  );
}

function clearModelContexts(): void {
  delete (document as { modelContext?: unknown }).modelContext;
  delete (navigator as { modelContext?: unknown }).modelContext;
}

function resetRegistry(): void {
  useUiToolsRegistry.setState({
    tools: new Map(),
    globalNames: new Set(),
    ownerTokens: new Map(),
    shippedNames: new Set(),
  });
}

function makeTool(
  name: string,
  extra?: Partial<UiToolDefinition>,
): UiToolDefinition {
  return {
    name,
    description: `Test tool ${name}`,
    inputSchema: { type: "object", properties: { a: { type: "string" } } },
    readOnly: false,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    nativePublication: { kind: "publish", untrustedContent: false },
    execute: vi.fn(async () => ({
      content: [{ type: "text" as const, text: `ran ${name}` }],
    })),
    ...extra,
  };
}

/** Let queued microtasks and timers run until `predicate` holds. */
async function waitUntil(
  predicate: () => boolean,
  label = "condition",
): Promise<void> {
  for (let tick = 0; tick < 200; tick += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const register = (def: UiToolDefinition, scope?: "global" | "surface") =>
  useUiToolsRegistry
    .getState()
    .registerUiTool(def, scope ? { scope } : undefined);

describe("startNativeUiToolPublisher", () => {
  let fake: FakeModelContext;

  beforeEach(() => {
    trackMock.mockClear();
    resetRegistry();
    fake = new FakeModelContext();
    installModelContext(fake, "document");
  });

  afterEach(clearModelContexts);

  describe("when the browser has no WebMCP API", () => {
    it("publishes nothing and leaves the in-app agent working", async () => {
      clearModelContexts();
      const def = makeTool("ui_navigate");
      register(def);

      const publisher = startNativeUiToolPublisher();
      await publisher.whenSettled();

      expect(publisher.home).toBeNull();
      expect(fake.attempts).toEqual([]);
      // The registry — Ask MCPJam's source of truth — is untouched.
      expect(useUiToolsRegistry.getState().resolve("ui_navigate")).toBe(def);
      expect(() => publisher.stop()).not.toThrow();
    });
  });

  it("publishes through the navigator alias when that is the only home", async () => {
    clearModelContexts();
    const navigatorFake = new FakeModelContext();
    installModelContext(navigatorFake, "navigator");
    register(makeTool("ui_navigate"));

    const publisher = startNativeUiToolPublisher();
    await publisher.whenSettled();

    expect(publisher.home).toBe("navigator");
    expect(navigatorFake.names()).toEqual(["ui_navigate"]);
    publisher.stop();
  });

  describe("eligibility", () => {
    it("publishes tools that opt in and skips the ones that do not", async () => {
      register(makeTool("ui_navigate"));
      register(
        makeTool("ui_ask_user", {
          nativePublication: {
            kind: "internal",
            reason: "needs an Ask MCPJam conversation",
          },
        }),
      );
      // A definition that never declared anything: default-deny.
      register(makeTool("ui_undeclared", { nativePublication: undefined }));

      const publisher = startNativeUiToolPublisher();
      await publisher.whenSettled();

      expect(fake.names()).toEqual(["ui_navigate"]);
      publisher.stop();
    });

    it("publishes the real catalog's inspector actions and no conversation-only tool", async () => {
      for (const def of buildUiToolsCatalog()) register(def, "global");

      const publisher = startNativeUiToolPublisher();
      await publisher.whenSettled();

      const published = fake.names();
      // The ordinary inspector actions an external agent should be able to
      // drive.
      expect(published).toEqual(
        expect.arrayContaining([
          "ui_navigate",
          "ui_select_server",
          "ui_snapshot_app",
          "ui_open_playground",
          "ui_execute_tool",
          "ui_add_server",
        ]),
      );
      // The tools that only mean something inside an MCPJam conversation.
      expect(published).not.toContain("ui_ask_user");
      expect(published.filter((n) => n.startsWith("ui_eval_"))).toEqual([]);
      publisher.stop();
    });

    it("states all three WebMCP hints on every published tool", async () => {
      register(
        makeTool("ui_execute_tool", {
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
          },
          nativePublication: { kind: "publish", untrustedContent: true },
        }),
      );

      const publisher = startNativeUiToolPublisher();
      await publisher.whenSettled();

      expect(fake.tools.get("ui_execute_tool")?.annotations).toEqual({
        readOnlyHint: false,
        untrustedContentHint: true,
        consequentialHint: true,
      });
      publisher.stop();
    });

    it("reports the publication once, with counts only", async () => {
      register(makeTool("ui_navigate"));
      register(makeTool("ui_select_server"));

      const publisher = startNativeUiToolPublisher();
      await publisher.whenSettled();
      // A later registry change must not re-announce.
      register(makeTool("ui_snapshot_app"), "surface");
      await publisher.whenSettled();

      const announcements = trackMock.mock.calls.filter(
        (call) => call[0] === "ui_tool_native_published",
      );
      expect(announcements).toHaveLength(1);
      expect(announcements[0]?.[1]).toEqual(
        expect.objectContaining({ api_home: "document", tool_count: 2 }),
      );
      publisher.stop();
    });

    it("says nothing on a page that publishes nothing", async () => {
      const publisher = startNativeUiToolPublisher();
      await publisher.whenSettled();

      expect(
        trackMock.mock.calls.filter(
          (call) => call[0] === "ui_tool_native_published",
        ),
      ).toEqual([]);
      publisher.stop();
    });

    it("never exposes tools to other origins", async () => {
      const spy = vi.spyOn(fake, "registerTool");
      register(makeTool("ui_navigate"));

      const publisher = startNativeUiToolPublisher();
      await publisher.whenSettled();

      for (const call of spy.mock.calls) {
        expect(call[1]).not.toHaveProperty("exposedTo");
      }
      publisher.stop();
    });
  });

  describe("following the registry", () => {
    it("registers a surface's tools on mount and removes them on unmount", async () => {
      register(makeTool("ui_navigate"), "global");
      const publisher = startNativeUiToolPublisher();
      await publisher.whenSettled();
      expect(fake.names()).toEqual(["ui_navigate"]);

      // The user navigates to a screen with a tool group.
      const unregister = register(makeTool("ui_run_eval_suite"), "surface");
      await publisher.whenSettled();
      expect(fake.names()).toEqual(["ui_navigate", "ui_run_eval_suite"]);

      // …and leaves it. The global tool survives the navigation.
      unregister();
      await publisher.whenSettled();
      expect(fake.names()).toEqual(["ui_navigate"]);
      publisher.stop();
    });

    it("re-registers a name whose definition changed", async () => {
      const first = makeTool("ui_navigate", { description: "First" });
      register(first);
      const publisher = startNativeUiToolPublisher();
      await publisher.whenSettled();
      expect(fake.tools.get("ui_navigate")?.description).toBe("First");

      // A remount builds a fresh definition object for the same name.
      useUiToolsRegistry.getState().unregisterUiTool("ui_navigate");
      register(makeTool("ui_navigate", { description: "Second" }));
      await publisher.whenSettled();

      expect(fake.tools.get("ui_navigate")?.description).toBe("Second");
      expect(fake.names()).toEqual(["ui_navigate"]);
      publisher.stop();
    });

    it("retires everything on stop", async () => {
      register(makeTool("ui_navigate"));
      const publisher = startNativeUiToolPublisher();
      await publisher.whenSettled();

      publisher.stop();
      await publisher.whenSettled();

      expect(fake.names()).toEqual([]);
    });
  });

  describe("registration failures", () => {
    it("catches one refused tool without losing the rest", async () => {
      const failing = makeTool("ui_navigate");
      register(failing);
      register(makeTool("ui_select_server"));
      const original = fake.registerTool.bind(fake);
      vi.spyOn(fake, "registerTool").mockImplementation(
        async (descriptor, options) => {
          if (descriptor.name === "ui_navigate") {
            const error = new Error("Duplicate tool name");
            error.name = "InvalidStateError";
            throw error;
          }
          return original(descriptor, options);
        },
      );

      const publisher = startNativeUiToolPublisher();
      await publisher.whenSettled();

      expect(fake.names()).toEqual(["ui_select_server"]);
      expect(trackMock).toHaveBeenCalledWith(
        "ui_tool_native_registration_failed",
        expect.objectContaining({
          tool_name: "ui_navigate",
          error_code: "InvalidStateError",
        }),
      );
      publisher.stop();
    });

    it("reports only the error's name, never its message", async () => {
      register(makeTool("ui_navigate"));
      vi.spyOn(fake, "registerTool").mockImplementation(async () => {
        const error = new Error("secret: https://internal.example/token=abc");
        error.name = "NotAllowedError";
        throw error;
      });

      const publisher = startNativeUiToolPublisher();
      await publisher.whenSettled();

      const failure = trackMock.mock.calls.find(
        (call) => call[0] === "ui_tool_native_registration_failed",
      );
      expect(JSON.stringify(failure)).not.toContain("internal.example");
      publisher.stop();
    });
  });

  describe("ownership across remounts", () => {
    it("a registration that settles after its publisher stopped removes only itself", async () => {
      // StrictMode: setup, cleanup, setup. The first publisher's registration
      // is still in flight when the second one makes its own.
      register(makeTool("ui_navigate"));
      const release = fake.gate("ui_navigate");
      const first = startNativeUiToolPublisher();
      first.stop();

      const second = startNativeUiToolPublisher();
      release();
      await first.whenSettled();
      await second.whenSettled();

      // The replacement survives; nothing was left behind or double-removed.
      expect(fake.names()).toEqual(["ui_navigate"]);
      expect(
        trackMock.mock.calls.filter(
          (call) => call[0] === "ui_tool_native_registration_failed",
        ),
      ).toEqual([]);
      second.stop();
    });

    it("a registration still pending when its publisher stops never lands", async () => {
      // The sharp version of the remount race: publisher one is mid-
      // `registerTool` when it is torn down and publisher two claims the same
      // name. If the late registration were allowed to land it would hit the
      // browser's duplicate-name rejection — or take the live registration's
      // place.
      register(makeTool("ui_navigate", { description: "First" }));
      const first = startNativeUiToolPublisher();
      await first.whenSettled();
      const attemptsBefore = fake.attempts.length;

      // Force a re-registration and hold it open inside the platform.
      const release = fake.gate("ui_navigate");
      useUiToolsRegistry.getState().unregisterUiTool("ui_navigate");
      register(makeTool("ui_navigate", { description: "Second" }));
      await waitUntil(
        () => fake.attempts.length > attemptsBefore,
        "the replacement registration to reach the platform",
      );

      first.stop();
      const second = startNativeUiToolPublisher();
      // Only now does the first publisher's registration get its answer. The
      // replacement is queued BEHIND it — settling `second` first would wait
      // on work this test is deliberately holding shut.
      release();
      await first.whenSettled();
      await second.whenSettled();

      expect(fake.names()).toEqual(["ui_navigate"]);
      expect(fake.tools.get("ui_navigate")?.description).toBe("Second");
      expect(
        trackMock.mock.calls.filter(
          (call) => call[0] === "ui_tool_native_registration_failed",
        ),
      ).toEqual([]);
      second.stop();
    });

    it("a remount ends with exactly one registration per name", async () => {
      for (const def of buildUiToolsCatalog()) register(def, "global");
      const first = startNativeUiToolPublisher();
      await first.whenSettled();
      first.stop();
      await first.whenSettled();

      const second = startNativeUiToolPublisher();
      await second.whenSettled();

      expect(new Set(fake.names()).size).toBe(fake.names().length);
      expect(fake.names()).toContain("ui_navigate");
      second.stop();
    });
  });

  describe("invoking a published tool", () => {
    it("routes the call through shared execution without touching the chat", async () => {
      const def = makeTool("ui_navigate");
      register(def);
      const publisher = startNativeUiToolPublisher();
      await publisher.whenSettled();

      const result = await fake.invoke("ui_navigate", { a: "playground" });

      expect(result).toEqual({
        content: [{ type: "text", text: "ran ui_navigate" }],
      });
      expect(def.execute).toHaveBeenCalledTimes(1);
      expect(def.execute).toHaveBeenCalledWith(
        { a: "playground" },
        expect.objectContaining({ caller: "native_webmcp" }),
      );
      // No conversation: nothing is deferred for an approval pill, and no
      // chat-side telemetry is emitted.
      expect(listDeferredUiToolCalls()).toEqual([]);
      expect(def.execute).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ scope: expect.anything() }),
      );
      expect(
        trackMock.mock.calls.filter((call) =>
          String(call[0]).startsWith("ui_tool_call_"),
        ),
      ).toEqual([]);
      expect(trackMock).toHaveBeenCalledWith(
        "ui_tool_native_call_completed",
        expect.objectContaining({ tool_name: "ui_navigate", status: "ok" }),
      );
      publisher.stop();
    });

    it("returns a readable error for malformed arguments", async () => {
      const def = makeTool("ui_navigate");
      register(def);
      const publisher = startNativeUiToolPublisher();
      await publisher.whenSettled();

      const result = await fake.invoke("ui_navigate", "garbage");

      expect(result).toEqual({
        content: [
          {
            type: "text",
            text: "ui_navigate: Arguments must be a JSON object, got a string.",
          },
        ],
        isError: true,
      });
      expect(def.execute).not.toHaveBeenCalled();
      publisher.stop();
    });

    it("honors the agent's cancellation signal", async () => {
      const def = makeTool("ui_navigate");
      register(def);
      const publisher = startNativeUiToolPublisher();
      await publisher.whenSettled();
      const controller = new AbortController();
      controller.abort();

      const result = (await fake.invoke(
        "ui_navigate",
        {},
        {
          signal: controller.signal,
        },
      )) as { content: Array<{ text: string }>; isError?: boolean };

      expect(def.execute).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("nothing was executed");
      publisher.stop();
    });

    it("refuses a call through a registration that has been replaced", async () => {
      // The name is still live — a NEW definition owns it — but the agent is
      // holding the descriptor of the registration that was replaced. Running
      // the replacement through a dead registration would act on a tool the
      // page has already taken down.
      const first = makeTool("ui_navigate", { description: "First" });
      register(first);
      const publisher = startNativeUiToolPublisher();
      await publisher.whenSettled();
      const staleDescriptor = fake.tools.get("ui_navigate")!;

      useUiToolsRegistry.getState().unregisterUiTool("ui_navigate");
      const second = makeTool("ui_navigate", { description: "Second" });
      register(second);
      await publisher.whenSettled();

      const result = (await staleDescriptor.execute({}, undefined)) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("no longer available");
      expect(first.execute).not.toHaveBeenCalled();
      expect(second.execute).not.toHaveBeenCalled();
      publisher.stop();
    });

    it("refuses a stale call for a tool that has gone away", async () => {
      // The registration the agent holds can outlive the tool: the screen
      // unmounted, or the publisher is mid-teardown.
      const def = makeTool("ui_run_eval_suite");
      const unregister = register(def, "surface");
      const publisher = startNativeUiToolPublisher();
      await publisher.whenSettled();
      const descriptor = fake.tools.get("ui_run_eval_suite");
      expect(descriptor).toBeDefined();

      unregister();
      await publisher.whenSettled();

      const result = (await descriptor!.execute({}, undefined)) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(def.execute).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("no longer available");
      publisher.stop();
    });
  });

  describe("unregistering while a call is running", () => {
    it("lets the accepted call finish, then tears the registration down", async () => {
      // Chrome only promises that unregistering leaves in-flight executions
      // alone from 153; the pin is 151, so the teardown waits instead.
      let release!: () => void;
      const running = new Promise<void>((resolve) => {
        release = resolve;
      });
      const def = makeTool("ui_execute_tool", {
        execute: vi.fn(async () => {
          await running;
          return { content: [{ type: "text" as const, text: "finished" }] };
        }),
      });
      const unregister = register(def, "surface");
      const publisher = startNativeUiToolPublisher();
      await publisher.whenSettled();
      const descriptor = fake.tools.get("ui_execute_tool")!;

      const call = descriptor.execute({}, undefined);
      unregister();
      await Promise.resolve();

      // Still registered: the call it accepted has not finished.
      expect(fake.names()).toEqual(["ui_execute_tool"]);
      // …but the tool is dead to anything new.
      const second = (await descriptor.execute({}, undefined)) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      expect(second.isError).toBe(true);
      expect(second.content[0]?.text).toContain("no longer available");
      expect(def.execute).toHaveBeenCalledTimes(1);

      release();
      await expect(call).resolves.toEqual({
        content: [{ type: "text", text: "finished" }],
      });
      await publisher.whenSettled();
      expect(fake.names()).toEqual([]);
      publisher.stop();
    });

    it("republishes the tool when a remount lands mid-call", async () => {
      // The collision the two rules above make between them: the outgoing
      // publisher must leave a registration standing while its call runs
      // (race 3), and the browser rejects the replacement's claim on a name
      // it still holds (race 1). Nothing retries a rejected registration, so
      // a replacement that did not wait would leave the tool published by
      // NOBODY for the rest of the page — the agent silently loses it.
      let release!: () => void;
      const running = new Promise<void>((resolve) => {
        release = resolve;
      });
      const def = makeTool("ui_execute_tool", {
        execute: vi.fn(async () => {
          await running;
          return { content: [{ type: "text" as const, text: "finished" }] };
        }),
      });
      register(def, "global");
      const first = startNativeUiToolPublisher();
      await first.whenSettled();
      const call = fake.invoke("ui_execute_tool", {});

      // The remount: cleanup stops the old publisher, setup starts the new
      // one, both while the agent's call is still running.
      first.stop();
      const second = startNativeUiToolPublisher();
      // Every chance to collide, and it must not take it: while the outgoing
      // registration is still standing for its call, the name is not free.
      for (let tick = 0; tick < 5; tick += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(fake.attempts).toEqual(["ui_execute_tool"]);

      release();
      await expect(call).resolves.toEqual({
        content: [{ type: "text", text: "finished" }],
      });
      await second.whenSettled();

      // Published again, by the publisher that is actually live…
      expect(fake.names()).toEqual(["ui_execute_tool"]);
      expect(
        trackMock.mock.calls.filter(
          ([event]) => event === "ui_tool_native_registration_failed",
        ),
      ).toEqual([]);
      // …and it works: the new registration reaches the handler rather than
      // answering for a tool that has gone away.
      await expect(fake.invoke("ui_execute_tool", {})).resolves.toEqual({
        content: [{ type: "text", text: "finished" }],
      });
      expect(def.execute).toHaveBeenCalledTimes(2);
      second.stop();
    });
  });
});

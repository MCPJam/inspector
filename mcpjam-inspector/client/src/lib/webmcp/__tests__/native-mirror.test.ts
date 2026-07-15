import { afterEach, describe, expect, it, vi } from "vitest";
import { getNativeModelContext, mirrorUiToolToNative } from "../native-mirror";
import type { UiToolDefinition } from "../ui-tools-registry";

type RegisterToolMock = ReturnType<typeof vi.fn>;

function stubModelContext(target: "document" | "navigator"): RegisterToolMock {
  const registerTool = vi.fn();
  (globalThis[target] as unknown as Record<string, unknown>).modelContext = {
    registerTool,
  };
  return registerTool;
}

function cleanupModelContext() {
  delete (document as unknown as Record<string, unknown>).modelContext;
  delete (navigator as unknown as Record<string, unknown>).modelContext;
}

function makeTool(extra?: Partial<UiToolDefinition>): UiToolDefinition {
  return {
    name: "ui_navigate",
    description: "Navigate",
    inputSchema: { type: "object", properties: {} },
    readOnly: true,
    execute: vi.fn(async () => ({
      content: [{ type: "text" as const, text: "done" }],
    })),
    ...extra,
  };
}

afterEach(() => {
  cleanupModelContext();
  vi.restoreAllMocks();
});

describe("getNativeModelContext", () => {
  it("returns null when no native API exists", () => {
    expect(getNativeModelContext()).toBeNull();
  });

  it("prefers document.modelContext over the deprecated navigator surface", () => {
    const onDocument = stubModelContext("document");
    const onNavigator = stubModelContext("navigator");

    mirrorUiToolToNative(makeTool());
    expect(onDocument).toHaveBeenCalledTimes(1);
    expect(onNavigator).not.toHaveBeenCalled();
  });

  it("falls back to navigator.modelContext (pre-Chrome-150)", () => {
    const onNavigator = stubModelContext("navigator");
    mirrorUiToolToNative(makeTool());
    expect(onNavigator).toHaveBeenCalledTimes(1);
  });
});

describe("mirrorUiToolToNative", () => {
  it("is a silent no-op without the native API", () => {
    expect(mirrorUiToolToNative(makeTool())).toBeNull();
  });

  it("registers the WebMCP descriptor with annotations and an abort signal", () => {
    const registerTool = stubModelContext("document");
    mirrorUiToolToNative(makeTool());

    expect(registerTool).toHaveBeenCalledTimes(1);
    const [descriptor, opts] = registerTool.mock.calls[0];
    expect(descriptor).toMatchObject({
      name: "ui_navigate",
      description: "Navigate",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    });
    expect(typeof descriptor.execute).toBe("function");
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
  });

  it("disposer aborts the registration signal", () => {
    const registerTool = stubModelContext("document");
    const dispose = mirrorUiToolToNative(makeTool());

    const signal = registerTool.mock.calls[0][1]?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    dispose?.();
    expect(signal.aborted).toBe(true);
  });

  it("adapts successful results to a plain string for native consumers", async () => {
    const registerTool = stubModelContext("document");
    mirrorUiToolToNative(
      makeTool({
        execute: async () => ({
          content: [
            { type: "text", text: "line one" },
            { type: "text", text: "line two" },
          ],
        }),
      }),
    );

    const nativeExecute = registerTool.mock.calls[0][0].execute as (
      args: unknown,
    ) => Promise<unknown>;
    await expect(nativeExecute({})).resolves.toBe("line one\nline two");
  });

  it("surfaces isError results and execute throws as Errors", async () => {
    const registerTool = stubModelContext("document");
    mirrorUiToolToNative(
      makeTool({
        execute: async () => ({
          content: [{ type: "text", text: "nope" }],
          isError: true,
        }),
      }),
    );
    const nativeExecute = registerTool.mock.calls[0][0].execute as (
      args: unknown,
    ) => Promise<unknown>;
    await expect(nativeExecute({})).rejects.toThrow("nope");
  });

  it("returns null (and never throws) when native registerTool throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    (document as unknown as Record<string, unknown>).modelContext = {
      registerTool: () => {
        throw new Error("origin trial expired");
      },
    };
    expect(mirrorUiToolToNative(makeTool())).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});

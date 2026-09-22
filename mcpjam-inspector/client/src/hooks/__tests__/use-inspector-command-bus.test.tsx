import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useInspectorCommandBus } from "../use-inspector-command-bus";

const mocks = vi.hoisted(() => ({
  authFetch: vi.fn(async () => new Response(null, { status: 200 })),
  executeInspectorCommand: vi.fn(),
}));

vi.mock("@/lib/config", () => ({ HOSTED_MODE: false }));
vi.mock("@/lib/session-token", () => ({
  addTokenToUrl: (url: string) => url,
  authFetch: (...args: unknown[]) => mocks.authFetch(...args),
}));
vi.mock("@/lib/inspector-command-handlers", () => ({
  executeInspectorCommand: (...args: unknown[]) =>
    mocks.executeInspectorCommand(...args),
}));

class FakeEventSource {
  static latest: FakeEventSource | undefined;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<
    string,
    Array<(event: MessageEvent<string>) => void>
  >();

  constructor(public readonly url: string) {
    FakeEventSource.latest = this;
  }

  addEventListener(
    type: string,
    listener: (event: MessageEvent<string>) => void
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, data: unknown): void {
    const event = { data: JSON.stringify(data) } as MessageEvent<string>;
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  close(): void {}
}

describe("useInspectorCommandBus events", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource);
    FakeEventSource.latest = undefined;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delivers a scope-step-up event without treating it as a command", () => {
    const onScopeStepUp = vi.fn();
    renderHook(() => useInspectorCommandBus({ onScopeStepUp }));

    act(() => {
      FakeEventSource.latest?.emit("inspector-event", {
        kind: "scope_step_up",
        serverId: "auth-bench",
        requiredScope: "bench:write",
        resourceMetadataUrl:
          "https://bench.example/.well-known/oauth-protected-resource",
      });
    });

    expect(onScopeStepUp).toHaveBeenCalledWith({
      kind: "scope_step_up",
      serverId: "auth-bench",
      requiredScope: "bench:write",
      resourceMetadataUrl:
        "https://bench.example/.well-known/oauth-protected-resource",
    });
    expect(mocks.executeInspectorCommand).not.toHaveBeenCalled();
    expect(mocks.authFetch).not.toHaveBeenCalled();
  });
});

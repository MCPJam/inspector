/**
 * The App-root hook that publishes MCPJam's UI tools to browser-native WebMCP
 * agents: what an inspector page exposes, what the standalone scenario chat
 * must not, and what a StrictMode double-mount leaves behind.
 *
 * This is the test that replaced the old "the catalog makes zero native
 * registerTool calls" guard. Zero is no longer the contract — the contract is
 * WHICH tools, and it has two halves that have to hold together: the ordinary
 * inspector actions are published, and the tools that only mean something
 * inside an MCPJam conversation are not.
 */
import { render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRegisterUiTools } from "../use-register-ui-tools";
import { usePublishNativeUiTools } from "../use-publish-native-ui-tools";
import type { NativeToolDescriptor } from "../native-model-context";
import { useUiToolsRegistry } from "../ui-tools-registry";

/** The measured Chromium 151 contract, in miniature — see the publisher test. */
class FakeModelContext {
  readonly tools = new Map<string, NativeToolDescriptor>();
  readonly failures: string[] = [];

  async registerTool(
    descriptor: NativeToolDescriptor,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    if (options?.signal?.aborted) return;
    if (this.tools.has(descriptor.name)) {
      this.failures.push(descriptor.name);
      const error = new Error("Duplicate tool name");
      error.name = "InvalidStateError";
      throw error;
    }
    this.tools.set(descriptor.name, descriptor);
    options?.signal?.addEventListener(
      "abort",
      () => {
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
}

function InspectorPage({ enabled }: { enabled: boolean }) {
  useRegisterUiTools({ enabled });
  usePublishNativeUiTools({ enabled });
  return null;
}

/** Let the publisher's per-name chains drain. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("usePublishNativeUiTools", () => {
  let fake: FakeModelContext;

  beforeEach(() => {
    useUiToolsRegistry.setState({
      tools: new Map(),
      globalNames: new Set(),
      ownerTokens: new Map(),
      shippedNames: new Set(),
    });
    fake = new FakeModelContext();
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: fake,
    });
  });

  afterEach(() => {
    delete (document as { modelContext?: unknown }).modelContext;
    vi.restoreAllMocks();
  });

  it("publishes the eligible catalog and unpublishes it on unmount", async () => {
    const view = render(<InspectorPage enabled />);
    await settle();

    expect(fake.names()).toEqual(
      expect.arrayContaining([
        "ui_navigate",
        "ui_select_server",
        "ui_set_app_context",
        "ui_snapshot_app",
        "ui_open_playground",
        "ui_select_tool",
        "ui_execute_tool",
        "ui_open_server_form",
        "ui_add_server",
        "ui_connect_server",
        "ui_disconnect_server",
        "ui_remove_server",
      ]),
    );

    view.unmount();
    await settle();
    expect(fake.names()).toEqual([]);
  });

  it("never publishes a tool that needs an MCPJam conversation", async () => {
    // `ui_ask_user` renders a card into a transcript and parks that turn; the
    // eval-authoring tools read a scope pinned to one conversation. A native
    // agent has neither, so publishing these would advertise capabilities
    // that can only answer "open Ask MCPJam first".
    const view = render(<InspectorPage enabled />);
    await settle();

    const published = fake.names();
    expect(published).not.toContain("ui_ask_user");
    expect(published.filter((name) => name.startsWith("ui_eval_"))).toEqual([]);
    // …while the very same tools ARE available to Ask MCPJam.
    expect(useUiToolsRegistry.getState().resolve("ui_ask_user")).not.toBeNull();
    expect(
      useUiToolsRegistry.getState().resolve("ui_eval_context"),
    ).not.toBeNull();

    view.unmount();
  });

  it("publishes nothing on the standalone scenario chat route", async () => {
    // `enabled: false` is how App excludes that route. Its end user is not
    // the inspector operator, so inspector-driving tools must not exist on
    // the page for EITHER agent.
    const view = render(<InspectorPage enabled={false} />);
    await settle();

    expect(fake.names()).toEqual([]);
    expect(useUiToolsRegistry.getState().tools.size).toBe(0);

    view.unmount();
  });

  it("survives StrictMode's double mount without duplicate registrations", async () => {
    const view = render(
      <StrictMode>
        <InspectorPage enabled />
      </StrictMode>,
    );
    await settle();

    const published = fake.names();
    expect(published).toContain("ui_navigate");
    expect(new Set(published).size).toBe(published.length);
    // The browser rejects a duplicate name outright; a single one of those
    // would mean a tool silently missing from the published set.
    expect(fake.failures).toEqual([]);

    view.unmount();
    await settle();
    expect(fake.names()).toEqual([]);
  });

  it("is inert on a browser with no WebMCP API", async () => {
    delete (document as { modelContext?: unknown }).modelContext;

    const view = render(<InspectorPage enabled />);
    await settle();

    // Nothing published, nothing thrown — and Ask MCPJam's registry is full.
    expect(fake.names()).toEqual([]);
    expect(useUiToolsRegistry.getState().resolve("ui_navigate")).not.toBeNull();

    view.unmount();
  });
});

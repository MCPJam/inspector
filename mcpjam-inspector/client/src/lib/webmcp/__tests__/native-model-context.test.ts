/**
 * The browser seam: where the WebMCP API is found, when it counts as present,
 * and what MCPJam claims about a tool once it publishes one.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  nativeAnnotationsFor,
  nativeDescriptorFor,
  resolveNativeModelContext,
} from "../native-model-context";
import type { UiToolDefinition } from "../ui-tools-registry";

function defineModelContext(host: Document | Navigator, value: unknown): void {
  Object.defineProperty(host, "modelContext", { configurable: true, value });
}

function clearModelContexts(): void {
  delete (document as { modelContext?: unknown }).modelContext;
  delete (navigator as { modelContext?: unknown }).modelContext;
}

function makeDef(extra?: Partial<UiToolDefinition>): UiToolDefinition {
  return {
    name: "ui_navigate",
    description: "Navigate",
    readOnly: false,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    nativePublication: { kind: "publish", untrustedContent: false },
    execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    ...extra,
  };
}

describe("resolveNativeModelContext", () => {
  afterEach(clearModelContexts);

  it("returns null on a browser without the API", () => {
    expect(resolveNativeModelContext()).toBeNull();
  });

  it("prefers document.modelContext", () => {
    const documentApi = { registerTool: () => {} };
    const navigatorApi = { registerTool: () => {} };
    defineModelContext(document, documentApi);
    defineModelContext(navigator, navigatorApi);

    expect(resolveNativeModelContext()).toEqual({
      api: documentApi,
      home: "document",
    });
  });

  it("falls back to the deprecated navigator alias", () => {
    const navigatorApi = { registerTool: () => {} };
    defineModelContext(navigator, navigatorApi);

    expect(resolveNativeModelContext()).toEqual({
      api: navigatorApi,
      home: "navigator",
    });
  });

  it("ignores a home whose API cannot register a tool", () => {
    // A capability check, not a presence check: the property has already been
    // one shape and then another, and a stub is not an API.
    defineModelContext(document, { registerTool: "not a function" });
    const navigatorApi = { registerTool: () => {} };
    defineModelContext(navigator, navigatorApi);

    expect(resolveNativeModelContext()?.home).toBe("navigator");

    defineModelContext(navigator, {});
    clearModelContexts();
    defineModelContext(document, {});
    expect(resolveNativeModelContext()).toBeNull();
  });
});

describe("nativeAnnotationsFor", () => {
  it("copies readOnlyHint and states untrustedContent from the definition", () => {
    expect(
      nativeAnnotationsFor(
        makeDef({
          readOnly: true,
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
          nativePublication: { kind: "publish", untrustedContent: true },
        }),
      ),
    ).toEqual({
      readOnlyHint: true,
      untrustedContentHint: true,
      consequentialHint: false,
    });
  });

  it("marks destructive actions consequential", () => {
    expect(
      nativeAnnotationsFor(
        makeDef({
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false,
          },
        }),
      ).consequentialHint,
    ).toBe(true);
  });

  it("marks a mutating open-world action consequential", () => {
    // Connecting a server or running one of its tools reaches something
    // outside this browser; that is a real-world consequence.
    expect(
      nativeAnnotationsFor(
        makeDef({
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
          },
        }),
      ).consequentialHint,
    ).toBe(true);
  });

  it("never marks a read-only tool consequential, even across the network", () => {
    // ui_read_resource / ui_get_prompt: open-world reads. Gating those would
    // spend the user's attention on the prompts that do not matter.
    expect(
      nativeAnnotationsFor(
        makeDef({
          readOnly: true,
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
          },
        }),
      ),
    ).toEqual({
      readOnlyHint: true,
      untrustedContentHint: false,
      consequentialHint: false,
    });
  });

  it("honors an explicit consequence declaration over the derivation", () => {
    // MCP's destructiveHint asks whether something is irreversible; Chrome's
    // consequentialHint asks whether a browser agent should confirm. A tool
    // that only creates can still answer yes to the second
    // (`ui_publish_scenario` opening an org-funded link to signed-out
    // visitors), and deriving alone would under-claim exactly there.
    expect(
      nativeAnnotationsFor(
        makeDef({
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
          nativePublication: {
            kind: "publish",
            untrustedContent: false,
            consequential: true,
          },
        }),
      ),
    ).toEqual({
      readOnlyHint: false,
      untrustedContentHint: false,
      consequentialHint: true,
    });
  });

  it("reads an unannotated tool pessimistically", () => {
    // The protocol's default: an absent destructiveHint means destructive,
    // and a definition that never declared its publication is treated as
    // carrying content MCPJam cannot vouch for.
    expect(
      nativeAnnotationsFor({
        name: "ui_mystery",
        description: "?",
        readOnly: false,
        execute: async () => ({ content: [] }),
      }),
    ).toEqual({
      readOnlyHint: false,
      untrustedContentHint: true,
      consequentialHint: true,
    });
  });
});

describe("nativeDescriptorFor", () => {
  it("carries name, description, schema and annotations", () => {
    const execute = async () => ({ content: [] });
    const descriptor = nativeDescriptorFor(
      makeDef({ inputSchema: { type: "object", properties: { a: {} } } }),
      execute,
    );

    expect(descriptor).toEqual({
      name: "ui_navigate",
      description: "Navigate",
      inputSchema: { type: "object", properties: { a: {} } },
      annotations: {
        readOnlyHint: false,
        untrustedContentHint: false,
        consequentialHint: false,
      },
      execute,
    });
  });

  it("substitutes an empty object schema when a tool declares none", () => {
    // Blink derives the agent-facing parameter list from the schema; absent
    // is not the same as "takes nothing".
    expect(
      nativeDescriptorFor(makeDef({ inputSchema: undefined }), async () => ({
        content: [],
      })).inputSchema,
    ).toEqual({ type: "object", properties: {} });
  });
});

/**
 * The page-tool builder: what reaches the model, what is refused before a
 * command leaves this process, and what gates.
 *
 * The three things this suite exists to stop regressing:
 *
 *   1. AN UNCLASSIFIED `webmcp_*` NAME RUNS UNGATED. Approval on the hosted
 *      engines is keyed by name, and a miss falls through to
 *      `requireToolApproval` (off by default). `mcpjam-stream-handler.test.ts`
 *      pins that behaviour; this pins that the builder never produces one.
 *   2. ARGUMENTS ARE CHECKED HERE OR NOWHERE. Chrome does not validate an
 *      invocation against the registered schema, and the hosted chat path has
 *      no SDK-side validation.
 *   3. AN INVOCATION CARRIES ITS BINDING. Without it a call approved against
 *      one document is spent on whatever carries that name on the next.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildWebmcpPageTools,
  WEBMCP_MAX_PAGE_TOOLS,
  type PeekedPageTool,
} from "../page-tools";
import type { BrowserAction } from "../../../services/browserd/protocol";
import { isClientFulfilledToolName } from "@/shared/client-fulfilled-tools";

const BINDING = { bootId: "boot-1", tabId: "@session", navCounter: 4 };

function pageTool(over: Partial<PeekedPageTool> = {}): PeekedPageTool {
  return {
    name: "add_topping",
    description: "Add a topping to the pizza",
    origin: "https://googlechromelabs.github.io",
    isMainFrame: true,
    frameId: "frame-main",
    registrationSeq: 3,
    registrationKind: "imperative",
    inputSchema: {
      type: "object",
      properties: {
        topping: {
          oneOf: [
            { const: "pepperoni", title: "Pepperoni" },
            { const: "mushroom", title: "Mushroom" },
          ],
        },
      },
      required: ["topping"],
    },
    ...over,
  };
}

function build(over: Partial<Parameters<typeof buildWebmcpPageTools>[0]> = {}) {
  const sent: Array<{ action: BrowserAction; args: unknown }> = [];
  const send = vi.fn(async (action: BrowserAction, args: unknown) => {
    sent.push({ action, args });
    return { result: { ok: true } } as Record<string, unknown>;
  });
  const built = buildWebmcpPageTools({
    pageTools: [pageTool()],
    send,
    needsApproval: true,
    binding: BINDING,
    ...over,
  });
  return { built, sent, send };
}

async function run(
  tool: unknown,
  input: unknown,
  options: { abortSignal?: AbortSignal } = {},
) {
  const execute = (tool as { execute: (i: unknown, o: unknown) => Promise<unknown> })
    .execute;
  return execute(input, options);
}

describe("buildWebmcpPageTools — advertisement", () => {
  it("mints a readable, prefixed, server-executed tool", () => {
    const { built } = build();
    expect(Object.keys(built.tools)).toEqual(["webmcp_add_topping"]);
    const tool = built.tools.webmcp_add_topping as { execute?: unknown };
    // Server-executed is decided SOLELY by having an execute function.
    expect(typeof tool.execute).toBe("function");
    // And the name must not look client-fulfilled, or the stream would wait
    // forever for a result the browser was never asked for.
    expect(isClientFulfilledToolName("webmcp_add_topping")).toBe(false);
  });

  it("advertises the page's schema verbatim", () => {
    const { built } = build();
    const tool = built.tools.webmcp_add_topping as {
      inputSchema: { jsonSchema?: unknown };
    };
    // Chrome's own example is a `oneOf` of `const` + `title`. Re-expressing it
    // through Zod would lose it, so the schema is handed over as raw JSON
    // Schema.
    expect(tool.inputSchema.jsonSchema).toEqual(pageTool().inputSchema);
  });

  it("names the origin in the description the model reads", () => {
    const { built } = build();
    const tool = built.tools.webmcp_add_topping as { description: string };
    expect(tool.description).toContain(
      "[WebMCP page tool — https://googlechromelabs.github.io]",
    );
    expect(tool.description).toContain("Add a topping to the pizza");
  });

  it("classifies EVERY page tool as requiring approval", () => {
    const { built } = build({
      pageTools: [
        pageTool(),
        // Even one the page swears is read-only: that is a claim by the party
        // whose code would run, and Chromium does not carry annotations
        // through for imperative registrations at all.
        pageTool({
          name: "read_cart",
          annotations: { readOnly: true },
          registrationSeq: 4,
        }),
      ],
    });
    expect([...built.approvals.requiredNames].sort()).toEqual([
      "webmcp_add_topping",
      "webmcp_read_cart",
    ]);
    expect(built.approvals.freeNames.size).toBe(0);
    // Nothing advertised may be missing from the classification.
    for (const name of Object.keys(built.tools)) {
      expect(built.approvals.requiredNames.has(name)).toBe(true);
    }
  });
});

describe("buildWebmcpPageTools — arguments are validated before anything runs", () => {
  it("refuses an invalid call WITHOUT sending a command", async () => {
    const { built, send } = build();
    const result = (await run(built.tools.webmcp_add_topping, {
      topping: "pineapple",
    })) as { error?: string };
    expect(send).not.toHaveBeenCalled();
    expect(result.error).toContain("invalid_arguments");
    // The allowed values are NAMED. A model told only "invalid" guesses again;
    // told the members, it fixes the call on the next step.
    expect(result.error).toContain("pepperoni");
  });

  it("refuses a missing required property before sending", async () => {
    const { built, send } = build();
    const result = (await run(built.tools.webmcp_add_topping, {})) as {
      error?: string;
    };
    expect(send).not.toHaveBeenCalled();
    expect(result.error).toContain("topping");
  });

  it("sends a valid call with its binding and the page's own name", async () => {
    const { built, sent } = build();
    await run(built.tools.webmcp_add_topping, { topping: "mushroom" });
    expect(sent).toHaveLength(1);
    expect(sent[0].action).toEqual({
      kind: "webmcp_invoke",
      // The PAGE's name; the model-facing `webmcp_` name means nothing to it.
      toolKey: "add_topping",
      frameId: "frame-main",
      expectedBinding: {
        bootId: "boot-1",
        tabId: "@session",
        navCounter: 4,
        frameId: "frame-main",
        registrationSeq: 3,
      },
      input: { topping: "mushroom" },
    });
  });

  it("passes a call through when the page declared no schema", async () => {
    const { built, sent } = build({
      pageTools: [pageTool({ inputSchema: undefined })],
    });
    await run(built.tools.webmcp_add_topping, { anything: true });
    expect(sent).toHaveLength(1);
  });

  it("attributes the result to the tool and document that produced it", async () => {
    const { built } = build();
    const result = (await run(built.tools.webmcp_add_topping, {
      topping: "mushroom",
    })) as { pageTool?: unknown };
    // IN the result, so the attribution persists in the transcript rather than
    // being re-derived tomorrow from a browser that has moved on.
    expect(result.pageTool).toEqual({
      rawName: "add_topping",
      origin: "https://googlechromelabs.github.io",
      frameId: "frame-main",
      navCounter: 4,
      registrationSeq: 3,
    });
  });

  it("attributes a REFUSED call too", async () => {
    const { built } = build();
    const result = (await run(built.tools.webmcp_add_topping, {
      topping: "pineapple",
    })) as { pageTool?: { rawName?: string } };
    expect(result.pageTool?.rawName).toBe("add_topping");
  });
});

describe("buildWebmcpPageTools — unattended policy", () => {
  it("advertises NOTHING under read_only", () => {
    // There is no such thing as an observational page tool, and a page saying
    // one is read-only is not evidence.
    const dropped: string[] = [];
    const { built } = build({
      policy: { mode: "read_only" },
      onDropped: ({ rawName }) => dropped.push(rawName),
    });
    expect(Object.keys(built.tools)).toEqual([]);
    expect(dropped).toEqual(["add_topping"]);
  });

  it("advertises only the page tools an allowlist names", () => {
    const { built } = build({
      pageTools: [
        pageTool({ name: "getAvailability", inputSchema: undefined }),
        pageTool({ name: "bookSlot", inputSchema: undefined, registrationSeq: 4 }),
      ],
      policy: { mode: "allowlist", toolAllowlist: ["webmcp:getAvailability"] },
    });
    // The allowlist names the PAGE's tool, which is what an operator writing a
    // policy has in front of them — not our sanitized model-facing name.
    expect(Object.keys(built.tools)).toEqual(["webmcp_getAvailability"]);
  });

  it("filters by the declaring frame's origin, not the top-level page", () => {
    const { built } = build({
      pageTools: [
        pageTool({ name: "ok", origin: "https://allowed.test", inputSchema: undefined }),
        pageTool({
          name: "nope",
          origin: "https://widget.evil.test",
          isMainFrame: false,
          frameId: "frame-2",
          registrationSeq: 9,
          inputSchema: undefined,
        }),
      ],
      policy: { mode: "allow_all", originAllowlist: ["https://allowed.test"] },
    });
    expect(Object.keys(built.tools)).toEqual(["webmcp_ok"]);
  });

  it("advertises everything under allow_all, exactly as the verbs did", () => {
    const { built } = build({
      pageTools: [
        pageTool({ inputSchema: undefined }),
        pageTool({ name: "pay", inputSchema: undefined, registrationSeq: 4 }),
      ],
      policy: { mode: "allow_all" },
    });
    expect(Object.keys(built.tools).sort()).toEqual([
      "webmcp_add_topping",
      "webmcp_pay",
    ]);
  });
});

describe("buildWebmcpPageTools — collisions and bounds", () => {
  it("drops a page tool whose name is already taken", () => {
    // Renaming it out of the way would let a page decide what somebody else's
    // tool is called, and the model could not tell which one it just called.
    const dropped: string[] = [];
    const { built } = build({
      reservedNames: new Set(["webmcp_add_topping"]),
      onDropped: ({ rawName }) => dropped.push(rawName),
    });
    expect(Object.keys(built.tools)).toEqual([]);
    expect(dropped).toEqual(["add_topping"]);
  });

  it("caps how many of a page's tools reach the model", () => {
    const many = Array.from({ length: WEBMCP_MAX_PAGE_TOOLS + 5 }, (_, index) =>
      pageTool({
        name: `tool_${String(index).padStart(3, "0")}`,
        inputSchema: undefined,
        registrationSeq: index,
      }),
    );
    const dropped: string[] = [];
    const { built } = build({
      pageTools: many,
      onDropped: ({ rawName }) => dropped.push(rawName),
    });
    expect(Object.keys(built.tools)).toHaveLength(WEBMCP_MAX_PAGE_TOOLS);
    expect(dropped).toHaveLength(5);
  });

  it("drops a tool whose schema no provider can express, with a reason", () => {
    const dropped: Array<{ rawName: string; reason: string }> = [];
    const { built } = build({
      pageTools: [pageTool({ inputSchema: { type: "string" } })],
      onDropped: ({ rawName, reason }) => dropped.push({ rawName, reason }),
    });
    expect(Object.keys(built.tools)).toEqual([]);
    expect(dropped[0].reason).toContain("object");
  });

  it("keeps a provider-unexpressible schema, with a NON-blocking diagnostic", () => {
    // Gemini cannot express `oneOf`. That is a fact to surface, not a licence
    // to rewrite the page's contract — a rewritten schema means the model
    // sends a shape the page's handler was never written for.
    const { built } = build({ provider: "google" });
    expect(Object.keys(built.tools)).toEqual(["webmcp_add_topping"]);
    expect(
      built.minted[0].diagnostics.map((diagnostic) => diagnostic.code),
    ).toContain("provider_unsupported");
  });

  it("gives two same-origin duplicate iframes two callable tools", async () => {
    const { built, sent } = build({
      pageTools: [
        pageTool({
          name: "search",
          isMainFrame: false,
          frameId: "frame-b",
          registrationSeq: 2,
          inputSchema: undefined,
        }),
        pageTool({
          name: "search",
          isMainFrame: false,
          frameId: "frame-a",
          registrationSeq: 1,
          inputSchema: undefined,
        }),
      ],
    });
    expect(Object.keys(built.tools).sort()).toEqual([
      "webmcp_search",
      "webmcp_search_f1",
    ]);
    // And each reaches ITS OWN frame — the case a name-keyed identity could
    // not express at all.
    await run(built.tools.webmcp_search, {});
    await run(built.tools.webmcp_search_f1, {});
    expect(
      sent.map((entry) => (entry.action as { frameId?: string }).frameId),
    ).toEqual(["frame-a", "frame-b"]);
  });
});

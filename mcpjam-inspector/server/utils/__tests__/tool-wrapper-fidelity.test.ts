/**
 * Every ToolSet wrapper preserves `needsApproval`.
 *
 * A tool is declared once, at build time, and then passes through a chain of
 * wrappers before an engine sees it: scope step-up observation, two eval-trace
 * wrappers, the skill approval wrap, the SEP-2640 compose, the advertised
 * subset gate. Each one rebuilds the tool object — `{...tool, execute: …}` —
 * and each one preserves `needsApproval` today only because a spread happens
 * to carry it.
 *
 * That is fine while the BYOK path is the only reader. Once every engine reads
 * `tool.needsApproval` (PR 2), a wrapper that drops it silently ungates the
 * tool on every engine at once, and the only symptom is a missing pill. So the
 * property is pinned here, deliberately as a wrapper-by-wrapper table rather
 * than one clever loop: the wrappers take different arguments and own different
 * parts of the tool, and a shared harness would hide that.
 *
 * BOTH FORMS matter. A boolean is the common case; a FUNCTION is the SEP-2640
 * form, whose identity must survive because it is not a predicate — it records
 * the manifest digest the user is being asked about, and a copy that merely
 * returns the same value would record nothing.
 */
import { describe, expect, it, vi } from "vitest";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  applyPrepareAdvertisedTools,
  gateToolsToAdvertisedSubset,
} from "../advertised-tools";
import { wrapToolsWithScopeStepUp } from "../insufficient-scope-step-up";
import {
  createAiSdkEvalTraceContext,
  wrapBackendToolsForTrace,
  wrapToolSetForEvalTrace,
} from "../../services/evals/eval-trace-capture";
import { applySkillToolApproval } from "../chat-v2-orchestration";
import { withServerSkills } from "../server-skill-tools";

/** The declaration a function-form tool carries, identity included. */
const digestBinding = vi.fn(async () => true);

function fixture(): ToolSet {
  return {
    always_true: tool({
      description: "Boolean declaration, true",
      inputSchema: z.object({}),
      needsApproval: true,
      execute: async () => "ok",
    }),
    always_false: tool({
      description: "Boolean declaration, false",
      inputSchema: z.object({}),
      needsApproval: false,
      execute: async () => "ok",
    }),
    // Deliberately built as a plain object rather than through `tool()`: the
    // SEP-2640 declaration is attached beside `tool({...})` for exactly this
    // reason (the AI SDK's `needsApproval` typing does not admit the async
    // manifest gate), so the fixture has to have the same shape.
    function_form: {
      ...tool({
        description: "Function declaration",
        inputSchema: z.object({ name: z.string() }),
        execute: async () => "ok",
      }),
      needsApproval: digestBinding,
    },
    // No declaration at all — the `never` floor, spelled as silence today.
    undeclared: tool({
      description: "No declaration",
      inputSchema: z.object({}),
      execute: async () => "ok",
    }),
  } as ToolSet;
}

/**
 * Assert a wrapper's output carries the same declarations as its input.
 *
 * Identity, not equality, for the function: a wrapper that rebuilt the closure
 * would still satisfy `typeof === "function"` while having lost the map the
 * digest binding writes into.
 */
function expectDeclarationsPreserved(wrapped: Record<string, any>) {
  expect(wrapped.always_true.needsApproval).toBe(true);
  expect(wrapped.always_false.needsApproval).toBe(false);
  expect(wrapped.function_form.needsApproval).toBe(digestBinding);
  expect(wrapped.undeclared.needsApproval).toBeUndefined();
}

describe("ToolSet wrappers preserve the approval declaration", () => {
  it("wrapToolsWithScopeStepUp", () => {
    expectDeclarationsPreserved(
      wrapToolsWithScopeStepUp(fixture(), () => null) as Record<string, any>,
    );
  });

  it("wrapToolSetForEvalTrace", () => {
    expectDeclarationsPreserved(
      wrapToolSetForEvalTrace(
        fixture() as unknown as Record<string, unknown>,
        createAiSdkEvalTraceContext(Date.now()),
      ) as Record<string, any>,
    );
  });

  it("wrapBackendToolsForTrace", () => {
    expectDeclarationsPreserved(
      wrapBackendToolsForTrace(
        fixture() as unknown as Record<string, unknown>,
        {
          runStartedAt: Date.now(),
          promptIndex: 0,
          stepIndex: 0,
          spans: [],
        },
      ) as Record<string, any>,
    );
  });

  it("gateToolsToAdvertisedSubset", () => {
    expectDeclarationsPreserved(
      gateToolsToAdvertisedSubset(
        fixture() as unknown as Record<string, unknown>,
        () => new Set(["always_true"]),
      ) as Record<string, any>,
    );
  });

  it("the skill approval wrap, with the switch OFF", () => {
    // The switch-off arm returns the input untouched, which is what leaves a
    // function-form declaration intact.
    expectDeclarationsPreserved(
      applySkillToolApproval(fixture() as unknown as Record<string, unknown>, {
        pinned: false,
        requireToolApproval: false,
      }) as Record<string, any>,
    );
  });

  it("the skill approval wrap, pinned", () => {
    expectDeclarationsPreserved(
      applySkillToolApproval(fixture() as unknown as Record<string, unknown>, {
        pinned: true,
        requireToolApproval: true,
      }) as Record<string, any>,
    );
  });

  it("the skill approval wrap RAISES with the switch on, and only raises", () => {
    // The one wrapper that legitimately rewrites the declaration. It may only
    // raise: a tool that already gated must not come out free.
    const raised = applySkillToolApproval(
      fixture() as unknown as Record<string, unknown>,
      { pinned: false, requireToolApproval: true },
    ) as Record<string, any>;
    for (const name of Object.keys(raised)) {
      expect(raised[name].needsApproval, name).toBe(true);
    }
  });

  it("the SEP-2640 compose, for the tools it does not own", async () => {
    const manager = {
      getSkillsSupport: () => ({
        declared: true,
        advertised: true,
        directoryRead: false,
        active: true,
      }),
      listServerSkills: vi.fn(async () => ({ skills: [] })),
      getServerSkill: vi.fn(async () => undefined),
    } as never;
    const { tools } = withServerSkills(
      fixture() as unknown as Record<string, unknown>,
      { manager, servers: [{ serverId: "srv_1", serverLabel: "Acme" }] },
    );
    expectDeclarationsPreserved(tools as Record<string, any>);
  });

  it("the SEP-2640 compose declares its OWN loadSkill as a function", async () => {
    // Not fidelity but its converse, and it belongs next to it: the compose
    // REPLACES `loadSkill`, so preserving the input's declaration there would
    // be the bug. What it must carry is the digest-recording gate.
    const manager = {
      getSkillsSupport: () => ({
        declared: true,
        advertised: true,
        directoryRead: false,
        active: true,
      }),
      listServerSkills: vi.fn(async () => ({ skills: [] })),
      getServerSkill: vi.fn(async () => undefined),
    } as never;
    const { tools } = withServerSkills({} as Record<string, unknown>, {
      manager,
      servers: [{ serverId: "srv_1", serverLabel: "Acme" }],
    });
    expect(typeof (tools as any).loadSkill.needsApproval).toBe("function");
    expect(typeof (tools as any).readSkillFile.needsApproval).toBe("function");
  });

  it("applyPrepareAdvertisedTools narrows NAMES and never touches a tool", () => {
    // The odd one out: it returns a name list, so it cannot drop a declaration
    // by rebuilding a tool. Pinned anyway because the review question is "does
    // every wrapper preserve it", and "this one has no tools to preserve" is an
    // answer that should be visible rather than an omission from the list.
    const tools = fixture() as Record<string, any>;
    const narrowed = applyPrepareAdvertisedTools({
      defaultToolNames: Object.keys(tools),
      stepIndex: 0,
      prepareAdvertisedTools: ({ defaultToolNames }) =>
        defaultToolNames.filter((name) => name !== "undeclared"),
    });
    expect(narrowed).toEqual(["always_true", "always_false", "function_form"]);
    expectDeclarationsPreserved(tools);
  });
});

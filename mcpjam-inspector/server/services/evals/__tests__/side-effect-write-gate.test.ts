/**
 * The per-call write gate: what a benchmark case may call a tool WITH.
 *
 * The classification gate decides which tools may be called at all. That is
 * not a bound on anything by itself — "may call `create_page`" covers creating
 * a page named for this run and overwriting the operator's homepage equally —
 * so every rule here is about the arguments.
 *
 * Both existing gate invariants are re-asserted alongside the new rules,
 * because they are load-bearing and now live on a wrapper that also runs for
 * ALLOWED tools: a block emits no tool span (the trace wrapper elides marked
 * results) and `isToolPolicyBlockResult` recognizes it.
 */

import { describe, expect, it, vi } from "vitest";
import {
  benchmarkEnforcementPolicy,
  createToolPolicyGate,
  inspectSideEffects,
  isToolPolicyBlockResult,
  toolAnnotationsKey,
} from "../tool-policy-gate";
import { createBenchmarkArtifactLedger } from "../artifact-ledger";
import { resolveEnforcementGate } from "../../evals-runner";
import type { ResolvedCaseSideEffects } from "../side-effect-manifest";

const RUN_ID = "brun-1";

const MANIFEST: Extract<ResolvedCaseSideEffects, { mode: "test_write" }> = {
  mode: "test_write",
  summary: "creates one page and then updates it",
  allowedTools: ["create_page", "update_page", "list_pages"],
  createRules: [
    {
      tool: "create_page",
      artifactNamePath: "page.title",
      requiredPrefix: "mcpjam-benchmark-",
      createdIdResultPaths: ["structuredContent.id"],
    },
  ],
  mutationTargetPaths: ["page_id"],
  cleanupSteps: [{ tool: "delete_page", idArgPath: "page_id" }],
};

function gateFor(options?: {
  sideEffects?: ResolvedCaseSideEffects;
  requireManifest?: boolean;
  iteration?: number;
  execute?: (input: unknown, options?: unknown) => Promise<unknown>;
}) {
  const ledger = createBenchmarkArtifactLedger();
  const execute =
    options?.execute ?? vi.fn().mockResolvedValue({ content: [] });
  const gate = createToolPolicyGate({
    policy: { mode: "default" },
    annotations: new Map([
      [toolAnnotationsKey("server-1", "list_pages"), { readOnlyHint: true }],
    ]),
    sideEffectGate: {
      // `in`, not a truthiness check: a test asserting the fail-closed arm
      // passes `sideEffects: undefined` on purpose.
      sideEffects:
        options && "sideEffects" in options ? options.sideEffects : MANIFEST,
      benchmarkRunId: RUN_ID,
      iteration: options?.iteration ?? 0,
      ledger,
      requireManifest: options?.requireManifest ?? true,
    },
  });
  const wrapped = gate.wrap({
    create_page: { _serverId: "server-1", execute },
    update_page: { _serverId: "server-1", execute },
    list_pages: { _serverId: "server-1", execute },
    delete_page: { _serverId: "server-1", execute },
  } as never);
  return { gate, wrapped, ledger, execute };
}

describe("side-effect write gate", () => {
  it("blocks a create whose artifact name is not scoped to this run and iteration", async () => {
    const { wrapped, gate, execute } = gateFor();

    const result = await wrapped.create_page.execute!(
      { page: { title: "Quarterly plan" } },
      { toolCallId: "call-1" } as never,
    );

    // BEFORE the MCP call: a check after the fact is a report about damage,
    // not a bound on it.
    expect(execute).not.toHaveBeenCalled();
    expect(isToolPolicyBlockResult(result)).toBe(true);
    expect(gate.blocks).toMatchObject([
      { toolName: "create_page", reason: "sideEffectArtifactPrefix" },
    ]);
    expect(gate.blockedToolCallIds()).toEqual(new Set(["call-1"]));
  });

  it("scopes the required prefix per iteration, not per run", async () => {
    // A list-style case must not be able to observe a sibling ITERATION's
    // artifacts and grade a leak that is ours.
    const { wrapped, execute } = gateFor({ iteration: 3 });
    await wrapped.create_page.execute!(
      { page: { title: `mcpjam-benchmark-${RUN_ID}-0-alpha` } },
      {} as never,
    );
    expect(execute).not.toHaveBeenCalled();

    await wrapped.create_page.execute!(
      { page: { title: `mcpjam-benchmark-${RUN_ID}-3-alpha` } },
      {} as never,
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("harvests the created id into the ledger", async () => {
    const execute = vi
      .fn()
      .mockResolvedValue({ structuredContent: { id: "page-77" } });
    const { wrapped, ledger } = gateFor({ execute });

    await wrapped.create_page.execute!(
      { page: { title: `mcpjam-benchmark-${RUN_ID}-0-alpha` } },
      {} as never,
    );

    expect(ledger.has("page-77")).toBe(true);
    expect(ledger.entries()).toMatchObject([
      {
        tool: "create_page",
        createdId: "page-77",
        artifactName: `mcpjam-benchmark-${RUN_ID}-0-alpha`,
        cleanupSteps: [{ tool: "delete_page", idArgPath: "page_id" }],
      },
    ]);
  });

  it("blocks a mutation aimed at something this run did not create", async () => {
    const { wrapped, gate, execute } = gateFor();

    const result = await wrapped.update_page.execute!(
      { page_id: "someone-elses-page" },
      {} as never,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(isToolPolicyBlockResult(result)).toBe(true);
    expect(gate.blocks).toMatchObject([
      { toolName: "update_page", reason: "sideEffectMutationTargetUnknown" },
    ]);
  });

  it("allows a mutation aimed at an id the ledger holds", async () => {
    const execute = vi
      .fn()
      .mockResolvedValue({ structuredContent: { id: "page-77" } });
    const { wrapped, gate, ledger } = gateFor({ execute });

    await wrapped.create_page.execute!(
      { page: { title: `mcpjam-benchmark-${RUN_ID}-0-alpha` } },
      {} as never,
    );
    // The create is what makes the update legal: harvesting and the ledger
    // check are one mechanism, not two.
    expect(ledger.has("page-77")).toBe(true);
    await wrapped.update_page.execute!({ page_id: "page-77" }, {} as never);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(gate.blocks).toHaveLength(0);
  });

  it("blocks a tool the manifest does not list, read or not", async () => {
    // The list is what makes a write case's blast radius reviewable at publish
    // time; a manifest that silently permitted whatever it forgot to mention
    // would not be a bound.
    const { wrapped, gate, execute } = gateFor();

    await wrapped.delete_page.execute!({ page_id: "page-77" }, {} as never);

    expect(execute).not.toHaveBeenCalled();
    expect(gate.blocks).toMatchObject([
      { toolName: "delete_page", reason: "sideEffectToolNotAllowed" },
    ]);
  });

  it("blocks everything when a write case arrives with no manifest", async () => {
    const { wrapped, gate, execute } = gateFor({
      sideEffects: undefined,
      requireManifest: true,
    });

    await wrapped.list_pages.execute!({}, {} as never);

    expect(execute).not.toHaveBeenCalled();
    expect(gate.blocks).toMatchObject([
      { toolName: "list_pages", reason: "sideEffectManifestMissing" },
    ]);
  });

  it("leaves a read-only case alone", async () => {
    // A `read_only` manifest IS a manifest: it declares that this case makes no
    // writes, which is a statement rather than an absence. The same call under
    // the write manifest is refused, which is what makes this an exemption
    // rather than the gate simply not running.
    const { wrapped, gate, execute } = gateFor({
      sideEffects: { mode: "read_only" },
    });

    await wrapped.delete_page.execute!({ page_id: "anything" }, {} as never);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(gate.blocks).toHaveLength(0);

    const write = gateFor();
    await write.wrapped.delete_page.execute!(
      { page_id: "anything" },
      {} as never,
    );
    expect(write.execute).not.toHaveBeenCalled();
  });

  it("still blocks a classification denial when a manifest is in force", async () => {
    // The manifest ADDS a bound; it never lifts one.
    const execute = vi.fn().mockResolvedValue({ content: [] });
    const ledger = createBenchmarkArtifactLedger();
    const gate = createToolPolicyGate({
      policy: { mode: "default" },
      annotations: new Map([
        [toolAnnotationsKey("server-1", "create_page"), { destructiveHint: true }],
      ]),
      sideEffectGate: {
        sideEffects: MANIFEST,
        benchmarkRunId: RUN_ID,
        iteration: 0,
        ledger,
        requireManifest: true,
      },
    });
    const wrapped = gate.wrap({
      create_page: { _serverId: "server-1", execute },
    } as never);

    await wrapped.create_page.execute!(
      { page: { title: `mcpjam-benchmark-${RUN_ID}-0-alpha` } },
      {} as never,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(gate.blocks).toMatchObject([
      { toolName: "create_page", reason: "destructiveDefaultDeny" },
    ]);
  });

  it("leaves an allowed client-fulfilled tool client-fulfilled", () => {
    // No local `execute` means the AI SDK hands the call back to the caller to
    // answer, so it never reaches the target through us. Injecting one here
    // would turn it into a silent no-op.
    const gate = createToolPolicyGate({
      policy: { mode: "default" },
      annotations: new Map(),
      sideEffectGate: {
        sideEffects: MANIFEST,
        benchmarkRunId: RUN_ID,
        iteration: 0,
        ledger: createBenchmarkArtifactLedger(),
        requireManifest: true,
      },
    });
    const wrapped = gate.wrap({
      list_pages: { _serverId: "server-1", description: "client fulfilled" },
    } as never);

    expect(wrapped.list_pages.execute).toBeUndefined();
  });

  it("does not wrap internal tools, which reach no third party", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [] });
    const gate = createToolPolicyGate({
      policy: { mode: "default" },
      annotations: new Map(),
      sideEffectGate: {
        sideEffects: MANIFEST,
        benchmarkRunId: RUN_ID,
        iteration: 0,
        ledger: createBenchmarkArtifactLedger(),
        requireManifest: true,
      },
    });
    const wrapped = gate.wrap({ bash: { execute } } as never);

    await wrapped.bash.execute!({}, {} as never);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(gate.blocks).toHaveLength(0);
  });
});

describe("benchmarkEnforcementPolicy", () => {
  // THE FINDING THESE LOCK: the side-effect manifest was only attached inside
  // `toolPolicy ? createToolPolicyGate(…) : null`. A benchmark write cell
  // arrives with a `benchmarkWriteGuard` and NO `toolPolicy` — the claim does
  // not carry one — so the gate came out `null` and nothing was enforced: no
  // allowed-tool check, no argument or prefix validation, no id harvesting,
  // and therefore no cleanup either. The guard has to stand up its own
  // enforcement gate, independent of that unrelated optional field.

  it("exempts exactly the manifest's allowed tools from the classification layer", () => {
    expect(
      benchmarkEnforcementPolicy({
        sideEffects: MANIFEST,
        benchmarkRunId: RUN_ID,
        iteration: 0,
        ledger: createBenchmarkArtifactLedger(),
        requireManifest: true,
      }),
    ).toEqual({
      mode: "default",
      allow: ["create_page", "update_page", "list_pages"],
    });
  });

  it("allows nothing when the manifest is missing", () => {
    // Strictest at exactly the moment there are no rules to apply.
    expect(
      benchmarkEnforcementPolicy({
        sideEffects: undefined,
        benchmarkRunId: RUN_ID,
        iteration: 0,
        ledger: createBenchmarkArtifactLedger(),
        requireManifest: true,
      }),
    ).toEqual({ mode: "default", allow: [] });
  });

  it("enforces the manifest on a gate the write guard stood up alone", async () => {
    // The end-to-end shape of the defect: a gate built from the guard's own
    // policy, with no suite-authored `toolPolicy` anywhere.
    const ledger = createBenchmarkArtifactLedger();
    const execute = vi.fn().mockResolvedValue({ content: [] });
    const sideEffectGate = {
      sideEffects: MANIFEST,
      benchmarkRunId: RUN_ID,
      iteration: 0,
      ledger,
      requireManifest: true,
    };
    const gate = createToolPolicyGate({
      policy: benchmarkEnforcementPolicy(sideEffectGate),
      annotations: new Map(),
      sideEffectGate,
    });
    const wrapped = gate.wrap({
      create_page: { _serverId: "server-1", execute },
      delete_page: { _serverId: "server-1", execute },
    } as never);

    // Not on the manifest's list: refused.
    const denied = await (wrapped as never as Record<string, { execute: Function }>)
      .delete_page.execute({ page_id: "x" }, { toolCallId: "c1" });
    expect(isToolPolicyBlockResult(denied)).toBe(true);

    // On the list, but named outside this run's prefix: refused.
    const misnamed = await (wrapped as never as Record<string, { execute: Function }>)
      .create_page.execute({ page: { title: "the operator's page" } }, {
        toolCallId: "c2",
      });
    expect(isToolPolicyBlockResult(misnamed)).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it("harvests ids on a guard-only gate, so the cleanup ledger is not empty", async () => {
    const ledger = createBenchmarkArtifactLedger();
    const sideEffectGate = {
      sideEffects: MANIFEST,
      benchmarkRunId: RUN_ID,
      caseId: "case-1",
      iteration: 0,
      ledger,
      requireManifest: true,
    };
    const gate = createToolPolicyGate({
      policy: benchmarkEnforcementPolicy(sideEffectGate),
      annotations: new Map(),
      sideEffectGate,
    });
    const wrapped = gate.wrap({
      create_page: {
        _serverId: "server-1",
        execute: vi
          .fn()
          .mockResolvedValue({ structuredContent: { id: "page-1" } }),
      },
    } as never);

    await (wrapped as never as Record<string, { execute: Function }>)
      .create_page.execute(
        { page: { title: `mcpjam-benchmark-${RUN_ID}-0-notes` } },
        { toolCallId: "c1" },
      );

    expect(ledger.entries()).toEqual([
      expect.objectContaining({
        createdId: "page-1",
        caseId: "case-1",
        iteration: 0,
      }),
    ]);
  });

  it("does not return a create's result until the id is durable", async () => {
    // The next mutation cannot be issued before the model sees this result, so
    // awaiting the flush here is what makes "recorded durably before the next
    // mutation" true.
    let release!: () => void;
    const landed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ledger = createBenchmarkArtifactLedger({
      persist: async () => {
        await landed;
      },
    });
    const sideEffectGate = {
      sideEffects: MANIFEST,
      benchmarkRunId: RUN_ID,
      iteration: 0,
      ledger,
      requireManifest: true,
    };
    const gate = createToolPolicyGate({
      policy: benchmarkEnforcementPolicy(sideEffectGate),
      annotations: new Map(),
      sideEffectGate,
    });
    const wrapped = gate.wrap({
      create_page: {
        _serverId: "server-1",
        execute: vi
          .fn()
          .mockResolvedValue({ structuredContent: { id: "page-1" } }),
      },
    } as never);

    let returned = false;
    const call = (wrapped as never as Record<string, { execute: Function }>)
      .create_page.execute(
        { page: { title: `mcpjam-benchmark-${RUN_ID}-0-notes` } },
        { toolCallId: "c1" },
      )
      .then((result: unknown) => {
        returned = true;
        return result;
      });

    await Promise.resolve();
    await Promise.resolve();
    expect(returned).toBe(false);

    release();
    await call;
    expect(returned).toBe(true);
  });
});

describe("resolveEnforcementGate", () => {
  // THE FINDING THIS LOCKS, at the exact line it lived on: the gate was built
  // as `toolPolicy ? createToolPolicyGate(…) : null`, and `defaultRunEvalCell`
  // passes a `benchmarkWriteGuard` and never a `toolPolicy`.

  function guard(sideEffects?: ResolvedCaseSideEffects) {
    return {
      benchmarkRunId: RUN_ID,
      sideEffectsByCaseId: sideEffects ? { "case-1": sideEffects } : {},
      requireManifest: true,
      ledger: createBenchmarkArtifactLedger(),
    };
  }

  it("stands up a gate for a write guard with no suite tool policy", async () => {
    const gate = resolveEnforcementGate({
      benchmarkWriteGuard: guard(MANIFEST),
      testCaseId: "case-1",
      runIndex: 0,
      annotations: new Map(),
    });

    expect(gate).not.toBeNull();

    // And the manifest is actually in force on it, not merely constructed.
    const execute = vi.fn().mockResolvedValue({ content: [] });
    const wrapped = gate!.wrap({
      delete_page: { _serverId: "server-1", execute },
    } as never);
    const result = await (
      wrapped as never as Record<string, { execute: Function }>
    ).delete_page.execute({ page_id: "x" }, { toolCallId: "c1" });

    expect(isToolPolicyBlockResult(result)).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails closed for a write cell whose manifest never reached us", async () => {
    const gate = resolveEnforcementGate({
      benchmarkWriteGuard: guard(),
      testCaseId: "case-1",
      runIndex: 0,
      annotations: new Map(),
    });

    expect(gate).not.toBeNull();
    const execute = vi.fn().mockResolvedValue({ content: [] });
    const wrapped = gate!.wrap({
      create_page: { _serverId: "server-1", execute },
    } as never);
    const result = await (
      wrapped as never as Record<string, { execute: Function }>
    ).create_page.execute({ page: { title: "x" } }, { toolCallId: "c1" });

    expect(isToolPolicyBlockResult(result)).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps the suite's own policy when it has one, with the manifest on top", async () => {
    const gate = resolveEnforcementGate({
      toolPolicy: { mode: "readOnly" },
      benchmarkWriteGuard: guard(MANIFEST),
      testCaseId: "case-1",
      runIndex: 0,
      annotations: new Map(),
    });

    expect(gate?.policy).toEqual({ mode: "readOnly" });
    // An author who wrote `readOnly` meant it: the manifest adds a bound, it
    // does not lift one.
    const execute = vi.fn().mockResolvedValue({ content: [] });
    const wrapped = gate!.wrap({
      create_page: { _serverId: "server-1", execute },
    } as never);
    const result = await (
      wrapped as never as Record<string, { execute: Function }>
    ).create_page.execute(
      { page: { title: `mcpjam-benchmark-${RUN_ID}-0-notes` } },
      { toolCallId: "c1" },
    );
    expect(isToolPolicyBlockResult(result)).toBe(true);
  });

  it("is null when nothing restrains the iteration at all", () => {
    expect(
      resolveEnforcementGate({ runIndex: 0, annotations: new Map() }),
    ).toBeNull();
  });
});

describe("inspectSideEffects", () => {
  it("fans out over an array path so a second target cannot slip through", () => {
    const ledger = createBenchmarkArtifactLedger();
    ledger.record({
      tool: "create_page",
      artifactName: "n",
      createdId: "ours",
      cleanupSteps: [],
    });

    const refusal = inspectSideEffects({
      gate: {
        sideEffects: { ...MANIFEST, mutationTargetPaths: ["pages.*.id"] },
        benchmarkRunId: RUN_ID,
        iteration: 0,
        ledger,
        requireManifest: true,
      },
      toolName: "update_page",
      input: { pages: [{ id: "ours" }, { id: "theirs" }] },
    });

    expect(refusal).toMatchObject({
      reason: "sideEffectMutationTargetUnknown",
    });
  });

  it("refuses a create rule that pins a prefix outside the benchmark convention", () => {
    // A name an operator cannot recognize as ours on their own server is not a
    // benchmark artifact, whatever else the manifest got right.
    const refusal = inspectSideEffects({
      gate: {
        sideEffects: {
          ...MANIFEST,
          createRules: [
            { ...MANIFEST.createRules[0]!, requiredPrefix: "tmp-" },
          ],
        },
        benchmarkRunId: RUN_ID,
        iteration: 0,
        ledger: createBenchmarkArtifactLedger(),
        requireManifest: true,
      },
      toolName: "create_page",
      input: { page: { title: `tmp-${RUN_ID}-0-alpha` } },
    });

    expect(refusal).toMatchObject({ reason: "sideEffectArtifactPrefix" });
  });

  it("refuses a create whose name path selects nothing", () => {
    const refusal = inspectSideEffects({
      gate: {
        sideEffects: MANIFEST,
        benchmarkRunId: RUN_ID,
        iteration: 0,
        ledger: createBenchmarkArtifactLedger(),
        requireManifest: true,
      },
      toolName: "create_page",
      input: { page: {} },
    });

    expect(refusal).toMatchObject({ reason: "sideEffectArtifactPrefix" });
  });
});

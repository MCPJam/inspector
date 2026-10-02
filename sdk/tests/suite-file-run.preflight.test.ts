/**
 * Everything `runSuiteFile` refuses before it spends anything.
 *
 * Each refusal is asserted with its code, phase and category — the axis a
 * caller (the CLI's exit mapping) branches on — and with ZERO model
 * constructions and zero MCP traffic: the fixture server records every
 * JSON-RPC method it receives, so "nothing connected" is observed, not
 * assumed.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSuiteFileRunner } from "../src/suite-file-run/run-suite-file.js";
import { SuiteFileRunError } from "../src/suite-file-run/errors.js";
import { buildStageAuthoredCase } from "../src/contract/stage-authored-case.js";
import {
  HOSTED_JUDGE_DEFAULTS,
  preflightSuiteFile,
  resolveLocalJudgeState,
  suiteFileSourceHash,
} from "../src/suite-file-run/preflight.js";
import { planModel } from "../src/suite-file-run/inference.js";
import type { RunSuiteFileOptions } from "../src/suite-file-run/types.js";
import {
  servePolicyTargetFixture,
  type PolicyTargetFixture,
} from "./support/policy-target-fixture.js";
import { callThenAnswer, scriptedModel } from "./support/scripted-model.js";

const here = dirname(fileURLToPath(import.meta.url));

let fixture: PolicyTargetFixture;
beforeEach(async () => {
  fixture = await servePolicyTargetFixture();
});
afterEach(async () => {
  await fixture.close();
});

const promptCase = (id: string, extra = "") => `  - id: ${id}
    title: case ${id}
${extra}    steps:
      - id: s1
        kind: prompt
        prompt: Read note 7
      - id: a1
        kind: assert
        assertion:
          type: toolCalledAtLeastOnce
          toolName: read_note
`;

function suite(
  cases: string,
  header: { target?: string; defaults?: string } = {}
): string {
  // Imported cases need an auditable provenance block; native ones ignore it.
  const provenance = cases.includes("    import:")
    ? "provenance:\n  sourceHash: src-digest\n  sourceFormat: promptfoo\n  reportHash: report-digest\n"
    : "";
  return `schemaVersion: "2"
mode: agentWorkflow
reportingMode: standard
suite:
  id: s_preflight
  name: preflight
target:
${header.target ?? "  servers:\n    - name: notes"}
defaults:
${header.defaults ?? "  judge:\n    enabled: false"}
  model: anthropic/claude-haiku-4.5
  iterations: 1
  passThreshold: 1
  validity: {}
${provenance}cases:
${cases}`;
}

function harness() {
  const built: string[] = [];
  const { run } = createSuiteFileRunner({
    createLanguageModel: (model) => {
      built.push(model);
      return scriptedModel(
        model,
        callThenAnswer(() => ({ toolName: "read_note", input: { id: "7" } }))
      ) as never;
    },
  });
  return { run, built };
}

function options(
  extra: Partial<RunSuiteFileOptions> = {}
): RunSuiteFileOptions {
  return {
    servers: { notes: { config: { url: fixture.url } } },
    inference: { mode: "byok", providerKeys: { anthropic: "sk-ant-test" } },
    ...extra,
  };
}

async function refused(
  source: string,
  extra: Partial<RunSuiteFileOptions> = {}
): Promise<SuiteFileRunError> {
  const { run, built } = harness();
  const error = await run(source, options(extra)).then(
    () => {
      throw new Error("expected a refusal");
    },
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(SuiteFileRunError);
  expect(built).toEqual([]);
  expect(fixture.calls).toEqual({ read_note: 0, delete_note: 0, echo: 0 });
  return error as SuiteFileRunError;
}

describe("stage 1 — parse and select", () => {
  it("refuses an invalid file with its findings", async () => {
    const error = await refused("schemaVersion: '2'\ncases: []\n");
    expect(error).toMatchObject({
      code: "SUITE_FILE_INVALID",
      phase: "validation",
      category: "usage",
    });
    expect(fixture.methods).toEqual([]);
  });

  it("refuses unknown, duplicate and disabled ids — together", async () => {
    const error = await refused(
      suite(promptCase("c_a") + promptCase("c_b", "    disabled: true\n")),
      { caseIds: ["c_a", "c_a", "c_nope", "c_b"] }
    );
    expect(error.code).toBe("CASE_SELECTION_INVALID");
    const ids = error.details.problems!.map((problem) => problem.caseId);
    expect(ids).toEqual(["c_a", "c_nope", "c_b"]);
    expect(fixture.methods).toEqual([]);
  });

  it("refuses an empty selection and a file with nothing enabled", async () => {
    expect(
      (await refused(suite(promptCase("c_a")), { caseIds: [] })).code
    ).toBe("CASE_SELECTION_INVALID");
    expect(
      (await refused(suite(promptCase("c_a", "    disabled: true\n")))).code
    ).toBe("CASE_SELECTION_INVALID");
  });

  it("derives each case's stage inputs with the hosted runner's builder", () => {
    const asserting = `  - id: c_graded
    title: graded
    expectedOutput: the note says buy milk
    steps:
      - id: s1
        kind: prompt
        prompt: Read note 7
      - id: a1
        kind: assert
        assertion:
          type: toolCalledAtLeastOnce
          toolName: read_note
    assertions:
      - type: responseContains
        needle: milk
`;
    const [planned] = preflightSuiteFile(suite(asserting), options()).cases;
    const testCase = planned!.testCase;
    expect(planned!.stageCase).toEqual(
      buildStageAuthoredCase({
        test: {
          isNegativeTest: testCase.isNegativeTest,
          expectedOutput: testCase.expectedOutput,
          successPredicates: testCase.assertions,
        },
        steps: testCase.steps as never,
        caseNeedsModel: true,
      })
    );
    // A tool-call assertion expects a call and grades selection, not user
    // value: the response check and the expected output are what grade it.
    expect(planned!.stageCase).toEqual({
      mode: "model_driven",
      isNegativeTest: false,
      expectsToolCall: true,
      expectsWidgetRender: false,
      assertionCount: 2,
    });
  });

  it("keeps authored order and records what was skipped and why", () => {
    const plan = preflightSuiteFile(
      suite(
        promptCase("c_a") +
          promptCase("c_b") +
          promptCase("c_c", "    disabled: true\n")
      ),
      { ...options(), caseIds: ["c_b", "c_a"] }
    );
    expect(plan.selection.selectedIds).toEqual(["c_a", "c_b"]);
    expect(plan.selection.skipped).toEqual([
      { caseId: "c_c", reason: "disabled" },
    ]);
    const one = preflightSuiteFile(
      suite(promptCase("c_a") + promptCase("c_b")),
      {
        ...options(),
        caseIds: ["c_b"],
      }
    );
    expect(one.selection.skipped).toEqual([
      { caseId: "c_a", reason: "notSelected" },
    ]);
  });

  it("hashes the original bytes, independent of the selection", () => {
    const source = suite(promptCase("c_a") + promptCase("c_b"));
    const all = preflightSuiteFile(source, options());
    const one = preflightSuiteFile(source, { ...options(), caseIds: ["c_b"] });
    expect(all.sourceHash).toBe(one.sourceHash);
    expect(all.sourceHash).toBe(suiteFileSourceHash(source));
    // sha256("abc")
    expect(suiteFileSourceHash("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});

describe("stage 2 — every selected case is validated before anything runs", () => {
  it("a valid first case followed by a direct tool call costs zero model and tool calls", async () => {
    const toolCall = `  - id: c_direct
    title: direct call
    steps:
      - id: call1
        kind: toolCall
        serverName: notes
        toolName: read_note
        arguments: { id: "7" }
`;
    const error = await refused(suite(promptCase("c_ok") + toolCall));
    expect(error).toMatchObject({
      code: "CASE_UNSUPPORTED",
      category: "unsupported",
    });
    const [problem] = error.details.problems!;
    expect(problem).toMatchObject({
      caseId: "c_direct",
      stepId: "call1",
      reason: "toolCallStep",
    });
    expect(error.message).toContain("mcpjam cloud eval run --file");
    expect(fixture.methods).toEqual([]);
  });

  it("refuses widget, render and discovery assertions, and suite-standard suppressions", async () => {
    const widget = `  - id: c_widget
    title: widget
    suppressedSuiteStandardCheckIds: ["response.errors"]
    steps:
      - id: s1
        kind: prompt
        prompt: Show it
      - id: w1
        kind: assert
        assertion:
          type: widgetRendered
      - id: d1
        kind: assert
        assertion:
          type: toolDescriptionsPresent
`;
    const error = await refused(suite(widget));
    const reasons = error.details
      .problems!.map((problem) => problem.reason)
      .sort();
    expect(reasons).toEqual([
      "discoveryAssertion",
      "renderAssertion",
      "suppressedSuiteStandardChecks",
    ]);
  });

  it("refuses gating checks on tool results or per-call latency, which a local run does not capture", async () => {
    const unmeasured = `  - id: c_results
    title: results and latency
    steps:
      - id: s1
        kind: prompt
        prompt: Read note 7
      - id: r1
        kind: assert
        assertion:
          type: toolResultContains
          needle: milk
    assertions:
      - type: toolLatencyUnder
        ms: 5000
      - type: toolResultSizeUnder
        maxBytes: 64000
        role: advisory
      - type: fullPageHasContinuation
        role: advisory
`;
    const error = await refused(suite(unmeasured));
    expect(error).toMatchObject({
      code: "CASE_UNSUPPORTED",
      category: "unsupported",
    });
    const problems = error.details.problems!;
    // Only the GATING ones: an advisory check never decides a verdict.
    expect(problems.map((problem) => problem.reason)).toEqual([
      "toolResultAssertion",
      "toolResultAssertion",
    ]);
    expect(problems[0]).toMatchObject({ caseId: "c_results", stepId: "r1" });
    expect(problems[1]).toMatchObject({ pointer: "assertions[0]" });
    expect(error.message).toContain("mcpjam cloud eval run --file");
    expect(fixture.methods).toEqual([]);
  });

  it("refuses an effective gating judge, honours a case-level disable, and records advisory judges", async () => {
    const gating = suite(
      promptCase("c_a") +
        promptCase("c_b", "    judge:\n      enabled: false\n"),
      {
        defaults: "  judge:\n    role: gating",
      }
    );
    const error = await refused(gating);
    expect(error).toMatchObject({
      code: "JUDGE_UNSUPPORTED",
      category: "unsupported",
    });
    expect(error.details.problems!.map((problem) => problem.caseId)).toEqual([
      "c_a",
    ]);

    const advisory = preflightSuiteFile(
      suite(promptCase("c_a"), { defaults: "  judge:\n    role: advisory" }),
      options()
    );
    expect(advisory.cases[0]!.judge).toMatchObject({
      configured: true,
      run: false,
      skipReason: "localJudgeUnsupported",
      effective: { enabled: true, role: "advisory", autoRun: true },
    });
    expect(advisory.warnings.join(" ")).toContain("advisory LLM judge");
  });

  it("an absent judge block inherits the hosted defaults — advisory, recorded, never run", () => {
    const plan = preflightSuiteFile(
      suite(promptCase("c_a"), { defaults: "" }),
      options()
    );
    expect(plan.cases[0]!.judge).toMatchObject({
      configured: false,
      effective: { enabled: true, autoRun: true, role: "advisory" },
      skipReason: "localJudgeUnsupported",
    });
    // An expected output alone never makes a judge run locally.
    expect(
      plan.cases[0]!.test.getEvaluationConfigSnapshot().definitions.map(
        (d) => d.scorerId
      )
    ).not.toContain("goal-completion");
  });

  it("mirrors the hosted judge defaults (drift guard)", () => {
    const shared = readFileSync(
      join(here, "../../mcpjam-inspector/shared/judge-defaults.ts"),
      "utf8"
    );
    const block = shared.slice(
      shared.indexOf("export const GOAL_COMPLETION_DEFAULTS")
    );
    expect(block).toMatch(
      new RegExp(`enabled:\\s*${HOSTED_JUDGE_DEFAULTS.enabled}`)
    );
    expect(block).toMatch(
      new RegExp(`autoRun:\\s*${HOSTED_JUDGE_DEFAULTS.autoRun}`)
    );
    expect(block).toMatch(
      new RegExp(`role:\\s*"${HOSTED_JUDGE_DEFAULTS.role}"`)
    );
  });

  it("resolves the judge with the hosted layering", () => {
    const base = {
      id: "c",
      title: "t",
      steps: [],
      assertions: [],
      isNegativeTest: false,
      model: "m",
      iterations: 1,
      passThreshold: 1,
      disabled: false,
    };
    expect(
      resolveLocalJudgeState(
        { enabled: false },
        { ...base, judge: { enabled: true } }
      ).effective.enabled
    ).toBe(true);
    expect(resolveLocalJudgeState({ autoRun: false }, base).skipReason).toBe(
      "notAutomatic"
    );
    expect(resolveLocalJudgeState({ enabled: false }, base).skipReason).toBe(
      "disabled"
    );
  });

  it("refuses a contradictory negative case as invalid input", async () => {
    const negative = `  - id: c_neg
    title: negative
    isNegativeTest: true
    steps:
      - id: s1
        kind: prompt
        prompt: Do nothing
      - id: a1
        kind: assert
        assertion:
          type: toolCalledWith
          toolName: read_note
          args: { args: {} }
`;
    const error = await refused(suite(negative));
    expect(error).toMatchObject({ code: "CASE_INVALID", category: "usage" });
  });
});

describe("stage 2 — imports and approvals", () => {
  const imported = (id: string, status: string) =>
    promptCase(
      id,
      `    import:\n      status: ${status}\n      sourceCaseKey: src-${id}\n      note: mapped by rule r1\n`
    );

  it("runs native and claimed-exact cases without approval", async () => {
    const { run } = harness();
    const result = await run(
      suite(promptCase("c_native") + imported("c_exact", "exact")),
      options()
    );
    expect(result.verdict).toBe("passed");
    expect(result.cases[1]!.import).toEqual({
      status: "exact",
      sourceCaseKey: "src-c_exact",
    });
    expect(result.report.metadata.cases[1]!.import?.status).toBe("exact");
  });

  it("requires a reason for an approximated case, and records local evidence when given", async () => {
    const source = suite(imported("c_approx", "approximated"));
    const error = await refused(source);
    expect(error).toMatchObject({
      code: "IMPORT_INELIGIBLE",
      category: "import",
    });
    expect(error.details.problems![0]!.reason).toBe("approval_required");

    const { run } = harness();
    const result = await run(
      source,
      options({
        importApprovals: [
          { caseId: "c_approx", reason: "  reviewed by hand  " },
        ],
      })
    );
    expect(result.cases[0]!.import?.approval).toMatchObject({
      reason: "reviewed by hand",
      actor: "local-invocation",
    });
  });

  it("never runs unsupported or unresolved imports", async () => {
    const error = await refused(
      suite(imported("c_u", "unsupported") + imported("c_r", "unresolved")),
      { importApprovals: [{ caseId: "c_u", reason: "please" }] }
    );
    expect(error.details.problems!.map((problem) => problem.reason)).toEqual([
      "unsupported_case",
      "unresolved_case",
    ]);
  });

  it("refuses approvals that apply to nothing", async () => {
    const source = suite(
      promptCase("c_native") +
        imported("c_exact", "exact") +
        imported("c_off", "approximated").replace(
          "    import:",
          "    disabled: true\n    import:"
        ) +
        imported("c_other", "approximated")
    );
    const error = await refused(source, {
      caseIds: ["c_native", "c_exact"],
      importApprovals: [
        { caseId: "c_native", reason: "x" },
        { caseId: "c_exact", reason: "x" },
        { caseId: "c_off", reason: "x" },
        { caseId: "c_other", reason: "x" },
        { caseId: "c_missing", reason: "x" },
        { caseId: "c_missing", reason: "x" },
        { caseId: "c_blank", reason: "   " },
      ],
    });
    const pairs = error.details.problems!.map(
      (problem) => `${problem.caseId}:${problem.reason}`
    );
    expect(pairs.sort()).toEqual(
      [
        "c_blank:invalid_approval_reason",
        "c_exact:approval_not_required",
        // Named twice, AND not a declared case: both are reported.
        "c_missing:duplicate_approval",
        "c_missing:approval_case_unknown",
        "c_native:approval_case_not_imported",
        "c_off:approval_case_disabled",
        "c_other:approval_case_not_selected",
      ].sort()
    );
  });
});

describe("stage 3 — execution inputs", () => {
  it("refuses an environment-only target and duplicate server names", async () => {
    expect(
      (
        await refused(
          suite(promptCase("c_a"), { target: "  environment: staging" })
        )
      ).code
    ).toBe("TARGET_UNSUPPORTED");
    const dup = await refused(
      suite(promptCase("c_a"), {
        target: "  servers:\n    - name: notes\n    - name: notes",
      })
    );
    expect(dup).toMatchObject({
      code: "TARGET_UNSUPPORTED",
      category: "usage",
    });
  });

  it("records declared hosts and environment without executing or resolving them", () => {
    const plan = preflightSuiteFile(
      suite(promptCase("c_a"), {
        target:
          "  servers:\n    - name: notes\n  environment: staging\n  hosts:\n    - name: Claude\n      servers:\n        - name: notes",
      }),
      options()
    );
    expect(plan.declaredEnvironment).toBe("staging");
    expect(plan.declaredHosts).toEqual([
      { name: "Claude", servers: ["notes"] },
    ]);
    expect(plan.warnings.join(" ")).toContain("not resolved");
  });

  it("refuses an unknown host template", async () => {
    const error = await refused(suite(promptCase("c_a")), {
      hostTemplateId: "netscape",
    });
    expect(error).toMatchObject({
      code: "HOST_TEMPLATE_UNKNOWN",
      category: "usage",
    });
  });

  it("refuses bindings for names the suite does not target, and lists every missing binding", async () => {
    expect(
      (
        await refused(suite(promptCase("c_a")), {
          servers: {
            notes: { config: { url: fixture.url } },
            typo: { config: { url: fixture.url } },
          },
        })
      ).code
    ).toBe("SERVER_BINDING_INVALID");
    const missing = await refused(
      suite(promptCase("c_a"), {
        target:
          "  servers:\n    - name: notes\n    - name: tasks\n    - name: mail",
      }),
      { servers: { notes: { config: { url: fixture.url } } } }
    );
    expect(missing).toMatchObject({
      code: "SERVER_BINDING_MISSING",
      phase: "setup",
      category: "setup",
    });
    expect(missing.details.problems!.map((problem) => problem.server)).toEqual([
      "tasks",
      "mail",
    ]);
    expect(fixture.methods).toEqual([]);
  });

  it("refuses conflicting inference intent before connecting", async () => {
    const pinned = suite(
      promptCase("c_a", "    model: mcpjam/anthropic/claude-haiku-4.5\n")
    );
    const error = await refused(pinned);
    expect(error).toMatchObject({
      code: "INFERENCE_CONFLICT",
      category: "usage",
    });
    expect(fixture.methods).toEqual([]);
  });

  it("refuses missing BYOK keys as credentials, before connecting", async () => {
    const error = await refused(suite(promptCase("c_a")), {
      inference: { mode: "byok", providerKeys: {} },
    });
    expect(error).toMatchObject({
      code: "CREDENTIALS_MISSING",
      phase: "setup",
      category: "credentials",
    });
    expect(fixture.methods).toEqual([]);
  });

  it("refuses platform inference with no connection to resolve", async () => {
    const error = await refused(suite(promptCase("c_a")), {
      inference: { mode: "mcpjam" },
    });
    expect(error).toMatchObject({
      code: "CREDENTIALS_MISSING",
      category: "credentials",
    });
  });

  it("refuses a run that was cancelled before it started", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await refused(suite(promptCase("c_a")), {
      signal: controller.signal,
    });
    expect(error).toMatchObject({ code: "CANCELLED", category: "cancelled" });
  });

  it("refuses non-positive runner options", async () => {
    const error = await refused(suite(promptCase("c_a")), {
      concurrency: 0,
      maxSteps: 1.5,
    });
    expect(error).toMatchObject({ code: "OPTIONS_INVALID", category: "usage" });
  });
});

describe("inference planning", () => {
  const plan = (
    model: string,
    mode: "auto" | "byok" | "mcpjam",
    keys: Record<string, string> = {},
    provider?: string
  ) =>
    planModel({
      model,
      mode,
      providerKeys: keys,
      ...(provider ? { provider } : {}),
    });

  it("auto: a supplied key wins; no key falls to MCPJam when the platform serves the model", () => {
    expect(
      plan("anthropic/claude-haiku-4.5", "auto", { anthropic: "k" })
    ).toMatchObject({
      ok: true,
      plan: { rail: "byok", effectiveModel: "anthropic/claude-haiku-4.5" },
    });
    expect(plan("anthropic/claude-haiku-4.5", "auto")).toMatchObject({
      ok: true,
      plan: {
        rail: "mcpjam",
        effectiveModel: "mcpjam/anthropic/claude-haiku-4.5",
        canonicalModel: "anthropic/claude-haiku-4.5",
      },
    });
    // Not platform-served, no key: BYOK, so the missing key is the refusal.
    expect(plan("google/gemini-2.5-pro", "auto")).toMatchObject({
      ok: true,
      plan: { rail: "byok", needsKey: true },
    });
  });

  it("an explicit mcpjam/ id is routing intent: honoured by auto, refused by byok", () => {
    expect(plan("mcpjam/openai/gpt-5.4-mini", "auto")).toMatchObject({
      ok: true,
      plan: { rail: "mcpjam" },
    });
    expect(plan("mcpjam/openai/gpt-5.4-mini", "byok")).toMatchObject({
      ok: false,
      code: "INFERENCE_CONFLICT",
    });
    expect(plan("mcpjam/google/gemini-2.5-pro", "mcpjam")).toMatchObject({
      ok: false,
      code: "MODEL_UNSUPPORTED",
    });
  });

  it("mcpjam mode requires a platform-served model", () => {
    expect(plan("google/gemini-2.5-pro", "mcpjam")).toMatchObject({
      ok: false,
      code: "MODEL_UNSUPPORTED",
    });
    expect(plan("openai/gpt-5.4-mini", "mcpjam")).toMatchObject({
      ok: true,
      plan: { rail: "mcpjam" },
    });
  });

  it("uses the provider hint for a bare model id and refuses a contradicting one", () => {
    expect(plan("claude-haiku-4.5", "byok", {}, "anthropic")).toMatchObject({
      ok: true,
      plan: { effectiveModel: "anthropic/claude-haiku-4.5" },
    });
    expect(plan("claude-haiku-4.5", "byok")).toMatchObject({
      ok: false,
      code: "MODEL_UNSUPPORTED",
    });
    expect(
      plan("anthropic/claude-haiku-4.5", "byok", {}, "openai")
    ).toMatchObject({
      ok: false,
      code: "INFERENCE_CONFLICT",
    });
  });

  it("refuses providers that need deployment configuration", () => {
    expect(plan("azure/gpt-4o", "byok")).toMatchObject({
      ok: false,
      code: "MODEL_UNSUPPORTED",
    });
    expect(plan("bedrock/claude", "byok")).toMatchObject({
      ok: false,
      code: "MODEL_UNSUPPORTED",
    });
  });
});

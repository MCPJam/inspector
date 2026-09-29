/**
 * `runSuiteFile` end to end: a real MCP server on a loopback socket, the real
 * manager, runner, corpus conversion, graders, policy gate and aggregator —
 * with only the language model replaced by a deterministic script (through
 * the internal runner seam, never a production switch).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APICallError } from "ai";
import { EvalTest } from "../src/EvalTest.js";
import { posthog } from "../src/telemetry.js";
import { createSuiteFileRunner } from "../src/suite-file-run/run-suite-file.js";
import { SuiteFileRunError } from "../src/suite-file-run/errors.js";
import type { RunSuiteFileOptions } from "../src/suite-file-run/types.js";
import {
  renderStructuredRunHtml,
  renderStructuredRunJUnitXml,
  renderStructuredRunJson,
} from "../src/structured-reporting.js";
import {
  servePolicyTargetFixture,
  type PolicyTargetFixture,
} from "./support/policy-target-fixture.js";
import {
  callThenAnswer,
  scriptedModel,
  type ScriptContext,
  type ScriptedStep,
} from "./support/scripted-model.js";

let fixture: PolicyTargetFixture;
let second: PolicyTargetFixture | undefined;

beforeEach(async () => {
  fixture = await servePolicyTargetFixture();
});

afterEach(async () => {
  await fixture.close();
  await second?.close();
  second = undefined;
});

type SuiteOptions = {
  toolPolicy?: string;
  judge?: string;
  iterations?: number;
  extraDefaults?: string;
  servers?: string[];
};

function suite(cases: string, options: SuiteOptions = {}): string {
  const servers = (options.servers ?? ["notes"])
    .map((name) => `    - name: ${name}`)
    .join("\n");
  return `schemaVersion: "2"
mode: agentWorkflow
reportingMode: standard
suite:
  id: s_local_runner_test
  name: local runner test
target:
  servers:
${servers}
defaults:
  judge:
    ${options.judge ?? "enabled: false"}
  model: anthropic/claude-haiku-4.5
  iterations: ${options.iterations ?? 1}
  passThreshold: 1
  validity: {}
${options.toolPolicy ? `  toolPolicy:\n${options.toolPolicy}\n` : ""}${options.extraDefaults ?? ""}cases:
${cases}`;
}

const readCase = `  - id: c_read
    title: reads the note
    steps:
      - id: s1
        kind: prompt
        prompt: Read note 7
      - id: a1
        kind: assert
        assertion:
          type: toolCalledWith
          toolName: read_note
          args:
            args: {}
`;

const deleteCase = `  - id: c_delete
    title: deletes the note
    steps:
      - id: s1
        kind: prompt
        prompt: Delete note 7
      - id: a1
        kind: assert
        assertion:
          type: toolCalledWith
          toolName: delete_note
          args:
            args: {}
`;

const answerCase = `  - id: c_answer
    title: answers after trying to delete
    steps:
      - id: s1
        kind: prompt
        prompt: Delete note 9 and tell me what happened
      - id: a1
        kind: assert
        assertion:
          type: finalAssistantMessageNonEmpty
`;

/** Pick a tool from the prompt's verb. */
const byVerb = callThenAnswer((context: ScriptContext) => {
  if (/delete/i.test(context.userText))
    return { toolName: "delete_note", input: { id: "7" } };
  if (/read/i.test(context.userText))
    return { toolName: "read_note", input: { id: "7" } };
  if (/echo/i.test(context.userText))
    return { toolName: "echo", input: { message: "hi" } };
  return null;
});

function runner(script: (context: ScriptContext) => ScriptedStep = byVerb) {
  const built: string[] = [];
  const runtime = createSuiteFileRunner({
    createLanguageModel: (model) => {
      built.push(model);
      return scriptedModel(model, script) as never;
    },
  });
  return { run: runtime.run, built };
}

function options(
  extra: Partial<RunSuiteFileOptions> = {}
): RunSuiteFileOptions {
  return {
    servers: {
      notes: { config: { url: fixture.url }, source: "test-binding" },
    },
    inference: { mode: "byok", providerKeys: { anthropic: "sk-ant-test-key" } },
    ...extra,
  };
}

describe("runSuiteFile — passing and failing cases", () => {
  it("passes a case whose expected tool was called, over a real MCP server", async () => {
    const { run, built } = runner();
    const result = await run(suite(readCase), options());

    expect(result.verdict).toBe("passed");
    expect(result.passed).toBe(true);
    expect(result.termination).toBe("completed");
    expect(result.complete).toBe(true);
    expect(result.decision?.verdict).toBe("passed");
    expect(fixture.calls.read_note).toBe(1);
    expect(built).toEqual(["anthropic/claude-haiku-4.5"]);
    const [only] = result.cases;
    expect(only?.state).toBe("completed");
    expect(only?.rail).toBe("byok");
    expect(only?.iterations[0]?.status).toBe("completed");
    expect(only?.iterations[0]?.taskVerdict).toBe("passed");
    expect(only?.evaluationConfigHash).toMatch(/^[0-9a-f]{64}$/);

    expect(result.report.kind).toBe("eval-local-run");
    expect(result.report.verdict).toBe("passed");
    expect(result.report.metadata.execution.mode).toBe("local");
    expect(result.report.metadata.execution.engine).toBe("emulated");
    expect(result.report.metadata.upload.requested).toBe(false);
    expect(result.report.metadata.suite.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.report.summary.total).toBe(1);
  });

  it("fails a case whose expected tool was not called — a measured failure", async () => {
    const { run } = runner(
      callThenAnswer(() => ({ toolName: "echo", input: { message: "nope" } }))
    );
    const result = await run(suite(readCase), options());
    expect(result.verdict).toBe("failed");
    expect(result.decision?.reasons).toEqual(["casePassRateBelowThreshold"]);
    expect(result.cases[0]?.iterations[0]?.taskVerdict).toBe("failed");
    expect(fixture.calls.echo).toBe(1);
    expect(fixture.calls.read_note).toBe(0);
    const junit = renderStructuredRunJUnitXml(result.report);
    expect(junit).toContain('failures="1"');
    expect(junit).toContain(
      '<property name="mcpjam.execution" value="local"/>'
    );
  });

  it("is inconclusive — never failed — when the provider errors", async () => {
    const { run } = runner(() => ({
      error: new APICallError({
        message: "upstream exploded",
        url: "https://api.anthropic.com/v1/messages",
        requestBodyValues: {},
        statusCode: 500,
        isRetryable: false,
      }),
    }));
    const result = await run(suite(readCase), options());
    expect(result.verdict).toBe("inconclusive");
    expect(result.decision?.verdict).toBe("inconclusive");
    const iteration = result.cases[0]!.iterations[0]!;
    expect(iteration.status).toBe("failed");
    expect(iteration.taskVerdict).toBeUndefined();
    expect(iteration.refusal).toBe("unavailable");
    const junit = renderStructuredRunJUnitXml(result.report);
    // No fabricated assertion failure for a provider outage.
    expect(junit).toContain('failures="0"');
    expect(junit).toContain("<skipped");
    const html = renderStructuredRunHtml(result.report);
    expect(html).toContain("Local run");
    expect(html).toContain("badge-neutral");
  });
});

describe("runSuiteFile — telemetry", () => {
  it("never emits SDK telemetry: the caller owns that decision", async () => {
    const capture = vi.spyOn(posthog, "capture").mockImplementation(() => {});
    try {
      // The control: a plain EvalTest run sends its anonymous ping.
      const stub = {
        run: async () => {
          throw new Error("unused");
        },
        resetPromptHistory: () => {},
        getPromptHistory: () => [],
        withOptions: () => stub,
      };
      await new EvalTest({
        id: "c_control",
        name: "control",
        test: async () => true,
      }).run(stub as never, { iterations: 1, mcpjam: { enabled: false } });
      expect(capture).toHaveBeenCalledTimes(1);
      capture.mockClear();

      const { run } = runner();
      const result = await run(suite(readCase + deleteCase), options());
      expect(result.cases).toHaveLength(2);
      expect(capture).not.toHaveBeenCalled();
    } finally {
      capture.mockRestore();
    }
  });
});

describe("runSuiteFile — tool policy", () => {
  const denyDelete = `    mode: default\n    deny:\n      - delete_note`;

  it("never lets a denied call reach the server, and grades the case normally", async () => {
    const { run } = runner();
    const result = await run(
      suite(deleteCase + answerCase, { toolPolicy: denyDelete }),
      options()
    );
    expect(fixture.calls.delete_note).toBe(0);
    const byId = new Map(result.cases.map((entry) => [entry.caseId, entry]));
    const requiresBlocked = byId.get("c_delete")!;
    const stillPasses = byId.get("c_answer")!;
    expect(requiresBlocked.aggregation?.verdict).toBe("failed");
    expect(stillPasses.aggregation?.verdict).toBe("passed");
    expect(result.verdict).toBe("failed");

    const block = requiresBlocked.iterations[0]!.policyBlocks[0]!;
    expect(block).toMatchObject({
      caseId: "c_delete",
      iterationNumber: 1,
      toolName: "delete_note",
      reason: "denyList",
      classification: "destructive",
    });
    expect(block.toolCallId).toMatch(/^call_/);
    // A refused call is not a graded call and not an executed tool span.
    expect(requiresBlocked.iterations[0]!.toolCalls).toEqual([]);
    const stage = requiresBlocked.iterations[0]!.stage as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(stage)).toContain("blockedByPolicy");
    expect(result.toolPolicy.blocks).toHaveLength(2);
    expect(result.toolPolicy.snapshot?.denied.delete_note?.reason).toBe(
      "denyList"
    );
  });

  it("readOnly mode blocks an unannotated tool and allows a read-only one", async () => {
    const echoCase = `  - id: c_echo
    title: echoes
    steps:
      - id: s1
        kind: prompt
        prompt: Echo hi
      - id: a1
        kind: assert
        assertion:
          type: finalAssistantMessageNonEmpty
`;
    const { run } = runner();
    const result = await run(
      suite(readCase + echoCase, { toolPolicy: "    mode: readOnly" }),
      options()
    );
    expect(fixture.calls.read_note).toBe(1);
    expect(fixture.calls.echo).toBe(0);
    expect(
      result.toolPolicy.blocks.map((block) => [block.toolName, block.reason])
    ).toEqual([["echo", "readOnlyModeUnclassified"]]);
  });

  it("an absent policy restrains nothing (no new read-only default)", async () => {
    const { run } = runner();
    const result = await run(suite(deleteCase), options());
    expect(fixture.calls.delete_note).toBe(1);
    expect(result.verdict).toBe("passed");
    expect(result.toolPolicy.snapshot).toBeUndefined();
  });

  it("default mode still denies a destructive tool by default", async () => {
    const { run } = runner();
    const result = await run(
      suite(deleteCase, { toolPolicy: "    mode: default" }),
      options()
    );
    expect(fixture.calls.delete_note).toBe(0);
    expect(result.toolPolicy.blocks[0]?.reason).toBe("destructiveDefaultDeny");
  });

  it("refuses an unmatched deny name as invalid policy, after discovery and before any model call", async () => {
    const { run, built } = runner();
    const error = await run(
      suite(readCase, {
        toolPolicy: "    mode: default\n    deny:\n      - delete_notes",
      }),
      options()
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(SuiteFileRunError);
    expect(error.code).toBe("TOOL_POLICY_INVALID");
    expect(error.category).toBe("policy");
    expect(built).toEqual([]);
    expect(fixture.calls.read_note).toBe(0);
  });

  it("warns — does not refuse — on an unmatched allow name", async () => {
    const { run } = runner();
    const result = await run(
      suite(readCase, {
        toolPolicy: "    mode: readOnly\n    allow:\n      - nothing_here",
      }),
      options()
    );
    expect(result.warnings.join("\n")).toContain("nothing_here");
  });

  it("keeps blocks with the iteration that produced them under concurrency", async () => {
    let calls = 0;
    const { run } = runner((context) => {
      if (context.afterToolResult) return { text: "done" };
      calls += 1;
      // Only the second generation of the run asks for the denied tool.
      return calls === 2
        ? { toolCalls: [{ toolName: "delete_note", input: { id: "1" } }] }
        : { toolCalls: [{ toolName: "read_note", input: { id: "1" } }] };
    });
    const result = await run(
      suite(answerCase, { toolPolicy: denyDelete, iterations: 3 }),
      options({ concurrency: 3 })
    );
    const perIteration = result.cases[0]!.iterations.map(
      (iteration) => iteration.policyBlocks.length
    );
    expect(perIteration.reduce((sum, count) => sum + count, 0)).toBe(1);
    for (const iteration of result.cases[0]!.iterations) {
      for (const block of iteration.policyBlocks) {
        expect(block.iterationNumber).toBe(iteration.iterationNumber);
      }
    }
  });

  it("refuses duplicate model-visible tool names across servers", async () => {
    second = await servePolicyTargetFixture({ name: "second" });
    const { run, built } = runner();
    const error = await run(
      suite(readCase, { servers: ["notes", "other"] }),
      options({
        servers: {
          notes: { config: { url: fixture.url } },
          other: { config: { url: second.url } },
        },
      })
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(SuiteFileRunError);
    expect(error.code).toBe("TOOL_NAME_CONFLICT");
    expect(built).toEqual([]);
  });
});

describe("runSuiteFile — conversations, iterations and models", () => {
  it("keeps one conversation per iteration across prompts", async () => {
    const twoPrompts = `  - id: c_two
    title: two prompts
    iterations: 2
    steps:
      - id: s1
        kind: prompt
        prompt: Read note 7
      - id: s2
        kind: prompt
        prompt: Now summarize it
      - id: a1
        kind: assert
        assertion:
          type: finalAssistantMessageNonEmpty
`;
    const seen: string[][] = [];
    const { run } = runner((context) => {
      if (!context.afterToolResult) seen.push(context.userTexts);
      return byVerb(context);
    });
    const result = await run(suite(twoPrompts), options());
    expect(result.verdict).toBe("passed");
    expect(seen).toEqual([
      ["Read note 7"],
      ["Read note 7", "Now summarize it"],
      ["Read note 7"],
      ["Read note 7", "Now summarize it"],
    ]);
  });

  it("runs each case on its own model", async () => {
    const other = readCase
      .replace("c_read", "c_read_openai")
      .replace(
        "    title: reads the note",
        "    title: reads the note on openai\n    model: openai/gpt-5.4-mini"
      );
    const { run, built } = runner();
    const result = await run(
      suite(readCase + other),
      options({
        inference: {
          mode: "byok",
          providerKeys: { anthropic: "sk-ant-test", openai: "sk-openai-test" },
        },
      })
    );
    expect(result.verdict).toBe("passed");
    expect(new Set(built)).toEqual(
      new Set(["anthropic/claude-haiku-4.5", "openai/gpt-5.4-mini"])
    );
    expect(result.cases.map((entry) => entry.effectiveModel)).toEqual([
      "anthropic/claude-haiku-4.5",
      "openai/gpt-5.4-mini",
    ]);
  });
});

describe("runSuiteFile — interruption and refusals during execution", () => {
  it("returns partial evidence on abort and never presents it as a completed gate", async () => {
    const controller = new AbortController();
    const { run } = runner((context) => {
      if (!context.afterToolResult)
        controller.abort(new Error("user pressed ctrl-c"));
      return byVerb(context);
    });
    const result = await run(
      suite(readCase + answerCase),
      options({ signal: controller.signal })
    );
    expect(result.termination).toBe("aborted");
    expect(result.complete).toBe(false);
    expect(result.verdict).toBe("notEstablished");
    expect(result.passed).toBe(false);
    expect(result.cases[1]?.state).toBe("notStarted");
    expect(
      result.cases[1]?.iterations.every(
        (iteration) => iteration.status === "cancelled"
      )
    ).toBe(true);
    const text = renderStructuredRunJUnitXml(result.report);
    expect(text).toContain('value="aborted"');
    expect(text).toContain("PARTIAL");
  });

  it("attributes a rejected BYOK key to credentials and stops scheduling work", async () => {
    const { run, built } = runner(() => ({
      error: new APICallError({
        message: "invalid x-api-key",
        url: "https://api.anthropic.com/v1/messages",
        requestBodyValues: {},
        statusCode: 401,
        isRetryable: false,
      }),
    }));
    const result = await run(suite(readCase + answerCase), options());
    expect(result.termination).toBe("stopped");
    expect(result.verdict).toBe("notEstablished");
    expect(result.cases[0]?.iterations[0]?.refusal).toBe("credentials");
    expect(result.cases[1]?.state).toBe("notStarted");
    expect(
      result.issues.some((issue) => issue.category === "credentials")
    ).toBe(true);
    // One case's worth of model construction; the second never started.
    expect(built).toHaveLength(1);
  });
});

describe("runSuiteFile — reports", () => {
  it("renders the same meaning in JSON, JUnit and HTML, escaping authored text", async () => {
    const hostile = readCase.replace(
      "title: reads the note",
      'title: "<script>alert(1)</script> & reads"'
    );
    const { run } = runner(
      callThenAnswer(() => ({ toolName: "echo", input: { message: "x" } }))
    );
    const result = await run(suite(hostile), options());
    const json = renderStructuredRunJson(result.report);
    expect(json.kind).toBe("eval-local-run");
    expect(json.verdict).toBe("failed");
    const html = renderStructuredRunHtml(result.report);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("upload off");
    const junit = renderStructuredRunJUnitXml(result.report);
    expect(junit).not.toContain("<script>");
    expect(junit).toContain('<property name="mcpjam.verdict" value="failed"/>');
  });
});

describe("runSuiteFile — emulated host", () => {
  it("applies the template's connection profile and lets authored settings win over its defaults", async () => {
    const connected: Array<Record<string, unknown>> = [];
    const models: Array<ReturnType<typeof scriptedModel>> = [];
    const { MCPClientManager } =
      await import("../src/mcp-client-manager/index.js");
    const { run } = createSuiteFileRunner({
      createLanguageModel: (model) => {
        const built = scriptedModel(model, byVerb);
        models.push(built);
        return built as never;
      },
      createClientManager: () => {
        const manager = new MCPClientManager({}, { lazyConnect: true });
        const connect = manager.connectToServer.bind(manager);
        manager.connectToServer = ((
          id: string,
          config: Record<string, unknown>,
          opts?: unknown
        ) => {
          connected.push(config);
          return connect(id, config as never, opts as never);
        }) as typeof manager.connectToServer;
        return manager;
      },
    });
    const authored = suite(readCase, {
      extraDefaults: "  systemPrompt: Be terse.\n  temperature: 0\n",
    });
    const result = await run(
      authored,
      options({ hostTemplateId: "claude-code" })
    );
    expect(result.verdict).toBe("passed");
    expect((connected[0]!.clientInfo as { name?: string }).name).toBe(
      "claude-code"
    );
    const system = models[0]!.prompts[0]![0]!;
    expect(system.role).toBe("system");
    expect(JSON.stringify(system.content)).toContain("Be terse.");
    const execution = result.report.metadata.execution;
    expect(execution.host.templateId).toBe("claude-code");
    expect(execution.host.clientInfo?.name).toBe("claude-code");
    expect(execution.settings).toMatchObject({
      systemPrompt: "authored",
      temperature: 0,
    });

    // Without authored settings the template's defaults apply.
    const plain = await run(
      suite(readCase),
      options({ hostTemplateId: "claude-code" })
    );
    expect(plain.report.metadata.execution.settings).toMatchObject({
      systemPrompt: "default",
      temperature: 1,
    });
    // And with no template, the SDK's own defaults.
    const bare = await run(suite(readCase), options());
    expect(bare.report.metadata.execution.host.templateId).toBeNull();
    expect(bare.report.metadata.execution.settings.temperature).toBeNull();
  });
});

describe("runSuiteFile — cleanup", () => {
  async function withCapturedManager() {
    const { MCPClientManager } =
      await import("../src/mcp-client-manager/index.js");
    const managers: InstanceType<typeof MCPClientManager>[] = [];
    const { run } = createSuiteFileRunner({
      createLanguageModel: (model) => scriptedModel(model, byVerb) as never,
      createClientManager: () => {
        const manager = new MCPClientManager({}, { lazyConnect: true });
        managers.push(manager);
        return manager;
      },
    });
    return { run, managers };
  }

  it("disconnects every owned server after a completed run", async () => {
    const { run, managers } = await withCapturedManager();
    await run(suite(readCase), options());
    expect(managers).toHaveLength(1);
    expect(managers[0]!.getConnectionStatus("notes")).toBe("disconnected");
  });

  it("disconnects after a setup refusal, and after an aborted run", async () => {
    const refusedRun = await withCapturedManager();
    await refusedRun
      .run(
        suite(readCase, {
          toolPolicy: "    mode: default\n    deny:\n      - nope",
        }),
        options()
      )
      .catch(() => {});
    expect(refusedRun.managers[0]!.getConnectionStatus("notes")).toBe(
      "disconnected"
    );

    const aborted = await withCapturedManager();
    const controller = new AbortController();
    const result = await aborted.run(suite(readCase + answerCase), {
      ...options(),
      signal: controller.signal,
      onProgress: (event) => {
        if (event.type === "caseStart") controller.abort(new Error("stop"));
      },
    });
    expect(result.termination).toBe("aborted");
    expect(aborted.managers[0]!.getConnectionStatus("notes")).toBe(
      "disconnected"
    );
  });

  it("treats a throwing progress observer as a warning, never a changed verdict", async () => {
    const { run } = runner();
    const result = await run(suite(readCase), {
      ...options(),
      onProgress: () => {
        throw new Error("observer bug");
      },
    });
    expect(result.verdict).toBe("passed");
    expect(result.warnings.join(" ")).toContain("onProgress observer failed");
  });
});

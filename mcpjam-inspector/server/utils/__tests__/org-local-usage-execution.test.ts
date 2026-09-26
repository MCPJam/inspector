/**
 * A local-runtime org turn under a saved `org` selection reports what it ran.
 *
 * End to end through the real pieces: `resolveTurnRuntime` resolves the
 * selection against `/stream/org/resolve` (runtime `local`), the direct
 * engine runs the turn on the resolved model, and `finalizeUsage` posts the
 * real `postLocalUsage` body to `/stream/org/local-usage`. Only the network
 * and the provider are faked (a fetch stub and an AI SDK mock model).
 *
 * The body must carry the selection and an `execution` record that passes
 * the backend's CLOSED record validator: no field outside the shape (a copy
 * of the check lives below, field for field), rail `local`, the connection
 * the selection names, and the attempt's real terminal outcome.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { jsonSchema, simulateReadableStream } from "ai";
import type { ModelSelection } from "@mcpjam/sdk";
import type { ModelDefinition } from "@/shared/types";

const modelCalls: Array<Record<string, unknown>> = [];
const modelBehaviour = vi.hoisted(() => ({
  current: "ok" as "ok" | "error" | "hang",
}));

function usage(input: number, output: number) {
  return {
    inputTokens: {
      total: input,
      noCache: input,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: output, text: output, reasoning: undefined },
  };
}

function mockModel() {
  return new MockLanguageModelV3({
    provider: "ollama",
    modelId: "llama3",
    doStream: async (options) => {
      modelCalls.push(options as unknown as Record<string, unknown>);
      if (modelBehaviour.current === "error") {
        // A provider failure after output began: the turn completes with an
        // engine error (a failure before any output throws out of the turn
        // instead, and posts nothing, as before).
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t1" },
              { type: "text-delta", id: "t1", delta: "Hel" },
              { type: "error", error: new Error("upstream exploded") },
              {
                type: "finish",
                finishReason: { unified: "error", raw: "error" },
                usage: usage(3, 1),
              },
            ],
          }),
        };
      }
      if (modelBehaviour.current === "hang") {
        const signal = (options as { abortSignal?: AbortSignal }).abortSignal;
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              signal?.addEventListener("abort", () =>
                controller.error(
                  Object.assign(new Error("aborted"), { name: "AbortError" }),
                ),
              );
            },
          }),
        };
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            {
              type: "response-metadata",
              id: "r1",
              modelId: "llama3:8b",
              timestamp: new Date(0),
            },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "Hello" },
            { type: "text-end", id: "t1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: usage(3, 2),
            },
          ],
        }),
      };
    },
  });
}

vi.mock("@mcpjam/sdk/model-factory", async () => {
  const actual = await vi.importActual<
    typeof import("@mcpjam/sdk/model-factory")
  >("@mcpjam/sdk/model-factory");
  return {
    ...actual,
    buildOrgModelFromResolvedConfig: () => mockModel(),
  };
});

import { resolveTurnRuntime } from "../resolve-turn-runtime.js";
import { runUnifiedAssistantTurn } from "../turn-execution.js";
import { postLocalUsage } from "../org-model-stream-handler.js";
import { buildLocalExecutionRecord } from "../local-execution-record.js";

// ── A copy of the backend's closed `executionRecordValidator` ───────────────

type Check = (value: unknown) => boolean;
const str: Check = (v) => typeof v === "string";
const num: Check = (v) => typeof v === "number" && Number.isFinite(v);
const lit =
  (...values: unknown[]): Check =>
  (v) =>
    values.includes(v);
const opt = (check: Check) => ({ check, optional: true });
const req = (check: Check) => ({ check, optional: false });
const union =
  (...checks: Check[]): Check =>
  (v) =>
    checks.some((c) => c(v));
const arr =
  (check: Check): Check =>
  (v) =>
    Array.isArray(v) && v.every(check);
function obj(
  fields: Record<string, { check: Check; optional: boolean }>,
): Check {
  return (v) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
    const record = v as Record<string, unknown>;
    if (Object.keys(record).some((key) => !(key in fields))) return false;
    return Object.entries(fields).every(([key, field]) =>
      record[key] === undefined ? field.optional : field.check(record[key]),
    );
  };
}
const rail = lit("gateway", "openrouter", "orgCloud", "local");
const connectionRef = union(
  obj({ kind: req(lit("orgProvider")), id: req(str) }),
  obj({
    kind: req(lit("localProvider")),
    providerKey: req(str),
    customProviderName: opt(str),
  }),
);
const effort = lit("none", "minimal", "low", "medium", "high", "xhigh", "max");
const modelSelection = obj({
  modelId: req(str),
  source: req(lit("hosted", "org", "local")),
  connectionRef: opt(connectionRef),
  nativeModelId: opt(str),
  settings: opt(obj({ reasoningEffort: opt(effort), temperature: opt(num) })),
  fallback: req(
    obj({
      provider: req(lit("none", "openrouter")),
      model: req(lit("none")),
    }),
  ),
});
const passesClosedExecutionRecord = obj({
  requested: req(
    union(
      modelSelection,
      obj({ source: req(lit("legacy")), modelId: req(str) }),
    ),
  ),
  resolved: req(
    obj({
      rail: req(rail),
      wireModelId: req(str),
      connectionRef: opt(connectionRef),
      nativeModelId: opt(str),
      offering: req(
        obj({
          rail: req(rail),
          providerKey: req(str),
          connectionLabel: opt(str),
          credentialVersion: opt(num),
          nativeModelId: opt(str),
        }),
      ),
    }),
  ),
  harness: opt(obj({ id: req(str), runtimeVersion: req(str) })),
  effectiveSettings: req(
    obj({
      reasoningEffort: opt(str),
      temperature: opt(num),
      maxOutputTokens: req(num),
    }),
  ),
  attempts: req(
    arr(
      obj({
        rail: req(rail),
        wireModelId: req(str),
        outcome: req(lit("ok", "error")),
        code: opt(str),
        at: req(num),
      }),
    ),
  ),
  upstreamModel: opt(str),
  deviation: opt(
    obj({
      kind: req(
        lit("provider_fallback", "model_substitution", "harness_substitution"),
      ),
      reason: req(str),
    }),
  ),
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const ORG_OLLAMA: ModelSelection = {
  modelId: "ollama/llama3",
  source: "org",
  connectionRef: { kind: "orgProvider", id: "orgprov_ollama_local_1" },
  nativeModelId: "llama3",
  settings: { temperature: 0.2 },
  fallback: { provider: "none", model: "none" },
};
const MODEL: ModelDefinition = {
  id: "llama3",
  name: "llama3",
  provider: "ollama",
  hosted: false,
};
const RESOLVE_SECRET = "sk-resolved-for-this-request-only";

const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

function localUsageBodies(): Array<Record<string, any>> {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).endsWith("/stream/org/local-usage"))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

let projectSeq = 0;

beforeEach(() => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
  modelCalls.length = 0;
  modelBehaviour.current = "ok";
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) =>
    String(url).endsWith("/stream/org/resolve")
      ? Response.json({
          ok: true,
          runtimeLocation: "local",
          provider: {
            providerKey: "ollama",
            baseUrl: "http://localhost:11434",
            apiKey: RESOLVE_SECRET,
            modelIds: ["llama3"],
          },
        })
      : Response.json({ ok: true, executionRecorded: true }),
  );
  globalThis.fetch = fetchMock as never;
});

afterEach(() => {
  vi.unstubAllEnvs();
  globalThis.fetch = originalFetch;
});

/** Resolve → run one local turn → finalize, the way a swarm turn does. */
async function runLocalOrgTurn(options: { abort?: boolean } = {}) {
  projectSeq += 1;
  const rt = await resolveTurnRuntime({
    modelDefinition: MODEL,
    projectId: `project-${projectSeq}`,
    authHeader: "Bearer user-token",
    sourceType: "swarm",
    chatSessionId: "chat-session-1",
    attribution: { journeyRunId: "journey-run-1" },
    modelSelection: ORG_OLLAMA,
    settings: { temperature: 0.2 },
    tools: {
      search: { inputSchema: jsonSchema({ type: "object", properties: {} }) },
    },
    messages: [
      { role: "user", content: [{ type: "image", image: "private-image" }] },
    ],
  });
  expect(rt.modelSource).toBe("local_byok");
  const controller = new AbortController();
  let engineError: { message: string } | undefined;
  const pending = runUnifiedAssistantTurn({
    runtime: rt.runtime,
    streamSink: "none",
    messages: [{ role: "user", content: "hi" }],
    systemPrompt: "",
    temperature: 0.2,
    tools: {},
    abortSignal: controller.signal,
    onEngineError: (event: { message: string }) => {
      engineError = { message: event.message };
    },
  } as Parameters<typeof runUnifiedAssistantTurn>[0]);
  if (options.abort) {
    await vi.waitFor(() => expect(modelCalls).toHaveLength(1));
    controller.abort();
  }
  let result: Awaited<typeof pending> | undefined;
  let thrown: unknown;
  try {
    result = await pending;
  } catch (error) {
    // The caller's own failure path: nothing is written back.
    thrown = error;
  }
  if (result) {
    await rt.finalizeUsage(result, engineError ? { engineError } : undefined);
  }
  return { result, thrown, engineError };
}

describe("local-runtime org turn → /stream/org/local-usage", () => {
  it("sends the effective swarm workload before running locally", async () => {
    await runLocalOrgTurn();
    const call = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/stream/org/resolve"),
    );
    const body = JSON.parse(String((call?.[1] as RequestInit).body));
    expect(body.modelWorkload).toEqual({
      purpose: "evalTarget",
      hasTools: true,
      hasUserImages: true,
    });
    expect(body.modelSelection).toEqual(ORG_OLLAMA);
    expect(JSON.stringify(body)).not.toContain("private-image");
  });

  it("never dispatches a local turn when admission refuses its workload", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json(
        { ok: false, code: "capability_missing", error: "tools unsupported" },
        { status: 400 },
      ),
    );
    await expect(runLocalOrgTurn()).rejects.toThrow("tools unsupported");
    expect(modelCalls).toHaveLength(0);
    expect(localUsageBodies()).toHaveLength(0);
  });

  it("ok: the body carries the selection and a closed execution record", async () => {
    await runLocalOrgTurn();
    // The saved temperature reached the provider call.
    expect(modelCalls[0]).toMatchObject({ temperature: 0.2 });

    await vi.waitFor(() => expect(localUsageBodies()).toHaveLength(1));
    const [body] = localUsageBodies();
    expect(body).toMatchObject({
      projectId: `project-${projectSeq}`,
      providerKey: "ollama",
      model: "llama3",
      chatSessionId: "chat-session-1",
      journeyRunId: "journey-run-1",
      sourceType: "swarm",
    });
    expect(body.modelSelection).toEqual(ORG_OLLAMA);
    expect(passesClosedExecutionRecord(body.execution)).toBe(true);
    expect(body.execution).toEqual({
      requested: ORG_OLLAMA,
      resolved: {
        rail: "local",
        wireModelId: "llama3",
        connectionRef: { kind: "orgProvider", id: "orgprov_ollama_local_1" },
        nativeModelId: "llama3",
        offering: {
          rail: "local",
          providerKey: "ollama",
          nativeModelId: "llama3",
        },
      },
      effectiveSettings: { temperature: 0.2, maxOutputTokens: 0 },
      attempts: [
        {
          rail: "local",
          wireModelId: "llama3",
          outcome: "ok",
          at: expect.any(Number),
        },
      ],
    });
    // The key the resolve response handed back never rides the writeback.
    expect(JSON.stringify(body)).not.toContain(RESOLVE_SECRET);
  });

  it("error: the attempt is recorded as an error with a code", async () => {
    modelBehaviour.current = "error";
    const { engineError } = await runLocalOrgTurn();
    expect(engineError?.message).toBeTruthy();

    await vi.waitFor(() => expect(localUsageBodies()).toHaveLength(1));
    const [body] = localUsageBodies();
    expect(passesClosedExecutionRecord(body.execution)).toBe(true);
    expect(body.execution.attempts).toEqual([
      {
        rail: "local",
        wireModelId: "llama3",
        outcome: "error",
        code: "provider_error",
        at: expect.any(Number),
      },
    ]);
  });

  it("abort: the turn posts no writeback (an aborted turn is not billed)", async () => {
    modelBehaviour.current = "hang";
    const { result, thrown } = await runLocalOrgTurn({ abort: true });
    // Either shape of a cancelled turn (flagged, or the abort surfacing).
    expect(result?.aborted === true || thrown !== undefined).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(localUsageBodies()).toHaveLength(0);
  });

  it("abort: the record shape for an aborted attempt passes the closed check", async () => {
    // The shape a writeback of an aborted call carries: the backend's own
    // convention (an error attempt coded `aborted`), through the real
    // `postLocalUsage`.
    const execution = buildLocalExecutionRecord({
      selection: ORG_OLLAMA,
      providerKey: "ollama",
      wireModelId: "llama3",
      effectiveSettings: { temperature: 0.2 },
      outcome: { kind: "aborted" },
      at: 1_700_000_000_000,
    });
    await postLocalUsage({
      projectId: "project-abort",
      providerKey: "ollama",
      model: "llama3",
      evalIterationId: "iter-1",
      modelSelection: ORG_OLLAMA,
      ...(execution ? { execution } : {}),
    });
    const [body] = localUsageBodies();
    expect(body.evalIterationId).toBe("iter-1");
    expect(body.modelSelection).toEqual(ORG_OLLAMA);
    expect(passesClosedExecutionRecord(body.execution)).toBe(true);
    expect(body.execution.attempts).toEqual([
      {
        rail: "local",
        wireModelId: "llama3",
        outcome: "error",
        code: "aborted",
        at: 1_700_000_000_000,
      },
    ]);
  });

  it("a legacy turn (no selection) sends neither field", async () => {
    projectSeq += 1;
    const rt = await resolveTurnRuntime({
      modelDefinition: MODEL,
      projectId: `project-${projectSeq}`,
      sourceType: "swarm",
      chatSessionId: "chat-session-1",
      attribution: { journeyRunId: "journey-run-1" },
    });
    const result = await runUnifiedAssistantTurn({
      runtime: rt.runtime,
      streamSink: "none",
      messages: [{ role: "user", content: "hi" }],
      systemPrompt: "",
      tools: {},
    } as Parameters<typeof runUnifiedAssistantTurn>[0]);
    await rt.finalizeUsage(result);
    await vi.waitFor(() => expect(localUsageBodies()).toHaveLength(1));
    const [body] = localUsageBodies();
    expect(body).not.toHaveProperty("modelSelection");
    expect(body).not.toHaveProperty("execution");
  });

  it("a reasoning effort this connection cannot apply is refused before the turn", async () => {
    projectSeq += 1;
    await expect(
      resolveTurnRuntime({
        modelDefinition: MODEL,
        projectId: `project-${projectSeq}`,
        sourceType: "swarm",
        chatSessionId: "chat-session-1",
        modelSelection: {
          ...ORG_OLLAMA,
          settings: { reasoningEffort: "high" },
        },
        settings: { reasoningEffort: "high" },
      }),
    ).rejects.toMatchObject({
      name: "ModelResolutionRefusalError",
      code: "capability_missing",
    });
  });
});

describe("the closed-shape check itself", () => {
  it("rejects any field outside the shape", () => {
    const record = buildLocalExecutionRecord({
      selection: ORG_OLLAMA,
      providerKey: "ollama",
      wireModelId: "llama3",
      effectiveSettings: {},
      outcome: { kind: "ok" },
      at: 1,
    });
    expect(passesClosedExecutionRecord(record)).toBe(true);
    expect(passesClosedExecutionRecord({ ...record, apiKey: "sk-nope" })).toBe(
      false,
    );
    expect(
      passesClosedExecutionRecord({
        ...record,
        resolved: { ...record!.resolved, apiKey: "sk-nope" },
      }),
    ).toBe(false);
  });

  it("builds nothing without a saved org selection", () => {
    expect(
      buildLocalExecutionRecord({
        selection: undefined,
        providerKey: "ollama",
        wireModelId: "llama3",
        effectiveSettings: {},
        outcome: { kind: "ok" },
        at: 1,
      }),
    ).toBeUndefined();
  });
});

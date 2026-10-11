/**
 * Every provider attempt on an organization's local runtime is authorized by
 * the backend first: each step of a tool loop and each retry, whatever the
 * 60 s runtime cache holds. A turn already running stops at its next attempt
 * once the organization requires its own keys or the connection is turned
 * off, and nothing more reaches the provider.
 *
 * Only `fetch` (the backend) and the provider are faked. The resolver, its
 * cache, and the AI SDK's tool loop and retry are the real ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  generateText,
  jsonSchema,
  RetryError,
  stepCountIs,
  streamText,
  tool,
  type LanguageModel,
} from "ai";

const provider = vi.hoisted(() => ({
  /** One entry per provider call: the key that call ran with. */
  calls: [] as Array<{ apiKey?: string }>,
  /** What each provider call does, in order. */
  script: [] as Array<"tool-call" | "text" | "rate-limited">,
  /** Runs when a call is answered with a retryable rate limit. */
  onRateLimited: undefined as undefined | (() => void),
}));

vi.mock("@mcpjam/sdk/model-factory", async (importOriginal) => {
  const { MockLanguageModelV3, simulateReadableStream } = await import(
    "ai/test"
  );
  const { APICallError } = await import("ai");
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  const toolCall = [
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "lookup",
      input: "{}",
    },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
      usage,
    },
  ];
  const text = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "Done." },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
  ];
  return {
    ...(await importOriginal<object>()),
    buildOrgModelFromResolvedConfig: vi.fn(
      (config: { apiKey?: string }) =>
        new MockLanguageModelV3({
          provider: "ollama",
          modelId: "llama3",
          doGenerate: async () => {
            provider.calls.push({ apiKey: config.apiKey });
            return {
              content: [{ type: "text", text: "Done." }],
              finishReason: { unified: "stop", raw: "stop" },
              usage,
              warnings: [],
            };
          },
          doStream: async () => {
            provider.calls.push({ apiKey: config.apiKey });
            const next = provider.script.shift() ?? "text";
            if (next === "rate-limited") {
              provider.onRateLimited?.();
              throw new APICallError({
                message: "rate limited",
                url: "http://localhost:11434/api/chat",
                requestBodyValues: {},
                statusCode: 429,
                isRetryable: true,
                // Retry at once, so the test does not wait out the backoff.
                responseHeaders: { "retry-after-ms": "0" },
              });
            }
            return {
              stream: simulateReadableStream({
                chunks: (next === "tool-call" ? toolCall : text) as never[],
              }),
            };
          },
        }),
    ),
  };
});

import { buildOrgModelFromResolvedConfig } from "@mcpjam/sdk/model-factory";
import {
  admitEachLocalOrgAttempt,
  localOrgAttemptRefusal,
} from "../local-org-attempt-admission";
import {
  resolveOrgProviderRuntimeForTarget,
  type LocalOrgAttemptRequest,
  type OrgProviderRuntimeLocal,
} from "../org-model-config";
import { ModelResolutionRefusalError } from "../model-resolution-local";

/** The backend's current answer to `/stream/org/resolve`. */
const backend = {
  policyOn: false,
  connectionOff: false,
  unreachable: false,
  apiKey: "key-1",
};
const resolveBodies: Array<Record<string, unknown>> = [];

let projectSeq = 0;
function nextRequest(): LocalOrgAttemptRequest {
  projectSeq += 1;
  return {
    target: { projectId: `project-attempts-${projectSeq}` },
    providerKey: "ollama",
    model: "llama3",
    auth: { bearerToken: "user-token" },
  };
}

/** The model a turn builds from the answer it started with. */
function turnModel(request: LocalOrgAttemptRequest | undefined) {
  return admitEachLocalOrgAttempt(
    buildOrgModelFromResolvedConfig(
      {
        providerKey: "ollama",
        baseUrl: "http://localhost:11434",
        apiKey: "key-from-turn-start",
      },
      "llama3",
    ),
    request,
    "llama3",
  );
}

/** A tool loop the way the chat engine drives it. */
async function runTurn(
  model: LanguageModel,
  onTool: () => void = () => {},
) {
  const toolRuns: string[] = [];
  const result = streamText({
    model,
    prompt: "Look it up.",
    tools: {
      lookup: tool({
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => {
          toolRuns.push("lookup");
          onTool();
          return "found";
        },
      }),
    },
    stopWhen: stepCountIs(5),
    maxRetries: 2,
    onError: () => {},
  });
  let error: unknown;
  let text = "";
  for await (const part of result.fullStream) {
    if (part.type === "error") error = part.error;
    if (part.type === "text-delta") text += part.text;
  }
  return { error, text, toolRuns };
}

beforeEach(() => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://convex.example");
  Object.assign(backend, {
    policyOn: false,
    connectionOff: false,
    unreachable: false,
    apiKey: "key-1",
  });
  resolveBodies.length = 0;
  provider.calls.length = 0;
  provider.script.length = 0;
  provider.onRateLimited = undefined;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (!String(input).endsWith("/stream/org/resolve")) {
      throw new Error(`unexpected request to ${String(input)}`);
    }
    resolveBodies.push(JSON.parse(String(init?.body)));
    if (backend.unreachable) throw new TypeError("fetch failed");
    if (backend.policyOn) {
      return Response.json(
        {
          ok: false,
          code: "org_keys_required",
          error:
            "Local-runtime connections are unavailable while this organization requires its own keys for AI features.",
          isRetryable: false,
          remediation: "choose_org_model",
        },
        { status: 403 },
      );
    }
    if (backend.connectionOff) {
      return Response.json(
        {
          ok: false,
          code: "credential_missing",
          error: "The organization connection this model uses is turned off.",
        },
        { status: 403 },
      );
    }
    return Response.json({
      ok: true,
      runtimeLocation: "local",
      provider: {
        providerKey: "ollama",
        baseUrl: "http://localhost:11434",
        apiKey: backend.apiKey,
      },
    });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("admitEachLocalOrgAttempt", () => {
  it("with the policy off, admits every step and runs each on the config its answer carried", async () => {
    const request = nextRequest();
    provider.script.push("tool-call", "text");

    const { error, text, toolRuns } = await runTurn(turnModel(request), () => {
      // The key is rotated between the two steps.
      backend.apiKey = "key-2";
    });

    expect(error).toBeUndefined();
    expect(text).toBe("Done.");
    expect(toolRuns).toEqual(["lookup"]);
    expect(provider.calls).toEqual([{ apiKey: "key-1" }, { apiKey: "key-2" }]);
    // One admission per attempt, each asking the turn's own question.
    expect(resolveBodies).toEqual([
      { projectId: request.target.projectId, providerKey: "ollama", model: "llama3" },
      { projectId: request.target.projectId, providerKey: "ollama", model: "llama3" },
    ]);
  });

  it.each([
    {
      change: "the organization turns on its own-keys policy",
      apply: () => {
        backend.policyOn = true;
      },
      code: "org_keys_required",
    },
    {
      change: "the connection is turned off",
      apply: () => {
        backend.connectionOff = true;
      },
      code: "credential_missing",
    },
  ])(
    "refuses the next step with no provider call when $change mid-loop",
    async ({ apply, code }) => {
      provider.script.push("tool-call", "text");

      const { error, text, toolRuns } = await runTurn(
        turnModel(nextRequest()),
        apply,
      );

      expect(toolRuns).toEqual(["lookup"]);
      expect(provider.calls).toHaveLength(1);
      expect(resolveBodies).toHaveLength(2);
      expect(text).toBe("");
      expect(localOrgAttemptRefusal(error)?.code).toBe(code);
    },
  );

  it("asks again before a retry, and a refused retry never reaches the provider", async () => {
    provider.script.push("rate-limited", "text");
    provider.onRateLimited = () => {
      backend.policyOn = true;
    };

    const { error } = await runTurn(turnModel(nextRequest()));

    expect(provider.calls).toHaveLength(1);
    expect(resolveBodies).toHaveLength(2);
    expect(RetryError.isInstance(error)).toBe(true);
    expect(localOrgAttemptRefusal(error)?.code).toBe("org_keys_required");
  });

  it("with the policy off, a retry is admitted and runs", async () => {
    provider.script.push("rate-limited", "text");

    const { error, text } = await runTurn(turnModel(nextRequest()));

    expect(error).toBeUndefined();
    expect(text).toBe("Done.");
    expect(provider.calls).toHaveLength(2);
    expect(resolveBodies).toHaveLength(2);
  });

  it("a cached local answer cannot start a turn after the policy is turned on", async () => {
    const request = nextRequest();
    const first = await resolveOrgProviderRuntimeForTarget(
      request.target,
      request.providerKey,
      request.model,
      request.auth,
    );
    expect(first.runtimeLocation).toBe("local");

    backend.policyOn = true;
    // The cache still answers `local` inside its 60 s window...
    const cached = (await resolveOrgProviderRuntimeForTarget(
      request.target,
      request.providerKey,
      request.model,
      request.auth,
    )) as OrgProviderRuntimeLocal;
    expect(cached.runtimeLocation).toBe("local");
    expect(cached.admission).toMatchObject(request);
    expect(resolveBodies).toHaveLength(1);

    // ...but a turn built from it is refused at its first attempt.
    const { error } = await runTurn(turnModel(cached.admission));
    expect(provider.calls).toHaveLength(0);
    expect(localOrgAttemptRefusal(error)?.code).toBe("org_keys_required");
    expect(error).toBeInstanceOf(ModelResolutionRefusalError);

    // The refusal dropped the cached answer: the next turn asks the backend.
    const next = await resolveOrgProviderRuntimeForTarget(
      request.target,
      request.providerKey,
      request.model,
      request.auth,
    ).catch((thrown: unknown) => thrown);
    expect(next).toBeInstanceOf(ModelResolutionRefusalError);
    expect(resolveBodies).toHaveLength(3);
  });

  it("runs nothing when the answer carried no question to ask again", async () => {
    const { error } = await runTurn(turnModel(undefined));

    expect(provider.calls).toHaveLength(0);
    expect(resolveBodies).toHaveLength(0);
    expect((error as Error).message).toContain("nothing was sent");
  });

  it("fails closed when the backend cannot be asked (generate calls too)", async () => {
    backend.unreachable = true;

    const error = await generateText({
      model: turnModel(nextRequest()),
      prompt: "Hello",
      maxRetries: 0,
    }).catch((thrown: unknown) => thrown);

    expect(provider.calls).toHaveLength(0);
    expect(localOrgAttemptRefusal(error)?.code).toBe(
      "ai_key_policy_unavailable",
    );
    expect((error as Error).message).toContain("fetch failed");
  });
});

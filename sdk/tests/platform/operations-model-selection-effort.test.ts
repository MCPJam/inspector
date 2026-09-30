import { describe, expect, it, vi } from "vitest";
import {
  PlatformApiClient,
  PlatformApiError,
  ensureAdhocEnvironmentOperation,
  expandComposeModelChoices,
  sendChatMessageOperation,
  updateClientOperation,
  updateEnvironmentOperation,
  updateEvalSuiteOperation,
} from "../../src/platform/index.js";

/**
 * A saved model selection, and the reasoning effort it carries, through the
 * operations that MCP, the in-app agent and the CLI share.
 *
 * The properties that fail quietly: a `reasoningEffort` shorthand that
 * invents a selection (guessing whose credentials pay) instead of editing the
 * one the target has, a field the schema accepts that `execute` never puts on
 * the wire, and a deployment that predates saved selections answering an
 * opaque validator error instead of a sentence.
 */

const PROJECT = {
  id: "project-1",
  name: "Acme",
  description: null,
  icon: null,
  organizationId: "org-a",
  visibility: null,
  createdAt: 1,
  updatedAt: 1,
};

const SELECTION = {
  modelId: "openai/gpt-5",
  source: "hosted" as const,
  settings: { reasoningEffort: "medium" as const, temperature: 0.4 },
  fallback: { provider: "none" as const, model: "none" as const },
};

type Row = Record<string, unknown>;

/** A tiny router over the Platform API; every write is recorded in `writes`. */
function makeRouter(state: {
  client?: Row;
  environment?: Row;
  suite?: Row;
  capabilities?: Row;
}) {
  const writes: Array<{ method: string; path: string; body: Row }> = [];
  const fetchMock = vi.fn(async (target: unknown, init?: RequestInit) => {
    const url = new URL(String(target));
    const path = url.pathname.replace("/api/v1", "");
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      writes.push({
        method,
        path,
        body: init?.body ? JSON.parse(String(init.body)) : {},
      });
    }
    if (path === "/projects") return Response.json({ items: [PROJECT] });
    if (path === "/projects/project-1/environments/capabilities") {
      return Response.json(
        state.capabilities ?? { modelOverrides: true, modelSelections: true }
      );
    }
    if (/^\/projects\/project-1\/environments\/ensure-adhoc$/.test(path)) {
      return Response.json({
        environment: { id: "env-adhoc", name: null, adhoc: true },
        created: true,
      });
    }
    if (/^\/projects\/project-1\/clients\/[^/]+$/.test(path)) {
      return Response.json({ ...state.client, id: "client-1" });
    }
    if (/^\/projects\/project-1\/environments\/[^/]+$/.test(path)) {
      return Response.json(state.environment);
    }
    if (path === "/projects/project-1/environments") {
      return Response.json({ items: state.environment ? [state.environment] : [] });
    }
    if (path === "/projects/project-1/eval-suites") {
      return Response.json({ items: state.suite ? [state.suite] : [] });
    }
    if (/^\/projects\/project-1\/eval-suites\/[^/]+$/.test(path)) {
      return Response.json(state.suite);
    }
    if (path === "/projects/project-1/hosts" || path === "/projects/project-1/clients") {
      return Response.json({ items: state.client ? [state.client] : [] });
    }
    return Response.json(state.environment ?? state.client ?? state.suite ?? {});
  });
  const client = new PlatformApiClient({
    baseUrl: "https://api.example.com/api/v1",
    getAuth: () => "sk_test_token",
    fetch: fetchMock as unknown as typeof fetch,
  });
  const context = { client, signal: undefined, onScopeResolved: () => {} } as never;
  return { client, context, writes, fetchMock };
}

const CLIENT_ROW = {
  id: "client-1",
  name: "Reasoner",
  configId: "cfg-1",
  config: { modelId: "openai/gpt-5", modelSelection: SELECTION },
  ownerScope: null,
};

const ENV_ROW = {
  id: "env-1",
  projectId: "project-1",
  name: "Staging",
  hostId: "host-1",
  modelId: "openai/gpt-5",
  modelSelection: SELECTION,
  revision: 3,
  archived: false,
  createdAt: 1,
  updatedAt: 2,
};

async function refusal(promise: Promise<unknown>): Promise<PlatformApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PlatformApiError);
    return error as PlatformApiError;
  }
  throw new Error("expected the operation to be refused");
}

describe("send_chat_message reasoningEffort", () => {
  it("reaches the wire and is refused beside a temperature", async () => {
    const { context, fetchMock } = makeRouter({});
    fetchMock.mockResolvedValue(Response.json({ sessionId: "s", turnId: "t" }));
    await sendChatMessageOperation.execute(
      {
        idempotencyKey: "k1",
        message: "hi",
        projectId: undefined,
        sessionId: "s",
        reasoningEffort: "high",
      } as never,
      context
    );
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(body.reasoningEffort).toBe("high");
    expect(body).not.toHaveProperty("temperature");

    const error = await refusal(
      sendChatMessageOperation.execute(
        {
          idempotencyKey: "k2",
          message: "hi",
          sessionId: "s",
          reasoningEffort: "high",
          temperature: 0.2,
        } as never,
        context
      )
    );
    expect(error.message).toMatch(/reasoningEffort.*temperature/);
  });

  it("rejects a level outside the union at the schema", () => {
    expect(() =>
      sendChatMessageOperation.inputSchema.parse({
        idempotencyKey: "k",
        message: "hi",
        reasoningEffort: "turbo",
      })
    ).toThrow();
  });
});

describe("update_client", () => {
  it("edits the effort on the client's EXISTING selection and leaves the rest alone", async () => {
    const { context, writes } = makeRouter({ client: CLIENT_ROW });
    await updateClientOperation.execute(
      {
        project: "Acme",
        client: "Reasoner",
        expectedConfigId: "cfg-1",
        reasoningEffort: "high",
      },
      context
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]!.body.set).toEqual({
      modelSelection: {
        ...SELECTION,
        settings: { reasoningEffort: "high", temperature: 0.4 },
      },
    });
  });

  it("null removes the effort and keeps the other settings", async () => {
    const { context, writes } = makeRouter({ client: CLIENT_ROW });
    await updateClientOperation.execute(
      {
        project: "Acme",
        client: "Reasoner",
        expectedConfigId: "cfg-1",
        reasoningEffort: null,
      },
      context
    );
    expect((writes[0]!.body.set as Row).modelSelection).toEqual({
      ...SELECTION,
      settings: { temperature: 0.4 },
    });
  });

  it("refuses when the client has no selection, naming the field to send", async () => {
    const { context, writes } = makeRouter({
      client: { ...CLIENT_ROW, config: { modelId: "openai/gpt-5" } },
    });
    const error = await refusal(
      updateClientOperation.execute(
        {
          project: "Acme",
          client: "Reasoner",
          expectedConfigId: "cfg-1",
          reasoningEffort: "high",
        },
        context
      )
    );
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.message).toContain("Send `modelSelection`");
    expect(writes).toHaveLength(0);
  });

  it("refuses the shorthand beside a whole selection or a new model", async () => {
    const { context } = makeRouter({ client: CLIENT_ROW });
    const both = await refusal(
      updateClientOperation.execute(
        {
          project: "Acme",
          client: "Reasoner",
          expectedConfigId: "cfg-1",
          reasoningEffort: "high",
          set: { modelSelection: SELECTION },
        },
        context
      )
    );
    expect(both.message).toContain("not both");
    const newModel = await refusal(
      updateClientOperation.execute(
        {
          project: "Acme",
          client: "Reasoner",
          expectedConfigId: "cfg-1",
          reasoningEffort: "high",
          set: { modelId: "openai/gpt-5.1" },
        },
        context
      )
    );
    expect(newModel.message).toContain("new model needs a new selection");
  });

  it("forwards a whole selection through `set` and refuses one for another model", async () => {
    const { context, writes } = makeRouter({ client: CLIENT_ROW });
    await updateClientOperation.execute(
      {
        project: "Acme",
        client: "Reasoner",
        expectedConfigId: "cfg-1",
        set: { modelSelection: SELECTION },
      },
      context
    );
    expect((writes[0]!.body.set as Row).modelSelection).toEqual(SELECTION);
    const mismatch = await refusal(
      updateClientOperation.execute(
        {
          project: "Acme",
          client: "Reasoner",
          expectedConfigId: "cfg-1",
          set: { modelId: "anthropic/claude-sonnet-4.5", modelSelection: SELECTION },
        },
        context
      )
    );
    expect(mismatch.message).toContain("must match");
  });

  it("rejects an unknown key inside a selection (a secret is never carried)", () => {
    const parsed = updateClientOperation.inputSchema.safeParse({
      client: "Reasoner",
      expectedConfigId: "cfg-1",
      set: { modelSelection: { ...SELECTION, apiKey: "sk-secret" } },
    });
    expect(parsed.success).toBe(false);
  });
});

describe("update_project_environment", () => {
  it("edits the effort on the environment's selection", async () => {
    const { context, writes } = makeRouter({ environment: ENV_ROW });
    await updateEnvironmentOperation.execute(
      {
        project: "Acme",
        environment: "env-1",
        expectedRevision: 3,
        reasoningEffort: "low",
      },
      context
    );
    expect(writes[0]!.body).toMatchObject({
      expectedRevision: 3,
      modelSelection: {
        ...SELECTION,
        settings: { reasoningEffort: "low", temperature: 0.4 },
      },
    });
  });

  it("refuses the shorthand when the environment has no selection", async () => {
    const { modelSelection: _drop, ...bare } = ENV_ROW;
    const { context, writes } = makeRouter({ environment: bare });
    const error = await refusal(
      updateEnvironmentOperation.execute(
        {
          project: "Acme",
          environment: "env-1",
          expectedRevision: 3,
          reasoningEffort: "low",
        },
        context
      )
    );
    expect(error.message).toContain("Send `modelSelection`");
    expect(writes).toHaveLength(0);
  });

  it("refuses an effort beside a different model up front, before any write", async () => {
    const { context, writes } = makeRouter({ environment: ENV_ROW });
    const error = await refusal(
      updateEnvironmentOperation.execute(
        {
          project: "Acme",
          environment: "env-1",
          expectedRevision: 3,
          modelId: "anthropic/claude-sonnet-4.5",
          reasoningEffort: "low",
        },
        context
      )
    );
    expect(error.message).toContain("different model than `modelId`");
    expect(writes).toHaveLength(0);
  });

  it("a bare model change drops the selection saved for the old model", async () => {
    const { context, writes } = makeRouter({ environment: ENV_ROW });
    await updateEnvironmentOperation.execute(
      {
        project: "Acme",
        environment: "env-1",
        expectedRevision: 3,
        modelId: "anthropic/claude-sonnet-4.5",
      },
      context
    );
    expect(writes[0]!.body).toMatchObject({
      modelId: "anthropic/claude-sonnet-4.5",
      modelSelection: null,
    });
  });

  it("clearing the model override (modelId: null) clears the saved selection too", async () => {
    const { context, writes } = makeRouter({ environment: ENV_ROW });
    await updateEnvironmentOperation.execute(
      {
        project: "Acme",
        environment: "env-1",
        expectedRevision: 3,
        modelId: null,
      },
      context
    );
    expect(writes[0]!.body).toMatchObject({
      modelId: null,
      modelSelection: null,
    });
  });

  it("refuses to send a selection to a deployment that predates them", async () => {
    const { context, writes } = makeRouter({
      environment: ENV_ROW,
      capabilities: { modelOverrides: true },
    });
    const error = await refusal(
      updateEnvironmentOperation.execute(
        {
          project: "Acme",
          environment: "env-1",
          expectedRevision: 3,
          modelSelection: SELECTION,
        },
        context
      )
    );
    expect(error.message).toContain("does not support saved model selections");
    expect(writes).toHaveLength(0);
  });
});

describe("update_eval_suite executionConfig", () => {
  const SUITE = {
    id: "suite-1",
    name: "Smoke",
    projectId: "project-1",
    executionConfig: {
      model: "openai/gpt-5",
      systemPrompt: "",
      temperature: 0.5,
      modelSelection: SELECTION,
    },
  };

  it("edits the suite selection's effort and never sends the shorthand key", async () => {
    const { context, writes } = makeRouter({ suite: SUITE });
    await updateEvalSuiteOperation.execute(
      { project: "Acme", suite: "suite-1", executionConfig: { reasoningEffort: "high" } },
      context
    );
    const config = writes[0]!.body.executionConfig as Row;
    expect(config).not.toHaveProperty("reasoningEffort");
    expect(config.modelSelection).toEqual({
      ...SELECTION,
      settings: { reasoningEffort: "high", temperature: 0.4 },
    });
  });

  it("refuses the shorthand on a suite with no selection", async () => {
    const { context } = makeRouter({
      suite: { ...SUITE, executionConfig: { model: "openai/gpt-5", systemPrompt: "", temperature: 0.5 } },
    });
    const error = await refusal(
      updateEvalSuiteOperation.execute(
        { project: "Acme", suite: "suite-1", executionConfig: { reasoningEffort: "high" } },
        context
      )
    );
    expect(error.message).toContain("Send `modelSelection`");
  });
});

describe("composed stacks", () => {
  it("a selection is its own model cell and rides on the cell", () => {
    const choices = expandComposeModelChoices({
      models: ["anthropic/claude-sonnet-4.5"],
      modelSelections: [SELECTION],
    });
    expect(choices).toEqual([
      { modelId: "anthropic/claude-sonnet-4.5" },
      { modelId: "openai/gpt-5", selection: SELECTION },
    ]);
  });

  it("trims the selection's model id and compares selections key-order independently", () => {
    const reordered = {
      fallback: SELECTION.fallback,
      settings: {
        temperature: SELECTION.settings.temperature,
        reasoningEffort: SELECTION.settings.reasoningEffort,
      },
      source: SELECTION.source,
      modelId: ` ${SELECTION.modelId} `,
    };
    expect(
      expandComposeModelChoices({ modelSelections: [SELECTION, reordered] })
    ).toEqual([{ modelId: "openai/gpt-5", selection: SELECTION }]);
  });

  it("refuses two different selections for one model (an effort axis is a later phase)", () => {
    expect(() =>
      expandComposeModelChoices({
        modelSelections: [
          SELECTION,
          { ...SELECTION, settings: { reasoningEffort: "high" } },
        ],
      })
    ).toThrow(/one selection per model/);
  });

  it("ensure_adhoc_environment sends the selection and pins its model", async () => {
    const { context, writes } = makeRouter({
      client: { ...CLIENT_ROW, id: "host-1" },
    });
    await ensureAdhocEnvironmentOperation.execute(
      { project: "Acme", host: "host-1", modelSelection: SELECTION },
      context
    );
    expect(writes.at(-1)!.body).toMatchObject({
      hostId: "host-1",
      modelId: "openai/gpt-5",
      modelSelection: SELECTION,
    });
  });
});

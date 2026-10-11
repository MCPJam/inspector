import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const seams = vi.hoisted(() => ({ resume: vi.fn(), cancel: vi.fn() }));
vi.mock("../../../utils/mrtr-hosted-collector.js", async (original) => ({
  ...(await original<
    typeof import("../../../utils/mrtr-hosted-collector.js")
  >()),
  resumeMrtrContinuationLeg: seams.resume,
}));
vi.mock("../../../utils/mrtr-continuation-state.js", async (original) => ({
  ...(await original<
    typeof import("../../../utils/mrtr-continuation-state.js")
  >()),
  cancelContinuation: seams.cancel,
}));
import { createOwnedPluginMrtr } from "../owned-mrtr";
import { pluginFormSources } from "../form-sources";
import { PluginInvocationError } from "../invocation";
afterEach(() => vi.restoreAllMocks());
describe("owned MRTR form source failure after a resuspension", () => {
  it("withdraws the newly parked parent rather than stranding private state without a display", async () => {
    const owner = {
      actorId: "actor",
      projectId: "project",
      workspaceId: "workspace",
      instanceId: "instance",
      generation: 1,
      serverId: "server",
      bindingId: "binding",
      placement: "interactive" as const,
    };
    const authorization = {
      owner,
      origin: "app" as const,
      revision: "revision",
      tool: { name: "tool" },
      enabled: true,
      requiresApproval: false,
      allowedOrigins: ["app" as const],
    };
    seams.cancel.mockResolvedValue({ ok: true, status: "cancelled" });
    seams.resume.mockResolvedValue({
      outcome: "input_required",
      round: 2,
      expiresAt: Date.now() + 10000,
      displays: [
        {
          key: "input",
          mode: "form",
          message: "Choose",
          requestedSchema: { type: "object", properties: {} },
        },
      ],
    });
    vi.spyOn(pluginFormSources, "bind").mockImplementationOnce(() => {
      throw new PluginInvocationError("FORM_SOURCE_LIMIT");
    });
    const service = createOwnedPluginMrtr({
      c: {} as any,
      bearer: "disposable-bearer",
      projectId: "project",
      serverId: "server",
      sourceBinding: { hostId: "host", hostRevision: "host-revision" },
      assertCurrent: async () => {},
      manager: () =>
        ({
          getManagedClient: () => ({}),
          getInitializationInfo: () => ({ protocolVersion: "2026-07-28" }),
          getServerConfig: () => ({ url: "https://disposable.invalid" }),
        } as any),
    });
    await expect(
      service.resume(
        authorization,
        "operation",
        { name: "tool" },
        {
          continuationId: "parent",
          round: 1,
          responsesBlobId: "answer-receipt",
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("FORM_SOURCE_LIMIT");
    expect(seams.cancel).toHaveBeenCalledExactlyOnceWith("disposable-bearer", {
      continuationId: "parent",
      reason: "plugin_form_source_unavailable",
    });
  });
});

it.each(["decline", "cancel", "accept"] as const)(
  "handles %s on a whole form requiring an unavailable upload service",
  async (action) => {
    const owner = {
      actorId: "actor",
      projectId: "project",
      workspaceId: crypto.randomUUID(),
      instanceId: crypto.randomUUID(),
      generation: 1,
      serverId: "server",
      bindingId: "binding",
      placement: "interactive" as const,
    };
    const schema = {
      type: "object",
      properties: {
        file: {
          type: "string",
          format: "uri",
          "x-openai-input": {
            type: "resource",
            options: [],
            userOptions: { kind: "file" },
          },
        },
      },
    };
    const source = pluginFormSources.bind({
      owner,
      hostId: "host",
      hostRevision: "host-revision",
      invocationId: "operation",
      origin: "app",
      revision: "revision",
      toolName: "tool",
      parent: {
        kind: "mrtr",
        id: "parent",
        round: 1,
        inputRequestKey: "input",
      },
      requestedSchema: schema,
      expiresAt: Date.now() + 10000,
    });
    const commit = vi.fn();
    seams.resume.mockImplementationOnce(async (options) => {
      const prepared = await options.prepareLeg(
        {
          method: "tools/call",
          originalParams: { name: "tool" },
          pendingInputRequests: {
            input: {
              method: "elicitation/create",
              params: {
                mode: "form",
                message: "Choose",
                requestedSchema: schema,
              },
            },
          },
        },
        {
          input: {
            action,
            ...(action === "accept"
              ? { content: { file: "file:///ungranted" } }
              : {}),
          },
        },
      );
      prepared.commit();
      commit();
      return { outcome: "completed", result: { content: [] } };
    });
    const service = createOwnedPluginMrtr({
      c: {} as any,
      bearer: "disposable",
      projectId: "project",
      serverId: "server",
      sourceBinding: { hostId: "host", hostRevision: "host-revision" },
      assertCurrent: async () => {},
      manager: () =>
        ({
          getManagedClient: () => ({}),
          getInitializationInfo: () => ({ protocolVersion: "2026-07-28" }),
          getServerConfig: () => ({ url: "https://disposable.invalid" }),
        } as any),
    });
    try {
      const result = service.resume(
        {
          owner,
          origin: "app",
          revision: "revision",
          tool: { name: "tool" },
          enabled: true,
          requiresApproval: false,
          allowedOrigins: ["app"],
        },
        "operation",
        { name: "tool" },
        { continuationId: "parent", round: 1, responsesBlobId: "answer" },
        new AbortController().signal,
      );
      if (action === "accept") {
        await expect(result).rejects.toThrow();
        expect(commit).not.toHaveBeenCalled();
      } else {
        await expect(result).resolves.toEqual({ content: [] });
        expect(commit).toHaveBeenCalledOnce();
      }
    } finally {
      source.release();
    }
  },
);

describe("a pending MRTR form and the client's current Forms toggle", () => {
  const owner = {
    actorId: "actor",
    projectId: "project",
    workspaceId: "workspace",
    instanceId: "instance",
    generation: 1,
    serverId: "server",
    bindingId: "binding",
    placement: "interactive" as const,
  };
  const authorization = {
    owner,
    origin: "app" as const,
    revision: "revision",
    tool: { name: "tool" },
    enabled: true,
    requiresApproval: false,
    allowedOrigins: ["app" as const],
  };
  const schema = {
    type: "object",
    properties: { name: { type: "string" } },
  };
  const parent = {
    kind: "mrtr" as const,
    id: "parent",
    round: 1,
    inputRequestKey: "input",
  };
  function service(forms: { on: boolean }) {
    return createOwnedPluginMrtr({
      c: {} as any,
      bearer: "disposable-bearer",
      projectId: "project",
      serverId: "server",
      sourceBinding: { hostId: "host", hostRevision: "host-revision" },
      assertCurrent: async () => {},
      formsEnabled: () => forms.on,
      manager: () =>
        ({
          getManagedClient: () => ({}),
          getInitializationInfo: () => ({ protocolVersion: "2026-07-28" }),
          getServerConfig: () => ({ url: "https://disposable.invalid" }),
        } as any),
    });
  }
  const resume = (live: ReturnType<typeof service>) =>
    live.resume(
      authorization,
      "operation",
      { name: "tool" },
      { continuationId: "parent", round: 1, responsesBlobId: "answer" },
      new AbortController().signal,
    );
  const leg = (onPrepared?: (responses: unknown) => void) =>
    seams.resume.mockImplementationOnce(async (options) => {
      try {
        const prepared = await options.prepareLeg(
          {
            method: "tools/call",
            originalParams: { name: "tool" },
            pendingInputRequests: {
              input: {
                method: "elicitation/create",
                params: { mode: "form", message: "Name", requestedSchema: schema },
              },
            },
          },
          { input: { action: "accept", content: { name: "bolt" } } },
        );
        prepared.commit();
        // The prepared answer is what the next leg sends to the server.
        onPrepared?.(prepared.responses);
        return { outcome: "completed", result: { content: [] } };
      } catch {
        // The leg helper releases its lease and reports a pre-wire failure.
        return { outcome: "failed", reason: "admission refused" };
      }
    });
  let source: ReturnType<typeof pluginFormSources.bind>;
  beforeEach(() => {
    seams.resume.mockReset();
    seams.cancel.mockReset().mockResolvedValue({ ok: true, status: "cancelled" });
    source = pluginFormSources.bind({
      owner,
      hostId: "host",
      hostRevision: "host-revision",
      invocationId: "operation",
      origin: "app",
      revision: "revision",
      toolName: "tool",
      parent,
      requestedSchema: schema,
      expiresAt: Date.now() + 10000,
    });
  });
  afterEach(() => source.release());

  it("never delivers the answer when Forms is off at submit, ending the form once", async () => {
    await expect(resume(service({ on: false }))).rejects.toMatchObject({
      code: "PLUGIN_FORMS_DISABLED",
      diagnostics: [
        expect.objectContaining({
          code: "PLUGIN_FORMS_DISABLED",
          serverId: "server",
        }),
      ],
    });
    expect(seams.resume).not.toHaveBeenCalled();
    expect(seams.cancel).toHaveBeenCalledExactlyOnceWith("disposable-bearer", {
      continuationId: "parent",
      reason: "plugin_forms_disabled",
    });
    expect(() => pluginFormSources.get(source.token, owner, parent)).toThrow(
      "FORM_SOURCE_UNAVAILABLE",
    );
  });

  it("ends the form when Forms goes off during the leg's admission", async () => {
    const forms = { on: true };
    const live = service(forms);
    const drive = vi.fn();
    seams.resume.mockImplementationOnce(async (options) => {
      forms.on = false;
      try {
        await options.prepareLeg(
          {
            method: "tools/call",
            originalParams: { name: "tool" },
            pendingInputRequests: {},
          },
          {},
        );
        drive();
      } catch {
        return { outcome: "failed", reason: "admission refused" };
      }
      return { outcome: "completed", result: { content: [] } };
    });
    await expect(resume(live)).rejects.toMatchObject({
      code: "PLUGIN_FORMS_DISABLED",
    });
    expect(drive).not.toHaveBeenCalled();
    expect(seams.cancel).toHaveBeenCalledOnce();
  });

  it("delivers the answer when Forms is turned off and on again before submit", async () => {
    const forms = { on: true };
    const live = service(forms);
    forms.on = false;
    forms.on = true;
    const delivered = vi.fn();
    leg(delivered);
    await expect(resume(live)).resolves.toEqual({ content: [] });
    expect(delivered).toHaveBeenCalledExactlyOnceWith({
      input: { action: "accept", content: { name: "bolt" } },
    });
    expect(seams.cancel).not.toHaveBeenCalled();
  });
});
